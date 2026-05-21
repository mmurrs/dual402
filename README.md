# dual402

One Express middleware. Accepts both [x402](https://x402.org) (Base USDC) and
[MPP](https://mpp.dev) (Tempo USDC) on every paid route. The 402 response
carries both challenges; the server accepts whichever signed credential the
client returns.

[Install](#install) · [Quick Start](#quick-start) · [Examples](#examples) · [Base Mainnet](#base-mainnet) · [Discovery](#discovery) · [Agent Guide](./AGENTS.md) · [Architecture](./ARCHITECTURE.md)

## Install

```bash
npm install dual402 express@^5
```

`express@^5` is a peer dependency. `mppx` is the MPP reference SDK used under
the hood. Node 22 or newer is required.

Starter template with a Dockerfile and one-command deploy:
[mmurrs/dual402-starter](https://github.com/mmurrs/dual402-starter).

## Quick Start

Three pieces: create the middleware, define a paid route, expose discovery.

```js
import express from "express";
import { createDual402, dualDiscovery, paidRoute } from "dual402";

const app = express();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const x402FacilitatorUrl = requiredEnv("X402_FACILITATOR_URL");

const dual = createDual402({
  mpp: {
    currency: requiredEnv("USDC_TEMPO"),
    recipient: requiredEnv("MPP_RECIPIENT"),
    secretKey: requiredEnv("MPP_SECRET_KEY"),
    testnet: process.env.MPP_TESTNET === "true",
  },
  x402: {
    payTo: requiredEnv("X402_PAYEE_ADDRESS"),
    network: requiredEnv("X402_NETWORK"),
    facilitatorUrl: x402FacilitatorUrl,
  },
});

const quote = paidRoute(dual, {
  method: "get",
  path: "/quote",
  amount: "0.02",
  operationId: "getQuote",
  summary: "Get a quote",
  parameters: [
    { name: "symbol", in: "query", required: true, schema: { type: "string" } },
  ],
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
  info: { title: "Example API", description: "", version: "1.0.0" },
  routes: [quote],
});
```

Every valid unauthenticated request to `/quote` now returns 402 with both an
`WWW-Authenticate: Payment ...` (MPP) and a `PAYMENT-REQUIRED` (x402) header.
A client with a credential for either protocol pays and retries.

`paidRoute()` is the recommended entrypoint because it ties Express middleware
and OpenAPI metadata together. For lower-level control, mint middleware directly
with `dual.charge({ amount, description })` — the same shape mppx uses.

## Examples

| Example | Description |
| --- | --- |
| [examples/minimal-api.js](examples/minimal-api.js) | Smallest paid route. Best place to start. |

Run them:

```bash
cp .env.example .env
# Fill in MPP_SECRET_KEY, USDC_TEMPO, MPP_RECIPIENT, X402_PAYEE_ADDRESS,
# X402_NETWORK, X402_FACILITATOR_URL.
npm run build
node --env-file=.env examples/minimal-api.js
```

```bash
curl -i "http://localhost:8080/quote?symbol=ETH"
curl    "http://localhost:8080/openapi.json"
curl    "http://localhost:8080/.well-known/x402"
```

## Base Mainnet

Base mainnet does not work with `https://x402.org/facilitator` — that host is
for Base Sepolia only. Use Coinbase's CDP-hosted facilitator and pass CDP
credentials:

```env
X402_NETWORK=eip155:8453
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
```

```ts
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

`createDual402()` validates this for you: pointing Base mainnet at the public
facilitator throws at startup, and CDP credentials are required when the
facilitator host is `api.cdp.coinbase.com`.

Two practical rules also matter:

- `extra.name` for USDC must resolve to `USD Coin`, not `USDC`. dual402
  defaults `extra` to `{ name: "USD Coin", version: "2" }` for this reason.
- The merchant wallet must differ from the wallet you use to test payments.
  Self-transfers fail on common facilitators.

## Discovery

`dualDiscovery()` mounts both standard endpoints:

- `GET /openapi.json` — full OpenAPI 3.1 spec, with `x-payment-info.offers[]`
  on every paid operation listing both Tempo (MPP) and x402 offers.
- `GET /.well-known/x402` — minimal `{ version: 1, resources: ["GET /quote"] }`
  for x402 crawlers.

Runtime `PAYMENT-REQUIRED` headers carry the same offers plus per-route
request/response schema hints, so agent clients can preserve their inputs on
paid retries.

## Agent Guide

If you want a coding agent to wire dual402 into an existing Express service,
the [agent guide](./AGENTS.md) is written for that workflow. Hand it to the
agent in a single prompt:

```
Install dual402, read node_modules/dual402/AGENTS.md, and add dual402 to my
Express API so paid routes accept both x402 on Base and MPP on Tempo.
```

## Config

All env vars used by the examples and AGENTS.md live in
[.env.example](.env.example).

| Variable | Required for | Notes |
| --- | --- | --- |
| `MPP_SECRET_KEY` | MPP | 32+ random bytes; HMAC-binds challenges. |
| `USDC_TEMPO` | MPP | Tempo USDC contract; differs by testnet vs mainnet. |
| `MPP_RECIPIENT` | MPP | EVM address that receives MPP payments. |
| `MPP_TESTNET` | MPP | `true` for Tempo testnet, `false` for mainnet. |
| `MPP_REALM` | MPP (optional) | Hostname advertised in `WWW-Authenticate`. |
| `X402_PAYEE_ADDRESS` | x402 | EVM address that receives x402 payments. |
| `X402_NETWORK` | x402 | CAIP-2 chain ID. `eip155:8453` mainnet, `eip155:84532` Sepolia. |
| `X402_FACILITATOR_URL` | x402 | Facilitator endpoint for `/verify` + `/settle`. |
| `X402_ASSET` | x402 (optional) | USDC contract; defaults to known USDC for `X402_NETWORK`. |
| `CDP_API_KEY_ID` | x402 on CDP | UUID from `portal.cdp.coinbase.com`. |
| `CDP_API_KEY_SECRET` | x402 on CDP | Base64 Ed25519 key or PEM block. |
| `BASE_URL` | recommended | Public origin advertised in discovery and resource URLs. |
| `X402_FACILITATOR_TIMEOUT_MS` | optional | Facilitator fetch timeout. Default `5000`. |

## Operational Notes

- x402 settlement is blocking by default. Set `waitForSettle: false` only on
  low-value routes where you accept the chance of a settlement failure after
  the response was already sent.
- `PAYMENT-RESPONSE` is forwarded to clients on success; logs mask transaction
  hashes.
- `BASE_URL` should be set in production when the app runs behind a proxy.
  Without it, dual402 falls back to the request's `Host` header.

## Testing

```bash
npm test
```

The smoke suite covers config validation, dual 402 header injection,
route-scoped discovery metadata, the CDP verify/settle wire format, and
fail-closed local payee/amount checks.

## Architecture

[ARCHITECTURE.md](ARCHITECTURE.md) walks through the protocol comparison and
the middleware internals.

## License

MIT.
