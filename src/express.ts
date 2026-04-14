/**
 * dual-402/express
 *
 * Express middleware that accepts both x402 and MPP payments on the same route.
 *
 * Under the hood:
 *   - MPP: delegates to mppx (stateless HMAC challenge, Tempo settlement)
 *   - x402: generates PAYMENT-REQUIRED header, verifies via facilitator
 *
 * The two protocols never interact — the middleware just detects which one
 * the client speaks and routes accordingly.
 */

import type { Request, Response, NextFunction, RequestHandler, Express } from "express";
import { Mppx, tempo, discovery as mppxDiscovery } from "mppx/express";

// ── Types ────────────────────────────────────────────────────────────────

export type MppConfig = {
  /** Tempo USDC currency address */
  currency: string;
  /** Wallet address receiving MPP payments */
  recipient: string;
  /** HMAC secret for stateless challenge verification */
  secretKey: string;
};

export type X402Config = {
  /** Wallet address receiving x402 payments (can be different chain than MPP) */
  payTo: string;
  /** Chain identifier: "base", "base-sepolia", "ethereum", etc. */
  network: string;
  /** Facilitator URL for verify + settle (e.g., "https://x402.org/facilitator") */
  facilitatorUrl: string;
  /** Token contract address. Defaults to USDC on the specified network. */
  asset?: string;
};

export type Dual402Config = {
  mpp: MppConfig;
  x402: X402Config;
};

export type ChargeOptions = {
  amount: string;
  description?: string;
};

export type Dual402Instance = {
  /** Create a charge middleware for a specific route */
  charge(options: ChargeOptions): RequestHandler;
  /** Internal mppx instance (for discovery) */
  _mppx: ReturnType<typeof Mppx.create>;
};

// ── Default USDC addresses per network ───────────────────────────────────

const USDC_ADDRESSES: Record<string, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "ethereum-sepolia": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

function defaultUsdcForNetwork(network: string): string {
  const addr = USDC_ADDRESSES[network];
  if (!addr) throw new Error(`No default USDC address for network "${network}". Pass asset explicitly.`);
  return addr;
}

// ── Main factory ─────────────────────────────────────────────────────────

export function createDual402(config: Dual402Config): Dual402Instance {
  // Initialize mppx once — reused across all charge() calls
  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        currency: config.mpp.currency,
        recipient: config.mpp.recipient,
      }),
    ],
    secretKey: config.mpp.secretKey,
  });

  const x402Asset = config.x402.asset ?? defaultUsdcForNetwork(config.x402.network);

  return {
    _mppx: mppx,

    charge(options: ChargeOptions): RequestHandler {
      // MPP charge handler (from mppx)
      const mppCharge = (mppx as any).charge({
        amount: options.amount,
        description: options.description,
      });

      // x402 amount in smallest unit (USDC has 6 decimals)
      const amountRaw = Math.round(parseFloat(options.amount) * 1e6).toString();

      return async (req: Request, res: Response, next: NextFunction) => {
        try {
          // ── Path 1: x402 credential present ──
          const x402Sig = req.headers["payment-signature"] as string | undefined;
          if (x402Sig) {
            const verified = await verifyX402(x402Sig, config.x402.facilitatorUrl);
            if (verified.valid) {
              // Settle asynchronously — don't block the response
              settleX402(x402Sig, config.x402.facilitatorUrl).catch((err) =>
                console.error("x402 settle error:", err)
              );
              return next();
            }
            // Invalid x402 credential — fall through to 402
          }

          // ── Path 2: MPP credential present ──
          const authHeader = req.headers["authorization"] as string | undefined;
          if (authHeader && /^Payment\s/i.test(authHeader)) {
            // Delegate entirely to mppx middleware
            return mppCharge(req, res, next);
          }

          // ── Path 3: No credential — return 402 with BOTH challenges ──

          // Get MPP challenge by running mppx against a synthetic Request
          const syntheticReq = new globalThis.Request(
            `${req.protocol}://${req.hostname}${req.originalUrl}`,
            { method: req.method, headers: req.headers as Record<string, string> }
          );
          const mppResult = await (mppx as any).charge({ amount: options.amount })(syntheticReq);

          res.status(402);

          // MPP challenge → WWW-Authenticate header
          if (mppResult.status === 402) {
            const mppResponse = mppResult.challenge as globalThis.Response;
            const wwwAuth = mppResponse.headers.get("WWW-Authenticate");
            if (wwwAuth) res.setHeader("WWW-Authenticate", wwwAuth);
          }

          // x402 challenge → PAYMENT-REQUIRED header
          const x402Requirements = {
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: config.x402.network,
                maxAmountRequired: amountRaw,
                resource: `${req.protocol}://${req.hostname}${req.originalUrl}`,
                asset: x402Asset,
                payTo: config.x402.payTo,
                description: options.description,
              },
            ],
          };
          res.setHeader(
            "PAYMENT-REQUIRED",
            Buffer.from(JSON.stringify(x402Requirements)).toString("base64")
          );

          res.json({
            error: "Payment Required",
            description: options.description,
            protocols: ["mpp", "x402"],
            amount: options.amount,
            currency: "USDC",
          });
        } catch (err) {
          console.error("dual-402 error:", err);
          next(err);
        }
      };
    },
  };
}

// ── x402 facilitator calls ───────────────────────────────────────────────

async function verifyX402(
  paymentSignature: string,
  facilitatorUrl: string
): Promise<{ valid: boolean }> {
  const payload = JSON.parse(
    Buffer.from(paymentSignature, "base64").toString("utf-8")
  );

  const res = await fetch(`${facilitatorUrl}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });

  if (!res.ok) return { valid: false };
  return res.json() as Promise<{ valid: boolean }>;
}

async function settleX402(
  paymentSignature: string,
  facilitatorUrl: string
): Promise<{ success: boolean; txHash?: string }> {
  const payload = JSON.parse(
    Buffer.from(paymentSignature, "base64").toString("utf-8")
  );

  const res = await fetch(`${facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });

  if (!res.ok) return { success: false };
  return res.json() as Promise<{ success: boolean; txHash?: string }>;
}

// ── Discovery ────────────────────────────────────────────────────────────

export type DiscoveryRoute = {
  method: string;
  path: string;
  handler: RequestHandler;
  summary: string;
};

export type DiscoveryConfig = {
  info?: { title: string; description: string; version: string };
  serviceInfo?: { categories: string[]; docs?: { homepage: string } };
  routes: DiscoveryRoute[];
};

/**
 * Mounts both discovery endpoints:
 *   GET /openapi.json     — OpenAPI spec with MPP payment extensions
 *   GET /.well-known/x402 — Resource list for x402 crawlers
 */
export function dualDiscovery(
  app: Express,
  dual: Dual402Instance,
  config: DiscoveryConfig
): void {
  // MPP discovery via mppx
  mppxDiscovery(app, dual._mppx, {
    info: config.info,
    serviceInfo: config.serviceInfo,
    routes: config.routes,
  });

  // x402 discovery
  app.get("/.well-known/x402", (req: Request, res: Response) => {
    const base = `${req.protocol}://${req.hostname}`;
    res.json({
      version: 1,
      resources: config.routes.map((r) => `${base}${r.path}`),
    });
  });
}
