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
                X-PAYMENT (v1 legacy)

Receipt:        PAYMENT-RESPONSE header            Payment-Receipt header
                (base64 JSON: txHash + network)    (method-specific receipt)

Verification:   External facilitator               Stateless HMAC + on-chain
                (POST /verify, POST /settle)       (no external service needed)

Discovery:      /.well-known/x402                  /openapi.json (OpenAPI spec)

Chains:         EVM networks via configured facilitator  Tempo (primary)

Spec:           github.com/coinbase/x402           IETF draft + github.com/tempoxyz/mpp-specs
                Linux Foundation (April 2026)
```

### What's identical

- HTTP 402 status code
- Per-route price configuration
- Express middleware pattern
- Fields: amount, recipient, currency, description
- Challenge -> credential -> receipt flow

### What differs

1. **Header names** -- The detection signal. Check which header the client sent.
2. **Challenge serialization** -- x402 is a base64 JSON blob. MPP is RFC 9110 auth-params.
3. **Verification model** -- x402 delegates to a facilitator service. MPP is stateless (HMAC-bound IDs mean the server never stores challenges).
4. **Receipt attachment** -- Different header names, different formats.

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
             SIGNATURE /     Payment ...?
             X-PAYMENT?
                    │               │               │
                    ▼               ▼               ▼
              x402 verify     MPP verify       Intercept res.status(402)
              (facilitator)   (mppx)           → add x402 PAYMENT-REQUIRED
                    │               │           → mppx adds WWW-Authenticate
                    ▼               ▼               ▼
               ✓ next()        ✓ next()        402 response with BOTH headers
               + PAYMENT-
                 RESPONSE
```

### Configuration

Two-step API: factory creates the dual handler, then `.charge()` creates per-route middleware.

```ts
// Step 1: Factory — protocol config (once per app)
type Dual402Config = {
  mpp: {
    currency: string;        // Tempo USDC address
    recipient: string;       // Wallet receiving MPP payments
    secretKey: string;       // HMAC secret for stateless challenge verification
    testnet?: boolean;       // Enable MPP testnet mode
  };
  x402: {
    payTo: string;           // Address receiving x402 payments (can differ from MPP)
    network: string;         // CAIP-2 chain ID: "eip155:84532", "eip155:8453", etc.
    facilitatorUrl: string;  // Facilitator endpoint for verify + settle
    asset?: string;          // Token address (defaults to USDC on the network)
  };
};

const dual = createDual402(config);

// Step 2: Charge — per-route pricing
type ChargeOptions = {
  amount: string;            // e.g., "0.02"
  description?: string;      // e.g., "Citi Bike station lookup"
};

const middleware = dual.charge({ amount: "0.02", description: "..." });
```

Note: `mpp.recipient` and `x402.payTo` CAN be different addresses on different chains.
Amount is shared because the price of your API doesn't change based on how someone pays.

### Middleware internals (Express)

The key insight: instead of building a separate 402 response, we **intercept `res.status(402)`** when mppx generates its challenge. This lets mppx handle both MPP credential verification AND challenge generation, while we layer the x402 `PAYMENT-REQUIRED` header on top.

```ts
import { Mppx, tempo, discovery as mppxDiscovery } from "mppx/express";

const USDC_BY_NETWORK: Record<string, string> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "eip155:8453":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base Mainnet
  "eip155:1":     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
};

export function createDual402(config: Dual402Config): Dual402Instance {
  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        currency: config.mpp.currency,
        recipient: config.mpp.recipient,
        ...(config.mpp.testnet && { testnet: true }),
      }),
    ],
    secretKey: config.mpp.secretKey,
  });

  const x402Asset = config.x402.asset ?? USDC_BY_NETWORK[config.x402.network];
  if (!x402Asset) {
    throw new Error(
      `No default USDC for network "${config.x402.network}". Set x402.asset explicitly.`
    );
  }

  return {
    _mppx: mppx,
    _x402Config: config.x402,
    _x402Asset: x402Asset,

    charge(opts: ChargeOptions): RequestHandler {
      const { amount, description } = opts;
      const mppCharge = mppx.charge({ amount, description });
      const amountRaw = Math.round(parseFloat(amount) * 1e6).toString();

      const handler = async (req: Request, res: Response, next: NextFunction) => {
        try {
          // ── Path 1: x402 credential ──
          // v2 header: PAYMENT-SIGNATURE, v1 legacy: X-PAYMENT
          const x402Sig =
            req.headers["payment-signature"] ?? req.headers["x-payment"];

          if (x402Sig) {
            const verified = await x402Verify(x402Sig, config.x402.facilitatorUrl);
            if (verified.valid) {
              // Settle async — don't block the response
              x402Settle(x402Sig, config.x402.facilitatorUrl).catch((err) =>
                console.error("[dual402] x402 settle error:", err.message)
              );
              // Attach receipt header if we got a tx hash back
              if (verified.txHash) {
                res.setHeader(
                  "PAYMENT-RESPONSE",
                  Buffer.from(
                    JSON.stringify({
                      success: true,
                      txHash: verified.txHash,
                      network: config.x402.network,
                    })
                  ).toString("base64")
                );
              }
              return next();
            }
            console.warn("[dual402] x402 verification failed");
          }

          // ── Path 2 & 3: Delegate to mppx, inject x402 header on 402 ──
          //
          // Strategy: intercept mppx's res.status(402) call to add the
          // x402 PAYMENT-REQUIRED header before the response is sent.
          // This way mppx handles both MPP credentials and challenge
          // generation, and we just layer x402 on top of the 402.

          const resourceUrl = `${req.protocol}://${req.hostname}${req.originalUrl}`;
          const paymentRequired = {
            x402Version: 2,
            accepts: [
              {
                scheme: "exact",
                network: config.x402.network,
                amount: amountRaw,
                asset: x402Asset,
                payTo: config.x402.payTo,
                maxTimeoutSeconds: 300,
                extra: {
                  name: "USD Coin",
                  version: "2",
                  resourceUrl,
                },
              },
            ],
            resource: {
              url: resourceUrl,
              description: description || "",
              mimeType: "application/json",
            },
          };

          // Intercept: when mppx sets status 402, also add x402 header
          const origStatus = res.status.bind(res);
          res.status = (code: number) => {
            if (code === 402) {
              res.setHeader(
                "PAYMENT-REQUIRED",
                Buffer.from(JSON.stringify(paymentRequired)).toString("base64")
              );
            }
            return origStatus(code);
          };

          return mppCharge(req, res, next);
        } catch (err) {
          console.error("[dual402] middleware error:", err);
          next(err);
        }
      };
      // Stash amount for discovery to read
      (handler as any)._dualAmount = amount;
      return handler;
    },
  };
}
```

### x402 verification (facilitator calls)

```ts
async function x402Verify(
  paymentSignature: string,
  facilitatorUrl: string
): Promise<{ valid: boolean; txHash?: string }> {
  try {
    const payload = JSON.parse(
      Buffer.from(paymentSignature, "base64").toString("utf-8")
    );

    const res = await fetch(`${facilitatorUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[dual402] facilitator /verify ${res.status}: ${text}`);
      return { valid: false };
    }

    return await res.json();
  } catch (err) {
    console.error("[dual402] x402 verify error:", err.message);
    return { valid: false };
  }
}

