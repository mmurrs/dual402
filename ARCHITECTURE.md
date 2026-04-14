# Architecture

## Protocol Comparison

Both protocols share HTTP 402 but differ at the header level:

```
                x402 (Coinbase)                    MPP (Stripe/Tempo)
                ──────────────                     ──────────────────
Challenge:      PAYMENT-REQUIRED header            WWW-Authenticate: Payment ...
                (base64 JSON blob)                 (RFC 9110 auth-params)

Credential:     PAYMENT-SIGNATURE header           Authorization: Payment base64(JSON)
                (base64 PaymentPayload)

Receipt:        PAYMENT-RESPONSE header            Payment-Receipt header
                (tx hash + settlement)             (method-specific receipt)

Verification:   External facilitator               Stateless HMAC + on-chain
                (POST /verify, POST /settle)       (no external service needed)

Discovery:      /.well-known/x402                  /openapi.json (OpenAPI spec)

Chains:         Base, Solana, Polygon, 15+         Tempo (primary), Solana plugin

Spec:           github.com/coinbase/x402           IETF draft + github.com/tempoxyz/mpp-specs
                Linux Foundation (April 2026)
```

### What's identical

- HTTP 402 status code
- Per-route price configuration
- Express middleware pattern
- Fields: amount, recipient, currency, description
- Challenge → credential → receipt flow

### What differs

1. **Header names** — The detection signal. Check which header the client sent.
2. **Challenge serialization** — x402 is a base64 JSON blob. MPP is RFC 9110 auth-params.
3. **Verification model** — x402 delegates to a facilitator service. MPP is stateless (HMAC-bound IDs mean the server never stores challenges).
4. **Receipt attachment** — Different header names, different formats.

## Middleware Design

### Principle: Protocol detection at the edge, shared business logic inside

The middleware is a thin wrapper that:
1. Detects which protocol the client speaks (by header inspection)
2. Routes to the correct verifier
3. Produces a unified "paid" signal
4. On 402, emits BOTH challenges so any client can pay

### Data flow

```
                         ┌─────────────────────┐
                         │   Incoming Request   │
                         └──────────┬──────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
             Has PAYMENT-    Has Authorization:   Neither
             SIGNATURE?      Payment ...?
                    │               │               │
                    ▼               ▼               ▼
              x402 verify     MPP verify       Generate BOTH
              (facilitator)   (HMAC+chain)     challenges
                    │               │               │
                    ▼               ▼               ▼
               ✓ next()        ✓ next()        402 response:
                                               WWW-Authenticate + PAYMENT-REQUIRED
```

### Configuration

Shared config with protocol-specific extensions:

```ts
type Dual402Config = {
  // Shared — the "what" of the payment
  amount: string;            // e.g., "0.02"
  description?: string;      // e.g., "Citi Bike station lookup"

  // MPP — the "how" for Tempo/MPP clients
  mpp: {
    currency: string;        // Tempo USDC address
    recipient: string;       // Wallet receiving MPP payments
    secretKey: string;       // HMAC secret for stateless challenge verification
  };

  // x402 — the "how" for x402 clients
  x402: {
    payTo: string;           // Address receiving x402 payments (can differ from MPP)
    network: string;         // "base", "base-sepolia", "ethereum", etc.
    facilitatorUrl: string;  // Facilitator endpoint for verify + settle
    asset?: string;          // Token address (defaults to USDC on the network)
  };
};
```

Note: `mpp.recipient` and `x402.payTo` CAN be different addresses on different chains.
Amount is shared because the price of your API doesn't change based on how someone pays.

### Middleware internals (Express)

