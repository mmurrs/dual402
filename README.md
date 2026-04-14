# dual-402

Express middleware that accepts **both x402 and MPP** payments on the same route.

One price config. Two protocols. Any agent can pay.

## Why

x402 (Coinbase / Linux Foundation) and MPP (Stripe / Tempo / Paradigm) both use HTTP 402 but speak different headers. Today you pick one. This lets you accept both — so agents with x402 wallets (Base, Solana) and agents with MPP wallets (Tempo) can all hit your API.

## How it works

```
Agent request → Has credential?
                ├── Authorization: Payment ...  → MPP verification (mppx)
                ├── PAYMENT-SIGNATURE: ...      → x402 verification (facilitator)
                └── Neither                     → 402 with BOTH challenges
```

On a 402 response, the server returns:
- `WWW-Authenticate: Payment ...` (for MPP clients)
- `PAYMENT-REQUIRED: base64(...)` (for x402 clients)

The client picks the one it understands. The server doesn't care which.

## Usage

```js
import express from "express";
import { dual402, discovery } from "dual-402/express";

const app = express();

const pay = dual402({
  // Shared
  amount: "0.02",
  description: "Citi Bike station lookup",

  // MPP (Tempo)
  mpp: {
    currency: process.env.USDC_TEMPO,
    recipient: process.env.MPP_RECIPIENT,
    secretKey: process.env.MPP_SECRET_KEY,
  },

  // x402 (Base)
  x402: {
    payTo: process.env.X402_PAYEE_ADDRESS,
    network: "base-sepolia",
    facilitatorUrl: "https://x402.org/facilitator",
  },
});

app.get("/citibike/nearest", pay, async (req, res) => {
  // This handler runs after payment is verified — regardless of protocol
  res.json({ results: [...] });
});

// Auto-mounts /openapi.json AND /.well-known/x402
discovery(app, { pay, routes: [...] });
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full protocol comparison, middleware internals, and migration guide.

## Status

Design phase. Private repo — will open-source after validating on [FindMeA](https://findmea-nyc.vercel.app).

## License

MIT
