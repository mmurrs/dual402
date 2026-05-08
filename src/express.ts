/**
 * dual402/express
 *
 * Public entrypoint for the dual x402 + MPP middleware.
 */

import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { Mppx, tempo } from "mppx/express";

import { parseCdpPrivateKey } from "./internal/cdp.js";
import {
  buildAcceptsEntry,
  buildPaymentRequired,
  extractRequestBodySchema,
  maskHex,
  parametersToSchema,
  patchStatusToInject402,
  resolveBaseUrl,
  sanitizeLogValue,
  toSmallestUnit,
  x402Settle,
  x402Verify,
  type JsonObject,
  type JsonSchema,
} from "./internal/x402.js";

export type { JsonSchema } from "./internal/x402.js";
export { maskHex } from "./internal/x402.js";
export { parseCdpPrivateKey } from "./internal/cdp.js";

/** MPP (Tempo USDC) configuration — passed to {@link createDual402}. */
export type MppConfig = {
  /** Tempo USDC token contract address. Mainnet `0x20C0...E8b50`, testnet `0x20c0...0000`. */
  currency: `0x${string}`;
  /** EVM address that receives MPP payments. Must not equal the payer's wallet. */
  recipient: `0x${string}`;
  /** HMAC key used by mppx to sign/verify payment challenges. 32+ random bytes. */
  secretKey: string;
  /** Hostname advertised in MPP `WWW-Authenticate` challenges. Defaults to the request host; set when behind a proxy. */
  realm?: string;
  /** Use Tempo testnet (chain 42431) instead of mainnet (chain 4217). */
  testnet?: boolean;
};

/** Coinbase Developer Platform credentials for the CDP-hosted x402 facilitator. Required on Base mainnet. */
export type CdpAuth = {
  /** UUID from portal.cdp.coinbase.com (or `organizations/.../apiKeys/...` path). */
  apiKeyId: string;
  /** Base64 Ed25519 key or PEM block. Keep out of logs. */
  apiKeySecret: string;
};

/** x402 (EVM USDC) configuration — passed to {@link createDual402}. */
export type X402Config = {
  /** EVM address that receives x402 payments. Must not equal the payer's wallet. */
  payTo: `0x${string}`;
  /** CAIP-2 chain ID. `eip155:8453` for Base mainnet, `eip155:84532` for Base Sepolia. */
  network: string;
  /** Facilitator `/verify` + `/settle` endpoint. Mainnet: `https://api.cdp.coinbase.com/platform/v2/x402` (needs `cdpAuth`). */
  facilitatorUrl: string;
  /** USDC contract address. Defaults to the known USDC for `network` if unset. */
  asset?: `0x${string}`;
  /** EIP-712 domain for the asset. Defaults to `{ name: "USD Coin", version: "2" }` — do not override unless you know what you're doing. */
  extra?: { name: string; version: string };
  /** Facilitator fetch timeout in ms. Default 5000, override via `X402_FACILITATOR_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** CDP credentials. Required when `facilitatorUrl` is CDP-hosted. */
  cdpAuth?: CdpAuth;
};

/** Full configuration for {@link createDual402}. */
export type Dual402Config = {
  mpp: MppConfig;
  x402: X402Config;
  /**
   * Optional hook called after facilitator-side verify succeeds but before `next()`.
   * Return `false` to reject the payment; useful for replay protection or per-caller policy.
   */
  onVerify?: (
    payload: JsonObject,
    ctx: { route: string; amount: string },
  ) => void | boolean | Promise<void | boolean>;
};

/** Per-route options for {@link Dual402Instance.charge}. */
export type ChargeOptions = {
  /** Price in USDC as a decimal string. E.g. `"0.02"` = 2 cents. */
  amount: string;
  /** Human-readable description. ASCII only — ends up in `WWW-Authenticate` header values. */
  description?: string;
  /** Block on x402 settlement before returning the response. Default is fire-and-forget. */
  waitForSettle?: boolean;
};

/**
 * One paid route, as described to {@link dualDiscovery}. The `handler` must be the same
 * charge middleware passed to `app.get(...)` / `app.post(...)` — the discovery layer reads
 * amount/description metadata off it.
 */
