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
    description: "One paid route that accepts either x402 or MPP payment.",
    version: "1.0.0",
    "x-guidance":
      "Call GET /quote?symbol=ETH. If you receive 402, pay with either x402 or MPP and retry the same request.",
  },
  serviceInfo: {
    categories: ["finance", "quotes"],
  },
  routes: [quote],
});

function validateQuoteRequest(req, res, next) {
  const symbol = String(req.query.symbol ?? "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  req.symbol = symbol;
  return next();
}

app.get(quote.path, validateQuoteRequest, quote.handler, (req, res) => {
  const symbol = req.symbol;
  res.json({ symbol, price: 42, currency: "USD" });
});

app.listen(port, () => {
  console.log(`Paid Quote API listening on http://localhost:${port}`);
});
