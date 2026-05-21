/**
 * Migration sketch — MPP-only -> dual402 (x402 + MPP)
 *
 * Drop-in upgrade for an existing `mppx/express` quote API. The route handler
 * is unchanged; only payment setup and discovery move from a single-protocol
 * config to a dual-protocol one.
 *
 *   - `mppx/express`     -> `dual402`
 *   - `Mppx.create()`    -> `createDual402()`  (one factory, both protocol configs)
 *   - `mppx.charge()`    -> `dual.charge()`    (same call signature; both protocols at once)
 *   - `discovery()`      -> `dualDiscovery()`  (mounts /openapi.json AND /.well-known/x402)
 *   - Route handlers:                          (UNCHANGED)
 *
 * New env vars: X402_PAYEE_ADDRESS, X402_NETWORK, X402_FACILITATOR_URL, MPP_TESTNET.
 *
 * Run with the same .env you use for examples/minimal-api.js:
 *
 *   node --env-file=.env examples/migration.js
 *
 * Then:
 *
 *   curl -i "http://localhost:8080/quote?symbol=ETH"
 *   curl    "http://localhost:8080/openapi.json"
 *   curl    "http://localhost:8080/.well-known/x402"
 */

import express from "express";

// --- BEFORE ---
// import { Mppx, tempo, discovery } from "mppx/express";

// --- AFTER ---
import { createDual402, dualDiscovery, paidRoute } from "dual402";

const app = express();
const port = Number.parseInt(process.env.PORT ?? "8080", 10);

app.use(express.json());

// Browser agents need to read the 402 challenge headers from cross-origin
// requests. Same as before, but now we also expose the x402 headers.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Payment-Receipt, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// --- Payment setup ---
//
// BEFORE:
//   const mppx = Mppx.create({
//     methods: [tempo.charge({ currency: USDC_TEMPO, recipient: RECIPIENT })],
//     secretKey: process.env.MPP_SECRET_KEY,
//   });
//
// AFTER:
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
    facilitatorUrl: requiredEnv("X402_FACILITATOR_URL"),
  },
});

// --- Route ---
//
// BEFORE:
//   const chargeQuote = mppx.charge({ amount: "0.02", description: "Quote lookup" });
//   app.get("/quote", chargeQuote, (req, res) => res.json({ ... }));
//
// AFTER: `paidRoute()` keeps charge middleware and discovery metadata together.
const quote = paidRoute(dual, {
  method: "get",
  path: "/quote",
  amount: "0.02",
  paymentDescription: "Quote lookup",
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
    },
    required: ["symbol", "price"],
  },
});

// Route handler — UNCHANGED from the MPP-only version.
app.get(quote.path, quote.handler, (req, res) => {
  const symbol = String(req.query.symbol ?? "").toUpperCase();
  res.json({ symbol, price: 42 });
});

// --- Discovery ---
//
// BEFORE: discovery(app, mppx, { ... })   -> /openapi.json
// AFTER:  dualDiscovery(app, dual, { ... }) -> /openapi.json + /.well-known/x402
dualDiscovery(app, dual, {
  info: {
    title: "Quote API",
    description: "One paid route exposed through both x402 and MPP.",
    version: "1.0.0",
  },
  routes: [quote],
});

app.listen(port, () => {
  console.log(`Quote API listening on http://localhost:${port}`);
});
