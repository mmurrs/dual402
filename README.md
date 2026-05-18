# dual402

One Express middleware. Accepts both x402 (Base USDC) and MPP (Tempo USDC) on every route. One 402 response carries both challenges; the server accepts whichever signed credential comes back.

```bash
npm install dual402
```

Starter template: https://github.com/mmurrs/dual402-starter

Protocol references: [x402.org](https://x402.org) · [mpp.dev](https://mpp.dev).

## Quick prompt

Hand this to your coding agent and it can take it from here:

```
Read github.com/mmurrs/dual402 and add dual x402 + MPP payments to my Express service.
```

## Scope

- x402: EVM-style payee / asset configuration, facilitator-based verify + settle
- MPP: delegated to `mppx` / Tempo
- Discovery: `GET /openapi.json` plus `GET /.well-known/x402`

This package is opinionated toward the production patterns used in `NYCTransitLive-x402`: strict local amount/payee checks, CDP auth support for Base mainnet, minimal static discovery, and challenge metadata that helps AgentCash-style clients retry correctly.

## Quickstart

Three pieces: create the middleware, define a paid route, expose discovery.

```js
import express from "express";
import { createDual402, dualDiscovery, paidRoute } from "dual402";

const app = express();

// 1. One-time setup: explicit payment config, matching mppx/x402 style
const dual = createDual402({
  mpp: {
    currency: process.env.USDC_TEMPO,
    recipient: process.env.MPP_RECIPIENT,
    secretKey: process.env.MPP_SECRET_KEY,
    testnet: process.env.MPP_TESTNET === "true",
  },
  x402: {
    payTo: process.env.X402_PAYEE_ADDRESS,
    network: process.env.X402_NETWORK || "eip155:84532",
    facilitatorUrl: process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
  },
});

// 2. Define the paid route once. The returned object is used for both
// Express middleware and discovery metadata.
const quote = paidRoute(dual, {
  method: "get",
  path: "/quote",
  amount: "0.02",
  operationId: "getQuote",
  summary: "Get a quote",
  parameters: [
    { name: "symbol", in: "query", required: true, schema: { type: "string" } },
  ],
  responseSchema: {
    type: "object",
    properties: { symbol: { type: "string" }, price: { type: "number" } },
    required: ["symbol", "price"],
  },
});

app.get(quote.path, quote.handler, (req, res) => {
  res.json({ symbol: req.query.symbol, price: 42 });
});

// 3. Expose /openapi.json and /.well-known/x402
dualDiscovery(app, dual, {
  info: {
    title: "Example API",
    description: "Paid quote API",
    version: "1.0.0",
  },
  routes: [quote],
});
```

That's the whole surface. Every unauthenticated request gets a 402 with both payment challenges; any compliant client pays and proceeds.

Looking for a runnable project you can deploy? The [starter](https://github.com/mmurrs/dual402-starter) wires this up with a Dockerfile and a one-command EigenCompute deploy.

## Try the Example

```bash
cp .env.example .env
# Fill in MPP_SECRET_KEY, USDC_TEMPO, MPP_RECIPIENT, X402_PAYEE_ADDRESS.
node --env-file=.env examples/minimal-api.js
```

Then inspect the unpaid challenge and discovery document:

```bash
curl -i "http://localhost:8080/quote?symbol=ETH"
curl "http://localhost:8080/openapi.json"
```

## Install

```bash
npm install dual402 express
```

`express` is a peer dependency. `mppx` is the MPP reference implementation used under the hood.

## Base Mainnet

For Base mainnet, do not use `https://x402.org/facilitator`. That host is for Base Sepolia testing. Use Coinbase's CDP facilitator instead:

```env
X402_NETWORK=eip155:8453
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
```

And configure:

```js
x402: {
  payTo: process.env.X402_PAYEE_ADDRESS,
  network: process.env.X402_NETWORK,
  facilitatorUrl: process.env.X402_FACILITATOR_URL,
  cdpAuth: {
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
  },
}
```

Two practical rules matter here:

- `extra.name` for USDC must resolve to `USD Coin`, not `USDC`
- your merchant wallet must differ from the wallet you use to test payments

The middleware defaults USDC's x402 metadata to `{ name: "USD Coin", version: "2" }` for this reason.

## Discovery Notes

`dualDiscovery()` keeps `/.well-known/x402` intentionally minimal:

```json
{ "version": 1, "resources": ["GET /quote"] }
```

`/openapi.json` carries the richer service metadata. Paid operations include the canonical `x-payment-info.offers[]` shape used by MPP discovery, with both Tempo and x402 offers for the same route. Runtime `PAYMENT-REQUIRED` remains authoritative for exact payment terms and also carries Bazaar-style request/response schema hints so clients can preserve inputs on paid retries.

## Standards Alignment

`dual402` keeps the public API close to the two reference libraries:

- MPP/mppx: one server object, one `charge({ amount })` middleware per protected route, and OpenAPI discovery with `x-payment-info.offers[]`.
- x402: route-level payment requirements with `scheme`, `network`, `payTo`, facilitator verify/settle, and a `PAYMENT-REQUIRED` challenge clients can pay and retry.

The helper path is intentionally narrower than either underlying SDK:

```js
const dual = createDual402({
  mpp: { currency, recipient, secretKey },
  x402: { payTo, network, facilitatorUrl },
});
const quote = paidRoute(dual, {
  method: "get",
  path: "/quote",
  amount: "0.02",
  operationId: "getQuote",
  summary: "Get a quote",
});
app.get(quote.path, quote.handler, handler);
dualDiscovery(app, dual, { routes: [quote] });
```

Use `dual.charge()` directly when you want the lower-level mppx-style middleware shape.

## Config

Core values are shown in [.env.example](.env.example).

- `MPP_SECRET_KEY`, `USDC_TEMPO`, `MPP_RECIPIENT` are required for MPP
- `X402_PAYEE_ADDRESS`, `X402_NETWORK`, `X402_FACILITATOR_URL` are required for x402
- `BASE_URL` is recommended when the service sits behind a proxy or custom domain
- `MPP_REALM` lets you override the realm advertised in MPP challenges
- `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` are only needed for CDP-hosted facilitation

## Testing

```bash
npm test
```

The smoke suite covers:

- config validation
- dual 402 header injection
- route-scoped discovery metadata
- CDP verify / settle wire format
- fail-closed local payee checks

## Notes

- x402 settlement is blocking by default; use `waitForSettle: false` only for low-value routes
- `PAYMENT-RESPONSE` is kept for clients, but logs mask transaction hashes
- `BASE_URL` is preferred over whatever internal host the app sees at runtime

## Architecture

[ARCHITECTURE.md](ARCHITECTURE.md) has the longer protocol walkthrough.