export type DiscoveryRoute = {
  /** HTTP method, lowercase. */
  method: string;
  /** Absolute path starting with `/`. */
  path: string;
  /** Middleware returned by {@link Dual402Instance.charge}. */
  handler: DualChargeHandler;
  /** Short imperative summary for OpenAPI. */
  summary: string;
  /** Unique camelCase operation ID for OpenAPI. */
  operationId: string;
  /** Longer description. */
  description?: string;
  /** OpenAPI tags for grouping. */
  tags?: string[];
  /** Query/path parameters for GET routes. */
  parameters?: Array<{
    name: string;
    in: "query";
    required?: boolean;
    schema: JsonSchema;
    description?: string;
  }>;
  /** Full OpenAPI `requestBody` object. Use `requestBodySchema` for the common `application/json` case. */
  requestBody?: {
    required?: boolean;
    content: {
      [mediaType: string]: {
        schema: JsonSchema;
      };
    };
  };
  /** Shortcut for `application/json` request body. */
  requestBodySchema?: JsonSchema;
  /** Whether the request body is required. Defaults to `true` when `requestBodySchema` is set. */
  requestBodyRequired?: boolean;
  /** JSON Schema for the successful response. Threaded into the 402 challenge as a Bazaar schema hint. */
  responseSchema?: JsonSchema;
};

/** Config for {@link dualDiscovery}. */
export type DiscoveryConfig = {
  /** OpenAPI `info` block. */
  info?: {
    title: string;
    description: string;
    version: string;
    /** Free-form guidance for agent clients — e.g. worked examples, which route to pick when. */
    "x-guidance"?: string;
  };
  /** Additional `info.x-service` metadata (categories, keywords) for aggregator discovery. */
  serviceInfo?: Record<string, unknown>;
  /** Optional array of signed proofs that this service owns the advertised wallets. */
  ownershipProofs?: JsonObject[];
  /** Every paid route the service exposes. */
  routes: DiscoveryRoute[];
};

type DualChargeHandler = RequestHandler & {
  _dualAmount?: string;
  _dualDescription?: string;
  _dualInputSchema?: JsonSchema;
  _dualOutputSchema?: JsonSchema;
  _dualInputSchemasByMethod?: Record<string, JsonSchema>;
  _dualOutputSchemasByMethod?: Record<string, JsonSchema>;
  _dualInputSchemasByRoute?: Record<string, JsonSchema>;
  _dualOutputSchemasByRoute?: Record<string, JsonSchema>;
};

type ResolvedX402Config = Readonly<{
  payTo: `0x${string}`;
  network: string;
  asset: `0x${string}`;
  extra: Readonly<{ name: string; version: string }>;
  facilitatorUrl: string;
  timeoutMs: number;
  cdpAuth: Readonly<CdpAuth> | null;
}>;

/** The object returned by {@link createDual402}. Use `.charge()` to mint per-route middleware. */
export type Dual402Instance = {
  /** Create an Express middleware that accepts both x402 and MPP payments for this route. */
  charge(options: ChargeOptions): DualChargeHandler;
  /** @internal The underlying mppx instance. Prefer the public `charge()` API. */
  _mppx: any;
  /** @internal Resolved x402 config after defaults and validation. */
  _x402Config: ResolvedX402Config;
  /** @internal Resolved USDC contract address. */
  _x402Asset: string;
};

const USDC_BY_NETWORK: Record<string, `0x${string}`> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