async function x402Settle(
  paymentSignature: string,
  facilitatorUrl: string
): Promise<void> {
  const payload = JSON.parse(
    Buffer.from(paymentSignature, "base64").toString("utf-8")
  );

  const res = await fetch(`${facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`facilitator /settle ${res.status}: ${text}`);
  }

  return res.json();
}
```

### Discovery (unified)

A single `dualDiscovery()` call mounts both:
- `GET /openapi.json` -- OpenAPI spec with MPP payment extensions (what mppx already does)
- `GET /.well-known/x402` -- Resource list for x402 crawlers (v2: objects with url + description)

```ts
export function dualDiscovery(app, dual, config) {
  // mppx discovery needs routes with native mppx charge handlers (for _internal metadata).
  // Re-create mppx charge handlers purely for discovery — they aren't used for actual routing.
  const mppxRoutes = config.routes.map((r) => ({
    ...r,
    handler: dual._mppx.charge({
      amount: r.handler._dualAmount ?? "0.01",
      description: r.summary,
    }),
  }));

  mppxDiscovery(app, dual._mppx, {
    info: config.info,
    serviceInfo: config.serviceInfo,
    routes: mppxRoutes,
  });

  // x402 discovery (resource list with url + description)
  app.get("/.well-known/x402", (req, res) => {
    const base = `${req.protocol}://${req.hostname}`;
    res.json({
      version: 2,
      resources: config.routes.map((r) => ({
        url: `${base}${r.path}`,
        description: r.summary,
      })),
      payTo: dual._x402Config.payTo,
      network: dual._x402Config.network,
      asset: dual._x402Asset,
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
import { createDual402, dualDiscovery } from "dual-402";

const dual = createDual402({
  mpp: {
    currency: process.env.USDC_TEMPO,
    recipient: process.env.MPP_RECIPIENT,
    secretKey: process.env.MPP_SECRET_KEY,
    testnet: process.env.MPP_TESTNET === "true",
  },
  x402: {
    payTo: process.env.X402_PAYEE_ADDRESS,
    network: "eip155:84532",
    facilitatorUrl: "https://x402.org/facilitator",
  },
});

const chargeCitibike = dual.charge({
  amount: "0.02",
  description: "Citi Bike station lookup",
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
MPP_TESTNET=true              # Enable MPP testnet mode

# New (x402)
X402_PAYEE_ADDRESS=0x...      # Your Base wallet
X402_FACILITATOR_URL=https://x402.org/facilitator
X402_NETWORK=eip155:84532     # CAIP-2 format (Base Sepolia)
```

## Open questions

1. **Facilitator selection** -- Coinbase CDP facilitator is free for 1,000 tx/month. Should we default to it, or require explicit config?
2. **Receipt forwarding** -- Should the middleware set both receipt headers on success? Or only the one matching the protocol that was used?
3. **Cross-chain pricing** -- Amount is shared, but gas costs differ. Should the x402 price include a gas-cost buffer?
4. **Session support** -- MPP supports sessions (pre-funded channels with lightweight vouchers). x402 is per-request only. How should sessions work in dual mode?
5. **Compose API** -- mppx already has `compose()` for multiple payment methods. Should dual-402 hook into that, or wrap it?

## Roadmap

1. **v0.1** -- Validate on FindMeA (this repo, private)
2. **v0.2** -- Extract into standalone npm package
3. **v1.0** -- Open-source release with Express + Hono adapters
