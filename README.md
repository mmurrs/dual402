# dual402

dual402 collapses the paid API setup into one route definition. Add a price
and schema to an Express route, and you get monetization plus discoverability:
one `402 Payment Required` with both [x402](https://x402.org) (Base USDC) and
[MPP](https://mpp.dev) (Tempo USDC), plus metadata that scanners, agent
markets, and agent clients can index.

- Monetization: charge pay-per-request USDC without building a billing system.
- Discoverability: publish OpenAPI and `/.well-known/x402` from the same route
  definition.
- Protocol reach: accept both x402 and MPP clients out of the box.
- Express ergonomics: validate first, charge, then run the handler.

## Install

```bash
npm install dual402 express@^5
```

Node 22 or newer is required. `express@^5` is a peer dependency.

## Quickstart: Monetize + Discover

The key helper is `paidRoute()`: it creates the payment middleware and the
discovery metadata together.

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

const facilitatorUrl = requiredEnv("X402_FACILITATOR_URL");
const cdpAuth =
  new URL(facilitatorUrl).host === "api.cdp.coinbase.com"
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
    testnet: process.env.MPP_TESTNET === "true",
  },
  x402: {
    payTo: requiredEnv("X402_PAYEE_ADDRESS"),
    network: requiredEnv("X402_NETWORK"),
    facilitatorUrl,
    ...(process.env.X402_ASSET && { asset: process.env.X402_ASSET }),
    ...(cdpAuth && { cdpAuth }),
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
  responseSchema: {
    type: "object",
    properties: {
      symbol: { type: "string" },
      price: { type: "number" },
    },
    required: ["symbol", "price"],
  },
});

function validateQuote(req, res, next) {
  const symbol = String(req.query.symbol ?? "").trim();
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  req.symbol = symbol.toUpperCase();
  return next();
}

app.get(quote.path, validateQuote, quote.handler, (req, res) => {
  res.json({ symbol: req.symbol, price: 42 });
});

dualDiscovery(app, dual, {
  info: { title: "Quote API", description: "", version: "1.0.0" },
  routes: [quote],
});
```

That is the collapsed flow: `/quote` is monetized, discoverable, and still just
an Express route. Invalid requests stay free, valid unpaid requests receive both
payment challenges, and paid retries continue to the protected handler.

## Example

```bash
cp .env.example .env
npm run build
node --env-file=.env examples/minimal-api.js
```

```bash
curl -i "http://localhost:8080/quote?symbol=ETH"
curl    "http://localhost:8080/openapi.json"
curl    "http://localhost:8080/.well-known/x402"
```

## Config

Start from [.env.example](.env.example). The required values are:

- MPP: `MPP_SECRET_KEY`, `USDC_TEMPO`, `MPP_RECIPIENT`, `MPP_TESTNET`
- x402: `X402_PAYEE_ADDRESS`, `X402_NETWORK`, `X402_FACILITATOR_URL`
- recommended behind proxies: `BASE_URL`

For Base mainnet, use Coinbase's CDP facilitator and credentials:

```env
X402_NETWORK=eip155:8453
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
```

`createDual402()` fails fast for common money-routing mistakes, including Base
mainnet with the public Sepolia facilitator and CDP facilitator usage without
CDP credentials.

## API

- `createDual402(config)` validates shared x402 and MPP configuration.
- `paidRoute(dual, options)` creates route middleware and discovery metadata.
- `dualDiscovery(app, dual, config)` mounts `GET /openapi.json` and
  `GET /.well-known/x402`.
- `dual.charge({ amount, description?, waitForSettle? })` is the lower-level
  middleware factory when you do not need discovery metadata.

For production integration details, hand the packaged agent guide to your
coding agent:

```text
Install dual402, read node_modules/dual402/AGENTS.md, and make my Express API
accept paid requests through both x402 and MPP.
```

## Testing

```bash
npm test
```

## License

MIT
