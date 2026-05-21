# dual402 Examples

Standalone examples for the dual x402 + MPP Express middleware.

## Examples

| Example | Description |
| --- | --- |
| [minimal-api.js](./minimal-api.js) | Smallest possible paid API: one `GET /quote` route plus discovery. Best place to start. |

## Running

From the repository root:

```bash
cp .env.example .env
# Fill in MPP_SECRET_KEY, USDC_TEMPO, MPP_RECIPIENT, X402_PAYEE_ADDRESS,
# X402_NETWORK, X402_FACILITATOR_URL.
npm run build
node --env-file=.env examples/minimal-api.js
```

Then inspect the unpaid challenge and discovery documents:

```bash
curl -i "http://localhost:8080/quote?symbol=ETH"
curl    "http://localhost:8080/openapi.json"
curl    "http://localhost:8080/.well-known/x402"
```

A 402 response carries `WWW-Authenticate` (MPP) and `PAYMENT-REQUIRED` (x402)
on the same request. Any compliant client can pay either offer and retry.
