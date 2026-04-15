/**
 * dual-402/express
 *
 * Express middleware that accepts both x402 and MPP payments on the same route.
 *
 * x402: Generates PAYMENT-REQUIRED header, verifies via facilitator.
 * MPP:  Delegates to mppx (stateless HMAC challenges, Tempo settlement).
 *
 * No new npm dependencies — x402 side is just HTTP calls to the facilitator.
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
  /** Enable MPP testnet mode */
  testnet?: boolean;
};

export type X402Config = {
  /** Wallet address receiving x402 payments (can be different chain than MPP) */
  payTo: string;
  /** CAIP-2 chain identifier: "eip155:84532", "eip155:8453", "eip155:1", etc. */
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
  charge(options: ChargeOptions): RequestHandler & { _dualAmount?: string };
  /** Internal mppx instance (for discovery) */
  _mppx: ReturnType<typeof Mppx.create>;
  /** Internal x402 config (for discovery) */
  _x402Config: X402Config;
  /** Resolved x402 asset address (for discovery) */
  _x402Asset: string;
};

// ── Default USDC addresses per CAIP-2 network ───────────────────────────

const USDC_BY_NETWORK: Record<string, string> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base Mainnet
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
};

// ── Main factory ─────────────────────────────────────────────────────────

/**
 * Create a dual-402 handler that accepts both x402 and MPP payments.
 *
 * @param config - Protocol-specific config for MPP and x402
 * @returns Dual402Instance with a `.charge()` method for creating per-route middleware
 */
export function createDual402(config: Dual402Config): Dual402Instance {
  // Initialize mppx once — reused across all charge() calls
  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        currency: config.mpp.currency,
        recipient: config.mpp.recipient,
        ...(config.mpp.testnet && { testnet: true }),
      }),
    ],
    secretKey: config.mpp.secretKey,
  });

  const x402Asset = config.x402.asset ?? USDC_BY_NETWORK[config.x402.network];
  if (!x402Asset) {
    throw new Error(
      `No default USDC for network "${config.x402.network}". Set x402.asset explicitly.`
    );
  }

  return {
    _mppx: mppx,
    _x402Config: config.x402,
    _x402Asset: x402Asset,

    /**
     * Returns Express middleware that gates a route behind payment.
     * Accepts both x402 (PAYMENT-SIGNATURE) and MPP (Authorization: Payment).
     *
     * @param opts - { amount: string, description?: string }
     */
    charge(opts: ChargeOptions): RequestHandler & { _dualAmount?: string } {
      const { amount, description } = opts;

      // MPP charge handler — used for both credential verification and challenge generation
      const mppCharge = (mppx as any).charge({ amount, description });

      // x402 amount in smallest unit (USDC = 6 decimals)
      const amountRaw = Math.round(parseFloat(amount) * 1e6).toString();

      const handler = async (req: Request, res: Response, next: NextFunction) => {
        try {
          // ── Path 1: x402 credential ──
          // v2 header: PAYMENT-SIGNATURE, v1 legacy: X-PAYMENT
          const x402Sig =
            (req.headers["payment-signature"] as string | undefined) ??
            (req.headers["x-payment"] as string | undefined);

          if (x402Sig) {
            const verified = await x402Verify(
              x402Sig,
              config.x402.facilitatorUrl
            );
            if (verified.valid) {
              // Settle async — don't block the response
              x402Settle(x402Sig, config.x402.facilitatorUrl).catch((err) =>
                console.error("[dual402] x402 settle error:", err.message)
              );
              // Attach receipt header if we got a tx hash back
              if (verified.txHash) {
                res.setHeader(
                  "PAYMENT-RESPONSE",
                  Buffer.from(
                    JSON.stringify({
                      success: true,
                      txHash: verified.txHash,
                      network: config.x402.network,
                    })
                  ).toString("base64")
                );
              }
              return next();
            }
            // Invalid x402 credential — fall through to 402
            console.warn("[dual402] x402 verification failed");
          }

          // ── Path 2 & 3: Delegate to mppx, inject x402 header on 402 ──
          //
          // Strategy: intercept mppx's res.status(402) call to add the
          // x402 PAYMENT-REQUIRED header before the response is sent.
          // This way mppx handles both MPP credentials and challenge
          // generation, and we just layer x402 on top of the 402.

          const resourceUrl = `${req.protocol}://${req.hostname}${req.originalUrl}`;
          const paymentRequired = {
            x402Version: 2,
            accepts: [
              {
                scheme: "exact",
                network: config.x402.network,
                amount: amountRaw,
                asset: x402Asset,
                payTo: config.x402.payTo,
                maxTimeoutSeconds: 300,
                extra: {
                  name: "USDC",
                  version: "2",
                  resourceUrl,
                },
              },
            ],
            resource: {
              url: resourceUrl,
              description: description || "",
              mimeType: "application/json",
            },
          };

          // Intercept: when mppx sets status 402, also add x402 header
          const origStatus = res.status.bind(res);
          (res as any).status = (code: number) => {
            if (code === 402) {
              res.setHeader(
                "PAYMENT-REQUIRED",
                Buffer.from(JSON.stringify(paymentRequired)).toString("base64")
              );
            }
            return origStatus(code);
          };

          return mppCharge(req, res, next);
        } catch (err) {
          console.error("[dual402] middleware error:", err);
          next(err);
        }
      };

      // Stash amount for discovery to read
      (handler as any)._dualAmount = amount;
      return handler as RequestHandler & { _dualAmount?: string };
    },
  };
}

// ── x402 facilitator HTTP calls ─────────────────────────────────────────

async function x402Verify(
  paymentSignature: string,
  facilitatorUrl: string
): Promise<{ valid: boolean; txHash?: string }> {
  try {
    const payload = JSON.parse(
      Buffer.from(paymentSignature, "base64").toString("utf-8")
    );

    const res = await fetch(`${facilitatorUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[dual402] facilitator /verify ${res.status}: ${text}`);
      return { valid: false };
    }

    return (await res.json()) as { valid: boolean; txHash?: string };
  } catch (err: any) {
    console.error("[dual402] x402 verify error:", err.message);
    return { valid: false };
  }
}

async function x402Settle(
  paymentSignature: string,
  facilitatorUrl: string
): Promise<any> {
  const payload = JSON.parse(
    Buffer.from(paymentSignature, "base64").toString("utf-8")
  );

  const res = await fetch(`${facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`facilitator /settle ${res.status}: ${text}`);
  }

  return res.json();
}

// ── Discovery ────────────────────────────────────────────────────────────

export type DiscoveryRoute = {
  method: string;
  path: string;
  handler: RequestHandler & { _dualAmount?: string };
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
  // mppx discovery needs routes with native mppx charge handlers (for _internal metadata).
  // Re-create mppx charge handlers purely for discovery — they aren't used for actual routing.
  const mppxRoutes = config.routes.map((r) => ({
    ...r,
    handler: (dual._mppx as any).charge({
      amount: (r.handler as any)._dualAmount ?? "0.01",
      description: r.summary,
    }),
  }));

  mppxDiscovery(app, dual._mppx, {
    info: config.info,
    serviceInfo: config.serviceInfo,
    routes: mppxRoutes,
  });

  // x402 discovery (resource list with url + description)
  app.get("/.well-known/x402", (req: Request, res: Response) => {
    const base = `${req.protocol}://${req.hostname}`;
    res.json({
      version: 2,
      resources: config.routes.map((r) => ({
        url: `${base}${r.path}`,
        description: r.summary,
      })),
      payTo: dual._x402Config.payTo,
      network: dual._x402Config.network,
      asset: dual._x402Asset,
    });
  });
}