const DEFAULT_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    results: { type: "array", items: { type: "object" } },
  },
  required: ["results"],
};

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_FACILITATOR_TIMEOUT_MS = (() => {
  const env = Number.parseInt(process.env.X402_FACILITATOR_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 5_000;
})();

/**
 * Create a dual-protocol payment handler. Validates config, throws on mainnet misconfigurations
 * (self-transfer, wrong facilitator for the network, missing CDP auth on Base mainnet).
 *
 * @example
 * ```js
 * const dual = createDual402({
 *   mpp:  { currency, recipient, secretKey },
 *   x402: { payTo, network: "eip155:8453", facilitatorUrl: CDP_URL, cdpAuth },
 * });
 * const chargeQuote = dual.charge({ amount: "0.02", description: "Quote lookup" });
 * app.get("/quote", chargeQuote, (req, res) => res.json({ price: 42 }));
 * ```
 */
export function createDual402(config: Dual402Config): Dual402Instance {
  assertConfig(config);

  const mppRealm = resolveMppRealm(config);
  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        currency: config.mpp.currency,
        recipient: config.mpp.recipient,
        ...(config.mpp.testnet && { testnet: true }),
      }),
    ],
    secretKey: config.mpp.secretKey,
    ...(mppRealm && { realm: mppRealm }),
  });

  const x402Asset = config.x402.asset ?? USDC_BY_NETWORK[config.x402.network];
  if (!x402Asset) {
    throw new Error(
      `dual402: no default USDC for network "${config.x402.network}". ` +
        `Set x402.asset explicitly or pick one of ${Object.keys(USDC_BY_NETWORK).join(", ")}.`,
    );
  }

  const facilitatorUrl = String(config.x402.facilitatorUrl).replace(/\/+$/, "");
  const timeoutMs =
    Number.isFinite(config.x402.timeoutMs) && Number(config.x402.timeoutMs) > 0
      ? Number(config.x402.timeoutMs)
      : DEFAULT_FACILITATOR_TIMEOUT_MS;
  const extra =
    config.x402.extra && typeof config.x402.extra === "object"
      ? Object.freeze({ ...config.x402.extra })
      : Object.freeze({ name: "USD Coin", version: "2" });

  let cdpAuth: Readonly<CdpAuth> | null = null;
  if (config.x402.cdpAuth) {
    const { apiKeyId, apiKeySecret } = config.x402.cdpAuth;
    if (!apiKeyId) {
      throw new Error(
        "dual402: x402.cdpAuth.apiKeyId is required when cdpAuth is set.",
      );
    }
    if (!apiKeySecret) {
      throw new Error(
        "dual402: x402.cdpAuth.apiKeySecret is required when cdpAuth is set.",
      );
    }
    try {
      parseCdpPrivateKey(apiKeySecret);
    } catch (error) {
      throw new Error(
        `dual402: CDP_API_KEY_SECRET could not be parsed: ${errorMessage(error)}`,
      );
    }
    cdpAuth = Object.freeze({ apiKeyId, apiKeySecret });
  }

  const x402Config: ResolvedX402Config = Object.freeze({
    payTo: config.x402.payTo,
    network: config.x402.network,
    asset: x402Asset,
    extra,
    facilitatorUrl,
    timeoutMs,
    cdpAuth,
  });

  return {
    _mppx: mppx,
    _x402Config: x402Config,
    _x402Asset: x402Asset,

    charge(opts: ChargeOptions): DualChargeHandler {
      const { amount, description, waitForSettle = false } = opts;
      assertChargeAmount(amount);

      const mppCharge = (mppx as any).charge({ amount, description }) as RequestHandler;
      const amountRaw = toSmallestUnit(amount, 6);

      const handler: DualChargeHandler = async (req, res, next) => {
        const route =
          (typeof req.path === "string" && req.path) ||
          String(req.originalUrl || "").split("?")[0] ||
          "/";
        const method = String(req.method || "GET").toUpperCase();
        const routeKey = `${method} ${route}`;
        const inputSchema =
          handler._dualInputSchemasByRoute?.[routeKey] ??
          handler._dualInputSchemasByMethod?.[method] ?? handler._dualInputSchema;
        const outputSchema =
          handler._dualOutputSchemasByRoute?.[routeKey] ??
          handler._dualOutputSchemasByMethod?.[method] ?? handler._dualOutputSchema;

        try {
          const x402Sig = readPaymentSignature(req);
          if (x402Sig) {
            const paymentRequirements = buildAcceptsEntry({
              network: x402Config.network,
              amountRaw,
              asset: x402Config.asset,
              payTo: x402Config.payTo,
              resourceUrl: `${resolveBaseUrl(req)}${route}`,
              description,
              extra: x402Config.extra,
            });

            const verified = await x402Verify(x402Sig, x402Config.facilitatorUrl, {
              amount: amountRaw,
              payTo: x402Config.payTo,
              timeoutMs: x402Config.timeoutMs,
              paymentRequirements,
              cdpAuth: x402Config.cdpAuth,
              onVerify: config.onVerify
                ? (payload: JsonObject) => config.onVerify?.(payload, { route, amount })
                : null,
            });

            if (verified.valid && verified.payload) {
              console.log(
                `[PAY] x402 verified amount=${amount} network=${x402Config.network} route=${route}`,
              );
              const settlePromise = x402Settle(
                verified.payload,
                x402Config.facilitatorUrl,
                x402Config.timeoutMs,
                verified.paymentRequirements ?? paymentRequirements,
                x402Config.cdpAuth,
              );

              if (waitForSettle) {
                try {
                  const result = await settlePromise;
                  applyReceiptHeader(res, x402Config.network, result.txHash);
                  logSettle(amount, route, result.txHash);
                } catch (error) {
                  console.error(
                    `[PAY] x402 settle FAILED amount=${amount} route=${route} err=${errorMessage(error)}`,
                  );
                  attachFallbackPaymentRequired(res, {
                    req,
                    route,
                    network: x402Config.network,
                    amountRaw,
                    asset: x402Config.asset,
                    payTo: x402Config.payTo,
                    description,
                    extra: x402Config.extra,
                    inputSchema,
                    outputSchema,
                  });
                  return res.status(502).json({
                    error: "payment_settle_failed",
                    reason: sanitizeLogValue(errorMessage(error), 200),
                  });
                }
              } else {
                settlePromise
                  .then((result) => logSettle(amount, route, result.txHash))
                  .catch((error) => {
                    console.error(
                      `[PAY] x402 settle FAILED amount=${amount} route=${route} err=${errorMessage(error)}`,
                    );
                  });
                applyReceiptHeader(res, x402Config.network, verified.txHash);
              }

              return next();
            }

            console.warn(
              `[dual402] x402 verify failed reason=${verified.reason ?? "unknown"} route=${route}`,
            );
          }

          patchStatusToInject402(
            res,
            buildPaymentRequired({
              network: x402Config.network,
              amountRaw,
              asset: x402Config.asset,
              payTo: x402Config.payTo,
              resourceUrl: `${resolveBaseUrl(req)}${route}`,
              description,
              extra: x402Config.extra,
              inputSchema,
              outputSchema,
              method,
            }),
          );

          return mppCharge(req, res, (arg?: unknown) => {
            if (arg === undefined) {
              console.log(`[PAY] mpp verified amount=${amount} route=${route}`);
            }
            next(arg as any);
          });
        } catch (error) {
          console.error(`[dual402] handler error route=${route}:`, error);
          next(error as any);
        }
      };

      handler._dualAmount = amount;
      handler._dualDescription = description;
      return handler;
    },
  };
}

