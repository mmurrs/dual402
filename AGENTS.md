# dual402 Agent Guide

dual402 is an Express middleware that gates a route behind both x402 (Base
USDC) and MPP (Tempo USDC) payment challenges at the same time. Use it when
the user wants paid HTTP endpoints that any agent client can pay without first
choosing a 402 protocol.

This guide is the cold-start reference for a coding agent wiring dual402 into a
fresh Express service. Every section below is load-bearing — skipping any of
them produces a broken or insecure deployment.

## Install

```bash
npm install dual402 express@^5
```

`express@^5` is a peer dependency. Node 22 or newer is required.

## Environment

All values shown below are example placeholders. Use them only when the host
app does not already have an equivalent configuration layer.

```env
# MPP / Tempo
MPP_SECRET_KEY=
MPP_RECIPIENT=
MPP_REALM=
MPP_TESTNET=true
USDC_TEMPO=0x20c0000000000000000000000000000000000000
# Tempo mainnet USDC: 0x20c000000000000000000000b9537d11c60e8b50

# x402
X402_PAYEE_ADDRESS=
X402_NETWORK=eip155:84532
X402_FACILITATOR_URL=https://x402.org/facilitator
# Optional — defaults to USDC for X402_NETWORK if unset.
X402_ASSET=

# Required when X402_FACILITATOR_URL host is api.cdp.coinbase.com.
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=

# Public origin behind proxies.
BASE_URL=
```

For Base mainnet, switch every value at once — testnet/mainnet mixes will
fail at startup or at first payment:

```env
MPP_TESTNET=false
USDC_TEMPO=0x20c000000000000000000000b9537d11c60e8b50
X402_NETWORK=eip155:8453
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
```

`USDC_TEMPO` must match `MPP_TESTNET`. CDP-hosted x402 facilitation requires
`CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`.

`CDP_API_KEY_SECRET` accepts the formats CDP issues: a PEM block (begins with
`-----BEGIN`), a 48-byte PKCS#8 DER blob (base64-encoded), or a raw Ed25519
seed (32 or 64 bytes, base64-encoded). dual402 parses any of these via
`parseCdpPrivateKey()` at startup; an unrecognized format throws
`cdp_key_unrecognized: ...` with the byte length in the message.

## Integration Pattern

Use `paidRoute()` whenever possible — it ties the Express middleware and the
OpenAPI metadata together so they cannot drift.

```js
import express from "express";
import { createDual402, dualDiscovery, paidRoute } from "dual402";

const app = express();
app.use(express.json());

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const x402FacilitatorUrl = requiredEnv("X402_FACILITATOR_URL");
const cdpAuth =
  new URL(x402FacilitatorUrl).host === "api.cdp.coinbase.com"
    ? {
        apiKeyId: requiredEnv("CDP_API_KEY_ID"),
        apiKeySecret: requiredEnv("CDP_API_KEY_SECRET"),
      }
    : undefined;

const dual = createDual402({
  mpp: {
    currency: requiredEnv("USDC_TEMPO"),
    recipient: requiredEnv("MPP_RECIPIENT"),
    secretKey: requiredEnv("MPP_SECRET_KEY"),
    realm: process.env.MPP_REALM,
    testnet: process.env.MPP_TESTNET === "true",
  },
  x402: {
    payTo: requiredEnv("X402_PAYEE_ADDRESS"),
    network: requiredEnv("X402_NETWORK"),
    facilitatorUrl: x402FacilitatorUrl,
    ...(process.env.X402_ASSET && { asset: process.env.X402_ASSET }),
    ...(cdpAuth && { cdpAuth }),
  },
});

const quote = paidRoute(dual, {
  method: "get",
  path: "/quote",
  amount: "0.02",
  // Optional. Defaults to `summary`. Used as the human-readable label inside
  // the WWW-Authenticate header — must be printable ASCII (see Guardrails).
  paymentDescription: "Quote lookup",
  operationId: "getQuote",
  summary: "Get a quote",
  parameters: [
    { name: "symbol", in: "query", required: true, schema: { type: "string" } },
  ],
  responseSchema: {
    type: "object",
    properties: {
      symbol: { type: "string" },
      price: { type: "number" },
    },
    required: ["symbol", "price"],
  },
});

function validateQuoteRequest(req, res, next) {
  const symbol = String(req.query.symbol ?? "").trim();
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  req.symbol = symbol.toUpperCase();
  return next();
}

app.get(quote.path, validateQuoteRequest, quote.handler, (req, res) => {
  res.json({ symbol: req.symbol, price: 42 });
});

dualDiscovery(app, dual, {
  info: {
    title: "Paid API",
    description: "Paid routes accept x402 and MPP.",
    version: "1.0.0",
  },
  routes: [quote],
});
```

