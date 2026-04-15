/**
 * FindMeA — NYC Transit API
 *
 * Migration sketch: MPP-only -> dual-402 (x402 + MPP)
 *
 * What changed:
 *   - `mppx/express` -> `dual-402/express`
 *   - `Mppx.create()` -> `createDual402()`  (one-time setup with both protocol configs)
 *   - `mppx.charge()` -> `dual.charge()`    (same call signature, adds x402 under the hood)
 *   - `discovery()`   -> `dualDiscovery()`   (mounts /openapi.json AND /.well-known/x402)
 *   - Handler functions: UNCHANGED
 *
 * New env vars: X402_PAYEE_ADDRESS, X402_NETWORK, X402_FACILITATOR_URL, MPP_TESTNET
 */

import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import { createRequire } from "module";

// --- BEFORE ---
// import { Mppx, tempo, discovery } from "mppx/express";

// --- AFTER ---
import { createDual402, dualDiscovery } from "dual-402/express";

const require = createRequire(import.meta.url);
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

// CORS — expose BOTH protocol headers
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    // MPP headers        + x402 headers
    "WWW-Authenticate, Payment-Receipt, PAYMENT-REQUIRED, PAYMENT-RESPONSE"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Payment setup ---
//
// BEFORE: Two separate concepts (Mppx.create + mppx.charge)
// AFTER:  One setup, shared price, protocol-specific config

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
    facilitatorUrl:
      process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
  },
});

// charge() calls look exactly the same — amount + description per route
const chargeCitibike = dual.charge({
  amount: "0.02",
  description: "Citi Bike station lookup",
});

const chargeSubway = dual.charge({
  amount: "0.02",
  description: "Subway arrival lookup",
});

const chargeBus = dual.charge({
  amount: "0.02",
  description: "Bus arrival lookup",
});

// --- Discovery ---
//
// BEFORE: discovery(app, mppx, { ... })  -> only /openapi.json
// AFTER:  dualDiscovery(app, dual, { ... }) -> /openapi.json + /.well-known/x402

dualDiscovery(app, dual, {
  info: {
    title: "FindMeA — NYC Transit API",
    description:
      "Real-time NYC transit for agents. Citi Bike stations, subway arrivals, and bus predictions — $0.02 per lookup via MPP or x402.",
    version: "2.1.0",
  },
  serviceInfo: {
    categories: ["transportation", "transit", "nyc", "citibike", "subway", "bus"],
    docs: { homepage: "https://findmea-nyc.vercel.app" },
  },
  routes: [
    {
      method: "get",
      path: "/citibike/nearest",
      handler: chargeCitibike,
      summary:
        "Find nearest Citi Bike stations with available bikes, e-bike counts, and walking time. Query params: lat (required), lng (required), limit (optional, default 3, max 10).",
    },
    {
      method: "get",
      path: "/citibike/dock",
      handler: chargeCitibike,
      summary:
        "Find nearest Citi Bike stations with available docks for parking. Query params: lat (required), lng (required), limit (optional, default 3, max 10).",
    },
    {
      method: "get",
      path: "/subway/nearest",
      handler: chargeSubway,
      summary:
        "Find nearest subway stations with real-time train arrivals. Returns upcoming trains with ETAs, lines, and direction. Query params: lat (required), lng (required), limit (optional, default 3, max 10).",
    },
    {
      method: "get",
      path: "/bus/nearest",
      handler: chargeBus,
      summary:
        "Find nearest bus stops with real-time arrival predictions. Returns routes, destinations, and ETAs. Query params: lat (required), lng (required), limit (optional, default 3, max 10).",
    },
  ],
});

// --- Route handlers (UNCHANGED from MPP-only version) ---

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseLookupQuery(query) {
  const lat = Number.parseFloat(query.lat);
  const lng = Number.parseFloat(query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    return { error: "lat and lng query params required" };
  if (query.limit === undefined) return { value: { lat, lng, limit: 3 } };
  const limit = Number.parseInt(query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    return { error: "limit must be an integer between 1 and 10" };
  return { value: { lat, lng, limit } };
}

function validateLookupQuery(req, res, next) {
  const parsed = parseLookupQuery(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  req.lookupQuery = parsed.value;
  next();
}

// Routes — only change is chargeCitibike/chargeSubway/chargeBus now dual-protocol
app.get("/citibike/nearest", validateLookupQuery, chargeCitibike, async (req, res) => {
  // ... existing handler, completely unchanged
  res.json({ results: [] }); // placeholder
});

app.get("/citibike/dock", validateLookupQuery, chargeCitibike, async (req, res) => {
  res.json({ results: [] });
});

app.get("/subway/nearest", validateLookupQuery, chargeSubway, async (req, res) => {
  res.json({ results: [] });
});

app.get("/bus/nearest", validateLookupQuery, chargeBus, async (req, res) => {
  res.json({ results: [] });
});

// --- Static routes (unchanged) ---

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`FindMeA NYC Transit API on http://localhost:${PORT}`);
});
