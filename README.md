# dual-402

Express middleware that accepts **both x402 and MPP** payments on the same route.

One config. Two protocols. Any agent can pay.

## Why

x402 (Coinbase / Linux Foundation) and MPP (Stripe / Tempo / Paradigm) both use HTTP 402 but speak different headers. Today you pick one. This lets you accept both — so agents with x402 wallets (Base, Solana) and agents with MPP wallets (Tempo) can all hit your API.

## How it works

```
Agent request → Has credential?
                ├── Authorization: Payment ...  → MPP verification (mppx)
                ├── PAYMENT-SIGNATURE: ...      → x402 verification (facilitator)
                ├── X-PAYMENT: ... (v1 legacy)  → x402 verification (facilitator)
                └── Neither                     → 402 with BOTH challenges
```

On a 402 response, the server returns:
- `WWW-Authenticate: Payment ...` (for MPP clients)
- `PAYMENT-REQUIRED: base64(...)` (for x402 clients)

The client picks the one it understands. The server doesn't care which.

## Usage

```js
import express from "express";
import { createDual402, dualDiscovery } from "dual-402/express";

const app = express();

// Step 1: Create the dual handler (once per app)
const dual = createDual402({
  mpp: {
    currency: process.env.USDC_TEMPO,
    recipient: process.env.MPP_RECIPIENT,
    secretKey: process.env.MPP_SECRET_KEY,
    testnet: process.env.MPP_TESTNET === "true",
  },
  x402: {
    payTo: process.env.X402_PAYEE_ADDRESS,
    network: "eip155:84532",  // CAIP-2 format (Base Sepolia)
    facilitatorUrl: "https://x402.org/facilitator",
  },
});

// Step 2: Create charge middleware per route (amount + description)
const chargeCitibike = dual.charge({
  amount: "0.02",
  description: "Citi Bike station lookup",
});

app.get("/citibike/nearest", chargeCitibike, async (req, res) => {
  // This handler runs after payment is verified — regardless of protocol
  res.json({ results: [...] });
});

// Auto-mounts /openapi.json AND /.well-known/x402
dualDiscovery(app, dual, {
  info: { title: "My API", description: "...", version: "2.1.0" },
  routes: [
    { method: "get", path: "/citibike/nearest", handler: chargeCitibike, summary: "Find nearest stations" },
  ],
});
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full protocol comparison, middleware internals, and migration guide.

## Status

Design phase. Private repo — will open-source after validating on [FindMeA](https://findmea-nyc.vercel.app).

## License

MIT