/**
 * Mount `GET /openapi.json` and `GET /.well-known/x402` on the Express app. The OpenAPI spec
 * is built from the `routes` you pass; the `/.well-known/x402` fallback advertises the minimal
 * `{ version: 1, resources: [...] }` shape. Runtime `PAYMENT-REQUIRED` headers carry the richer
 * per-route schemas so agent clients can retry with a valid body.
 *
 * Every route's `handler` must be the same middleware you registered on the app — discovery
 * reads amount/description metadata off it.
 */
export function dualDiscovery(
  app: Express,
  dual: Dual402Instance,
  config: DiscoveryConfig,
): void {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of config.routes) {
    if (typeof route.handler?._dualAmount !== "string") {
      throw new Error(
        `dualDiscovery: route ${route.method.toUpperCase()} ${route.path} is missing a dual402 charge handler.`,
      );
    }

    const requestBody =
      route.requestBody ??
      (route.requestBodySchema
        ? {
            required: route.requestBodyRequired ?? true,
            content: {
              "application/json": {
                schema: route.requestBodySchema,
              },
            },
          }
        : undefined);

    const inputSchema =
      extractRequestBodySchema(requestBody) ??
      parametersToSchema(route.parameters);
    const outputSchema = route.responseSchema ?? DEFAULT_RESPONSE_SCHEMA;
    const method = route.method.toUpperCase();

    if (inputSchema) {
      route.handler._dualInputSchema ??= inputSchema;
      route.handler._dualInputSchemasByMethod ??= {};
      route.handler._dualInputSchemasByMethod[method] = inputSchema;
      route.handler._dualInputSchemasByRoute ??= {};
      route.handler._dualInputSchemasByRoute[`${method} ${route.path}`] = inputSchema;
    }
    route.handler._dualOutputSchema ??= outputSchema;
    route.handler._dualOutputSchemasByMethod ??= {};
    route.handler._dualOutputSchemasByMethod[method] = outputSchema;
    route.handler._dualOutputSchemasByRoute ??= {};
    route.handler._dualOutputSchemasByRoute[`${method} ${route.path}`] = outputSchema;

    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      ...(route.description && { description: route.description }),
      tags: route.tags ?? [],
      "x-payment-info": {
        price: {
          mode: "fixed",
          currency: "USD",
          amount: route.handler._dualAmount,
        },
        protocols: [
          { x402: {} },
          { mpp: { method: "tempo", intent: "charge", currency: "USDC" } },
        ],
      },
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: outputSchema,
            },
          },
        },
        402: { description: "Payment Required" },
      },
    };

    if (route.parameters?.length) {
      operation.parameters = route.parameters;
    }
    if (requestBody) {
      operation.requestBody = requestBody;
    }

    paths[route.path] = {
      ...(paths[route.path] ?? {}),
      [route.method]: operation,
    };
  }

  const spec: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: config.info?.title ?? "Dual-402 API",
      version: config.info?.version ?? "1.0.0",
      description: config.info?.description ?? "",
      ...(config.info?.["x-guidance"] && {
        "x-guidance": config.info["x-guidance"],
      }),
    },
    "x-discovery": { ownershipProofs: config.ownershipProofs ?? [] },
    paths,
  };

  if (config.serviceInfo) {
    spec["x-service-info"] = config.serviceInfo;
  }

  app.get("/openapi.json", (req: Request, res: Response) => {
    const baseUrl = resolveBaseUrl(req);
    res.json({
      ...spec,
      ...(baseUrl && { servers: [{ url: baseUrl }] }),
    });
  });

  app.get("/.well-known/x402", (req: Request, res: Response) => {
    const resources = Array.from(
      new Set(config.routes.map((route) => `${route.method.toUpperCase()} ${route.path}`)),
    );
    res.json({ version: 1, resources });
  });
}

