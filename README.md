# dual402

One Express middleware. Accepts both x402 (Base USDC) and MPP (Tempo USDC) on every route. One 402 response carries both challenges; the server accepts whichever signed credential comes back.

```bash
npm install dual402
```

Starter template: https://github.com/mmurrs/dual402-starter

Protocol references: [x402.org](https://x402.org) · [mpp.dev](https://mpp.dev).

## Scope

- x402: EVM-style payee / asset configuration, facilitator-based verify + settle
- MPP: delegated to `mppx` / Tempo
- Discovery: `GET /openapi.json` plus `GET /.well-known/x402`

This package is opinionated toward the production patterns used in `NYCTransitLive-x402`: strict local amount/payee checks, CDP auth support for Base mainnet, minimal static discovery, and challenge metadata that helps AgentCash-style clients retry correctly.

## Quickstart

Three pieces: create the middleware, attach it to a route, describe the route for discovery.

```js
import express from "express";
import { createDual402, dualDiscovery } from "dual402";

const app = express();

// 1. One-time setup
const dual = createDual402({
  mpp:  { currency, recipient, secretKey },
  x402: { payTo, network, facilitatorUrl },
});

// 2. Attach per-route charge middleware
const chargeQuote = dual.charge({ amount: "0.02", description: "Quote lookup" });
app.get("/quote", chargeQuote, (req, res) => res.json({ price: 42 }));

// 3. Expose /openapi.json and /.well-known/x402
dualDiscovery(app, dual, {
  info: { title: "Example API", version: "1.0.0" },
  routes: [{ method: "get", path: "/quote", handler: chargeQuote }],
});
```

That's the whole surface. Every unauthenticated request gets a 402 with both payment challenges; any compliant client pays and proceeds.

Looking for a runnable project you can deploy? The [starter](https://github.com/mmurrs/dual402-starter) wires this up with a Dockerfile and a one-command EigenCompute deploy.

## Install

```bash
npm install dual402 express mppx
```

`express` is a peer dependency. `mppx` is the MPP reference client used under the hood.

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

Pricing, payee, and route-specific request hints belong in the runtime `PAYMENT-REQUIRED` header, not in static discovery. For POST/JSON routes, `dualDiscovery()` threads request/response schema hints into the challenge so clients can preserve the request body on paid retries.

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

- `waitForSettle: true` makes x402 settlement blocking for that route
- `PAYMENT-RESPONSE` is kept for clients, but logs mask transaction hashes
- `BASE_URL` is preferred over whatever internal host the app sees at runtime

## Architecture

[ARCHITECTURE.md](ARCHITECTURE.md) has the longer protocol walkthrough.