```ts
import { Mppx, tempo } from "mppx/express";

export function dual402(config: Dual402Config): RequestHandler {
  // --- Set up MPP handler (mppx does the heavy lifting) ---
  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        currency: config.mpp.currency,
        recipient: config.mpp.recipient,
      }),
    ],
    secretKey: config.mpp.secretKey,
  });

  const mppCharge = mppx.charge({
    amount: config.amount,
    description: config.description,
  });

  // --- Build x402 challenge payload ---
  const x402Requirements = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: config.x402.network,
        maxAmountRequired: parseUnits(config.amount, 6).toString(),
        resource: "", // filled per-request
        asset: config.x402.asset ?? defaultUsdcForNetwork(config.x402.network),
        payTo: config.x402.payTo,
        description: config.description,
      },
    ],
  };

  return async (req, res, next) => {
    // 1. Check for x402 credential
    const x402Sig = req.headers["payment-signature"];
    if (x402Sig) {
      const result = await verifyX402(x402Sig, config.x402.facilitatorUrl);
      if (result.valid) {
        // Settle the payment
        await settleX402(x402Sig, config.x402.facilitatorUrl);
        return next();
      }
      // Invalid credential — fall through to 402
    }

    // 2. Check for MPP credential (let mppx handle it)
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Payment ")) {
      // Delegate entirely to mppx
      return mppCharge(req, res, next);
    }

    // 3. No credential — return 402 with BOTH challenges
    //    First, get the MPP challenge by calling mppx with no credential
    const mppReq = new Request(
      `${req.protocol}://${req.hostname}${req.originalUrl}`,
      { method: req.method, headers: req.headers }
    );
    const mppResult = await mppx.charge({ amount: config.amount })(mppReq);

    if (mppResult.status === 402) {
      const mppResponse = mppResult.challenge;
      res.status(402);

      // Copy MPP's WWW-Authenticate header
      const wwwAuth = mppResponse.headers.get("WWW-Authenticate");
      if (wwwAuth) res.setHeader("WWW-Authenticate", wwwAuth);

      // Add x402's PAYMENT-REQUIRED header
      const requirements = {
        ...x402Requirements,
        accepts: x402Requirements.accepts.map((a) => ({
          ...a,
          resource: `${req.protocol}://${req.hostname}${req.originalUrl}`,
        })),
      };
      res.setHeader(
        "PAYMENT-REQUIRED",
        Buffer.from(JSON.stringify(requirements)).toString("base64")
      );

      res.json({
        error: "Payment Required",
        description: config.description,
        protocols: ["mpp", "x402"],
      });
    }
  };
}
```

### x402 verification (facilitator calls)

```ts
async function verifyX402(
  paymentSignature: string,
  facilitatorUrl: string
): Promise<{ valid: boolean }> {
  const payload = JSON.parse(
    Buffer.from(paymentSignature, "base64").toString()
  );

  const res = await fetch(`${facilitatorUrl}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });

  return res.json();
}

async function settleX402(
  paymentSignature: string,
  facilitatorUrl: string
): Promise<{ txHash: string }> {
  const payload = JSON.parse(
    Buffer.from(paymentSignature, "base64").toString()
  );

  const res = await fetch(`${facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });

  return res.json();
}
```

### Discovery (unified)

A single `discovery()` call mounts both:
- `GET /openapi.json` — OpenAPI spec with MPP payment extensions (what mppx already does)
- `GET /.well-known/x402` — Resource list for x402 crawlers

```ts
export function discovery(app, config) {
  // MPP discovery (delegates to mppx's discovery())
  mppxDiscovery(app, mppx, {
    info: config.info,
    routes: config.routes,
  });

  // x402 discovery (resource URL list)
  app.get("/.well-known/x402", (req, res) => {
    const base = `${req.protocol}://${req.hostname}`;
    res.json({
      version: 1,
      resources: config.routes.map((r) => `${base}${r.path}`),
    });
  });
}
```

## Migration: FindMeA server.js

### Before (MPP only)

```js
import { Mppx, tempo, discovery } from "mppx/express";

const mppx = Mppx.create({
  methods: [tempo.charge({ currency: USDC_TEMPO, recipient: RECIPIENT })],
  secretKey: process.env.MPP_SECRET_KEY,
});

const chargeCitibike = mppx.charge({
  amount: "0.02",
  description: "Citi Bike station lookup",
});

app.get("/citibike/nearest", validateLookupQuery, chargeCitibike, handler);
```

### After (x402 + MPP)

```js
import { dual402, discovery } from "dual-402/express";

const chargeCitibike = dual402({
  amount: "0.02",
  description: "Citi Bike station lookup",
  mpp: {
    currency: process.env.USDC_TEMPO,
    recipient: process.env.MPP_RECIPIENT,
    secretKey: process.env.MPP_SECRET_KEY,
  },
  x402: {
    payTo: process.env.X402_PAYEE_ADDRESS,
    network: "base-sepolia",
    facilitatorUrl: "https://x402.org/facilitator",
  },
});

app.get("/citibike/nearest", validateLookupQuery, chargeCitibike, handler);
```

The handler function doesn't change. Discovery auto-mounts both endpoints.

### Env additions for FindMeA

```env
# Existing (MPP)
USDC_TEMPO=0x20c0...
MPP_RECIPIENT=0x742d...
MPP_SECRET_KEY=...

# New (x402)
X402_PAYEE_ADDRESS=0x...      # Your Base wallet
X402_FACILITATOR_URL=https://x402.org/facilitator
X402_NETWORK=base-sepolia     # or "base" for mainnet
```

## Open questions

1. **Facilitator selection** — Coinbase CDP facilitator is free for 1,000 tx/month. Should we default to it, or require explicit config?
2. **Receipt forwarding** — Should the middleware set both receipt headers on success? Or only the one matching the protocol that was used?
3. **Cross-chain pricing** — Amount is shared, but gas costs differ. Should the x402 price include a gas-cost buffer?
4. **Session support** — MPP supports sessions (pre-funded channels with lightweight vouchers). x402 is per-request only. How should sessions work in dual mode?
5. **Compose API** — mppx already has `compose()` for multiple payment methods. Should dual-402 hook into that, or wrap it?

## Roadmap

1. **v0.1** — Validate on FindMeA (this repo, private)
2. **v0.2** — Extract into standalone npm package
3. **v1.0** — Open-source release with Express + Hono adapters