`paidRoute(dual, { ..., paymentDescription })` is the right place to set the
human-readable label that ends up in the MPP `WWW-Authenticate` header. If
omitted, dual402 reuses `summary`.

## Middleware Ordering

Place validation that should not require payment **before** `route.handler`,
and place protected work **after** it. This keeps invalid requests free and
keeps the paid work reachable only via a verified credential.

```js
const runRoute = paidRoute(dual, {
  method: "post",
  path: "/run",
  amount: "0.10",
  operationId: "runJob",
  summary: "Run a job",
  requestBodySchema: {
    type: "object",
    properties: { jobId: { type: "string" } },
    required: ["jobId"],
  },
});

app.post(runRoute.path, validateRequest, runRoute.handler, runPaidWork);
```

`validateRequest` rejects malformed inputs with `400` before payment is
required. `runRoute.handler` then issues a 402 if no valid credential is
present, or verifies and settles the payment if one is. `runPaidWork` only
runs after settlement.

## CORS

Browser-based agent clients cannot read 402 challenge headers from a
cross-origin response unless the server explicitly exposes them. Without this,
the browser fetch resolves successfully but the agent sees `null` for every
challenge header — and silently fails to retry with payment.

Always expose all four payment headers:

```js
app.use((_req, res, next) => {
  res.setHeader(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Payment-Receipt, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  );
  next();
});
```

If the API is browser-accessible, also handle `Access-Control-Allow-*` and
preflight `OPTIONS` — see [examples/minimal-api.js](./examples/minimal-api.js)
for the complete shape.

## Verify

Boot the app and request a paid route without a credential:

```bash
curl -i "http://localhost:8080/quote?symbol=ETH"
```

The response must be `402 Payment Required` with both:

- `WWW-Authenticate: Payment ...` for MPP
- `PAYMENT-REQUIRED: <base64 JSON>` for x402

If either header is missing, the middleware did not wire up — re-check the
config and ordering above. Discovery should also be live:

```bash
curl "http://localhost:8080/openapi.json"
curl "http://localhost:8080/.well-known/x402"
```

## Guardrails

- **Fail-fast on missing config.** Resolve every required env var with a
  `requiredEnv()` helper that throws at startup. The example above is correct
  for production. Do **not** fall back to `process.env.X402_NETWORK ||
  "eip155:84532"` or `process.env.X402_FACILITATOR_URL ||
  "https://x402.org/facilitator"` — that silently routes mainnet money to a
  testnet facilitator. If a test fixture wants Sepolia defaults, use a
  scoped `.env.test` instead of inline `||` fallbacks in the boot code.
- **Keep merchant wallets separate from payer wallets.** Self-transfers fail
  on common facilitators.
- **Keep `USDC_TEMPO` and `MPP_TESTNET` aligned.** Testnet Tempo USDC with
  `MPP_TESTNET=true`; mainnet Tempo USDC with `MPP_TESTNET=false`. Mixing
  them can boot but fail when clients try to pay.
- **Do not use `https://x402.org/facilitator` for Base mainnet.** It is the
  testnet facilitator. Use Coinbase's CDP facilitator with `cdpAuth`.
  `createDual402()` rejects this combination at startup.
- **Leave x402 USDC metadata as `{ name: "USD Coin", version: "2" }`** unless
  the user explicitly knows they need a different EIP-712 domain.
- **Set `BASE_URL` in production.** When the app runs behind a proxy or a
  custom domain, the request `Host` header is the internal hostname; without
  `BASE_URL`, discovery and challenge `resource` URLs will be wrong.
- **Keep request and response schemas accurate.** Agent clients use the
  OpenAPI spec and the 402 schema hints to retry the same request after
  paying. Inaccurate schemas break the retry loop.
- **Payment descriptions must be printable ASCII (U+0020–U+007E).** Anything
  set as `paymentDescription` (or `description` on `dual.charge()`) is
  serialized into HTTP `WWW-Authenticate` header values, which RFC 9110 limits
  to ASCII. dual402 throws at config time if you pass non-ASCII characters
  (em-dash, smart quotes, etc.). Use plain ASCII or transliterate.

## Public Surface

- `createDual402(config)` — validates config, returns a `Dual402Instance`.
- `dual.charge({ amount, description?, waitForSettle? })` — Express
  middleware for one paid route. Lower level; prefer `paidRoute()`.
- `paidRoute(dual, options)` — Express middleware **plus** OpenAPI metadata
  for one route, in one call.
- `dualDiscovery(app, dual, { info, routes, serviceInfo?, ownershipProofs? })`
  — mounts `GET /openapi.json` and `GET /.well-known/x402`.

All public types — `Dual402Config`, `MppConfig`, `X402Config`, `CdpAuth`,
`ChargeOptions`, `PaidRouteOptions`, `DiscoveryRoute`, `DiscoveryConfig`,
`Dual402Instance`, `JsonSchema` — are exported from the package root.