function assertConfig(config: Dual402Config): void {
  const missing: string[] = [];
  if (!config?.mpp?.secretKey) missing.push("mpp.secretKey (env MPP_SECRET_KEY)");
  if (!config?.mpp?.currency) missing.push("mpp.currency (env USDC_TEMPO)");
  if (!config?.mpp?.recipient) missing.push("mpp.recipient (env MPP_RECIPIENT)");
  if (!config?.x402?.payTo) missing.push("x402.payTo (env X402_PAYEE_ADDRESS)");
  if (!config?.x402?.network) missing.push("x402.network (env X402_NETWORK)");
  if (!config?.x402?.facilitatorUrl) {
    missing.push("x402.facilitatorUrl (env X402_FACILITATOR_URL)");
  }

  if (missing.length > 0) {
    throw new Error(
      `dual402: missing required config:\n  - ${missing.join("\n  - ")}\n` +
        "Create a .env from your example values before booting.",
    );
  }

  if (!EVM_ADDR_RE.test(config.x402.payTo)) {
    console.warn(
      `[dual402] x402.payTo "${config.x402.payTo}" doesn't look like an EVM address.`,
    );
  }
  if (!EVM_ADDR_RE.test(config.mpp.recipient)) {
    console.warn(
      `[dual402] mpp.recipient "${config.mpp.recipient}" doesn't look like an EVM address.`,
    );
  }
}

function resolveMppRealm(config: Dual402Config): string | undefined {
  const explicit = normalizeRealm(config.mpp.realm || process.env.MPP_REALM);
  if (explicit) return explicit;
  return normalizeRealm(process.env.BASE_URL);
}

function normalizeRealm(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    return new URL(trimmed).host;
  } catch {
    // fall through
  }

  try {
    return new URL(`https://${trimmed}`).host;
  } catch {
    return trimmed.replace(/^\/+|\/+$/g, "");
  }
}

function assertChargeAmount(amount: string): void {
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(
      `dual402.charge: amount must be a decimal string like "0.02" — got ${JSON.stringify(amount)}`,
    );
  }
  if (/^0+(\.0+)?$/.test(amount)) {
    throw new Error(`dual402.charge: amount must be > 0 — got ${JSON.stringify(amount)}.`);
  }
}

function readPaymentSignature(req: Request): string {
  const value = req.headers["payment-signature"] ?? req.headers["x-payment"];
  const header = Array.isArray(value) ? value[0] : value;
  return typeof header === "string" ? header.trim() : "";
}

function applyReceiptHeader(
  res: Response,
  network: string,
  txHash: string | undefined,
): void {
  if (txHash && !res.headersSent) {
    res.setHeader(
      "PAYMENT-RESPONSE",
      Buffer.from(
        JSON.stringify({
          success: true,
          txHash,
          network,
        }),
      ).toString("base64"),
    );
  }
}

function attachFallbackPaymentRequired(
  res: Response,
  args: {
    req: Request;
    route: string;
    network: string;
    amountRaw: string;
    asset: string;
    payTo: string;
    description?: string;
    extra: { name: string; version: string };
    inputSchema?: JsonSchema;
    outputSchema?: JsonSchema;
  },
): void {
  if (res.headersSent) return;
  try {
    res.setHeader(
      "PAYMENT-REQUIRED",
      Buffer.from(
        JSON.stringify(
          buildPaymentRequired({
            network: args.network,
            amountRaw: args.amountRaw,
            asset: args.asset,
            payTo: args.payTo,
            resourceUrl: `${resolveBaseUrl(args.req)}${args.route}`,
            description: args.description,
            extra: args.extra,
            inputSchema: args.inputSchema,
            outputSchema: args.outputSchema,
            method: args.req.method,
          }),
        ),
      ).toString("base64"),
    );
  } catch {
    // best effort
  }
}

function logSettle(amount: string, route: string, txHash?: string): void {
  const suffix = txHash ? ` tx=${maskHex(txHash)}` : "";
  console.log(`[PAY] x402 settled amount=${amount} route=${route}${suffix}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
