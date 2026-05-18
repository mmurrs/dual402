import express from "express";
import { createDual402, dualDiscovery, paidRoute } from "dual402";

const app = express();
const port = Number.parseInt(process.env.PORT ?? "8080", 10);

app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Payment-Receipt, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  );
  next();
});

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

const quote = paidRoute(dual, {
  method: "get",
  path: "/quote",
  amount: "0.02",
  operationId: "getQuote",
  summary: "Get a quote",
  parameters: [
    {
      name: "symbol",
      in: "query",
      required: true,
      schema: { type: "string", minLength: 1 },
      description: "Ticker symbol to price",
    },
  ],
  responseSchema: {
    type: "object",
    properties: {
      symbol: { type: "string" },
      price: { type: "number" },
      currency: { type: "string", const: "USD" },
    },
    required: ["symbol", "price", "currency"],
  },
});

dualDiscovery(app, dual, {
  info: {
    title: "Paid Quote API",
    description: "One paid route exposed through x402 and MPP.",
    version: "1.0.0",
    "x-guidance":
      "Call GET /quote?symbol=ETH. If you receive 402, pay with either x402 or MPP and retry the same request.",
  },
  serviceInfo: {
    categories: ["finance", "quotes"],
  },
  routes: [quote],
});

app.get(quote.path, quote.handler, (req, res) => {
  const symbol = String(req.query.symbol ?? "").toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  res.json({ symbol, price: 42, currency: "USD" });
});

app.listen(port, () => {
  console.log(`Paid Quote API listening on http://localhost:${port}`);
});
