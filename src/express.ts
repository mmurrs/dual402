/**
 * dual402
 *
 * Express middleware that gates a route behind both x402 (Base USDC, via a
 * facilitator) and MPP (Tempo USDC, via mppx) at the same time. One 402
 * response carries both challenges; the server accepts whichever signed
 * credential the client returns.
 *
 * Three public functions:
 *
 * - {@link createDual402} — validate config and mint a {@link Dual402Instance}.
 * - {@link paidRoute}    — Express middleware + OpenAPI metadata for one route.
 * - {@link dualDiscovery} — mount `GET /openapi.json` and `GET /.well-known/x402`.
 *
 * `Dual402Instance.charge()` is the lower-level middleware factory; prefer
 * {@link paidRoute} so the discovery layer can read the same metadata.
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

/** MPP (Tempo USDC) configuration. Passed to {@link createDual402} as `mpp`. */
export type MppConfig = {
  /**
   * Tempo USDC token contract address.
   * - Mainnet: `0x20c000000000000000000000b9537d11c60e8b50`
   * - Testnet: `0x20c0000000000000000000000000000000000000`
   *
   * Must align with `testnet` — mixing them will fail when mppx tries to settle.
   */
  currency: `0x${string}`;
  /** EVM address that receives MPP payments. Must not equal any wallet you use to test paying — self-transfers fail on common facilitators. */
  recipient: `0x${string}`;
  /** HMAC key used by mppx to bind challenges to this server. 32+ random bytes; generate with `openssl rand -hex 32`. */
  secretKey: string;
  /** Hostname advertised in MPP `WWW-Authenticate` challenges. Defaults to the request `Host` header, then `BASE_URL`. Set explicitly when running behind a proxy. */
  realm?: string;
  /** Use Tempo testnet (chain 42431) instead of mainnet (chain 4217). Default `false`. */
  testnet?: boolean;
};

/**
 * Coinbase Developer Platform credentials for the CDP-hosted x402 facilitator.
 * Required when {@link X402Config.facilitatorUrl} resolves to `api.cdp.coinbase.com`,
 * which is the case for Base mainnet.
 */
export type CdpAuth = {
  /** UUID from `portal.cdp.coinbase.com`, or the full `organizations/.../apiKeys/...` path. */
  apiKeyId: string;
  /**
   * The CDP private key. Accepts any of the formats CDP issues:
   * - PEM block (begins with `-----BEGIN`)
   * - 48-byte PKCS#8 DER blob, base64-encoded
   * - Raw Ed25519 seed (32 or 64 bytes), base64-encoded
   *
   * Treated as a secret; never logged.
   */
  apiKeySecret: string;
};

/** x402 (EVM USDC) configuration. Passed to {@link createDual402} as `x402`. */
export type X402Config = {
  /** EVM address that receives x402 payments. Must not equal any wallet you use to test paying. */
  payTo: `0x${string}`;
  /**
   * CAIP-2 chain ID.
   * - Base mainnet: `"eip155:8453"`
   * - Base Sepolia: `"eip155:84532"`
   * - Ethereum mainnet: `"eip155:1"`
   *
   * Anything else needs an explicit `asset` because dual402 only ships the
   * default USDC for the chains above.
   */
  network: string;
  /**
   * Facilitator `/verify` + `/settle` endpoint.
   * - Base mainnet: `"https://api.cdp.coinbase.com/platform/v2/x402"` — requires {@link cdpAuth}.
   * - Base Sepolia: `"https://x402.org/facilitator"`.
   *
   * Pointing Base mainnet at the Sepolia host throws at startup.
   */
  facilitatorUrl: string;
  /** USDC contract address. Defaults to the known USDC for {@link network}; set explicitly to use a different stablecoin. */
  asset?: `0x${string}`;
  /** EIP-712 domain for the asset. Defaults to `{ name: "USD Coin", version: "2" }` — only override if the user explicitly knows the asset's domain differs. */
  extra?: { name: string; version: string };
  /** Facilitator fetch timeout in ms. Default `5000`. Overridable at process scope via the `X402_FACILITATOR_TIMEOUT_MS` env var. */
  timeoutMs?: number;
  /** CDP credentials. Required when {@link facilitatorUrl} host is `api.cdp.coinbase.com`. */
  cdpAuth?: CdpAuth;
};

/** Full configuration for {@link createDual402}. */
export type Dual402Config = {
  mpp: MppConfig;
  x402: X402Config;
  /**
   * Optional hook called after the facilitator's `/verify` succeeds but before
   * `/settle` or `next()`. Return `false` to reject the payment. Useful for
   * replay protection (track payer + nonce) or per-caller policy.
   *
   * The `payload` parameter is the canonicalized x402 payment payload — the
   * same shape sent to the facilitator's `/verify`. It carries the payer
   * (`payload.authorization.from`), the route's resource URL, and the nonce.
   */
  onVerify?: (
    payload: JsonObject,
    ctx: { route: string; amount: string },
  ) => void | boolean | Promise<void | boolean>;
};

/** Per-route options for {@link Dual402Instance.charge}. */
export type ChargeOptions = {
  /** Price in USDC as a decimal string, e.g. `"0.02"` for two cents. Pass a string, not a number, to avoid float drift. */
  amount: string;
  /** Human-readable description shown in the MPP `WWW-Authenticate` header. Printable ASCII only — em-dashes and smart quotes throw at config time. */
  description?: string;
  /** Block on x402 settlement before returning the response. Default `true`. Set `false` only on low-value routes where you accept a settle failure after the response was sent. */
  waitForSettle?: boolean;
};

/** Options for {@link paidRoute}. Combines OpenAPI route metadata with a per-route price. */
export type PaidRouteOptions = Omit<DiscoveryRoute, "handler"> & {
  /** Price in USDC as a decimal string, e.g. `"0.02"` for two cents. Pass a string, not a number, to avoid float drift. */
  amount: string;
  /** Short payment challenge description shown in the MPP `WWW-Authenticate` header. Defaults to `summary`. Printable ASCII only. */
  paymentDescription?: string;
  /** Block on x402 settlement before returning the response. Default `true`. */
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

type ResolvedMppConfig = Readonly<{
  currency: `0x${string}`;
  recipient: `0x${string}`;
  testnet: boolean;
}>;

type ResolvedX402Config = Readonly<{
  payTo: `0x${string}`;
  network: string;
  asset: `0x${string}`;
  extra: Readonly<{ name: string; version: string }>;
  facilitatorUrl: string;
  timeoutMs: number;
  cdpAuth: Readonly<CdpAuth> | null;
}>;

/**
 * The object returned by {@link createDual402}. The only public method is
 * {@link Dual402Instance.charge|charge}, which mints per-route middleware.
 * Most apps should reach for {@link paidRoute} instead so the charge handler
 * and the OpenAPI metadata stay aligned.
 */
export type Dual402Instance = {
  /**
   * Mint Express middleware for one paid route. The same middleware verifies
   * x402 credentials (via the configured facilitator) and MPP credentials
   * (via mppx), and emits a 402 with both challenges when none is present.
   */
  charge(options: ChargeOptions): DualChargeHandler;
  /** @internal The underlying mppx instance. Prefer the public `charge()` API. */
  _mppx: any;
  /** @internal Resolved MPP config after defaults and validation. */
  _mppConfig: ResolvedMppConfig;
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
const HTTP_METHOD_RE = /^[A-Z]+$/;
const OPENAPI_HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);
const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";
const DEFAULT_FACILITATOR_TIMEOUT_MS = (() => {
  const env = Number.parseInt(process.env.X402_FACILITATOR_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 5_000;
})();

/**
 * Define a paid route once. The returned object can be passed straight into
 * `app.get(...)` / `app.post(...)` for Express mounting, and into the `routes`
 * array of {@link dualDiscovery} so the OpenAPI spec stays in sync with the
 * actual middleware.
 *
 * Prefer `paidRoute()` over the lower-level {@link Dual402Instance.charge} when
 * the route should be discoverable.
 *
 * @example
 * ```ts
 * const quote = paidRoute(dual, {
 *   method: "get",
 *   path: "/quote",
 *   amount: "0.02",
 *   operationId: "getQuote",
 *   summary: "Get a quote",
 *   parameters: [
 *     { name: "symbol", in: "query", required: true, schema: { type: "string" } },
 *   ],
 * });
 *
 * app.get(quote.path, quote.handler, (req, res) =>
 *   res.json({ symbol: String(req.query.symbol).toUpperCase(), price: 42 }),
 * );
 *
 * dualDiscovery(app, dual, {
 *   info: { title: "Example", description: "", version: "1.0.0" },
 *   routes: [quote],
 * });
 * ```
 */
export function paidRoute(
  dual: Dual402Instance,
  options: PaidRouteOptions,
): DiscoveryRoute {
  const { amount, paymentDescription, waitForSettle, ...route } = options;
  assertDiscoveryRoute(route);
  return {
    ...route,
    handler: dual.charge({
      amount,
      description: paymentDescription ?? route.summary,
      waitForSettle,
    }),
  };
}

/**
 * Validate the dual402 config and return an instance. Fails fast at startup for
 * misconfigurations that would cost money in production: pointing Base mainnet
 * at a testnet facilitator, missing CDP credentials when the facilitator host
 * is `api.cdp.coinbase.com`, an unparseable `CDP_API_KEY_SECRET`, an unknown
 * USDC for `x402.network`, or an MPP secret shorter than 32 characters.
 *
 * @example
 * ```ts
 * const dual = createDual402({
 *   mpp: {
 *     currency: process.env.USDC_TEMPO,
 *     recipient: process.env.MPP_RECIPIENT,
 *     secretKey: process.env.MPP_SECRET_KEY,
 *   },
 *   x402: {
 *     payTo: process.env.X402_PAYEE_ADDRESS,
 *     network: "eip155:8453",
 *     facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
 *     cdpAuth: {
 *       apiKeyId: process.env.CDP_API_KEY_ID,
 *       apiKeySecret: process.env.CDP_API_KEY_SECRET,
 *     },
 *   },
 * });
 *
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
      `dual402: no default USDC known for x402.network "${config.x402.network}". ` +
        `Set x402.asset (env X402_ASSET) explicitly, or use one of ${Object.keys(USDC_BY_NETWORK).join(", ")}.`,
    );
  }

  const facilitatorUrl = normalizeFacilitatorUrl(config.x402.facilitatorUrl);
  const facilitatorUrlHost = facilitatorHost(facilitatorUrl);
  if (config.x402.network === "eip155:8453" && facilitatorUrlHost !== CDP_FACILITATOR_HOST) {
    throw new Error(
      `dual402: Base mainnet (x402.network=${config.x402.network}) requires Coinbase's CDP facilitator at ${CDP_FACILITATOR_HOST}, ` +
        `got x402.facilitatorUrl=${JSON.stringify(facilitatorUrl)}. ` +
        "Set X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402 and provide CDP_API_KEY_ID + CDP_API_KEY_SECRET.",
    );
  }
  if (facilitatorUrlHost === CDP_FACILITATOR_HOST && !config.x402.cdpAuth) {
    throw new Error(
      `dual402: x402.cdpAuth is required when x402.facilitatorUrl host is ${CDP_FACILITATOR_HOST}. ` +
        "Set CDP_API_KEY_ID and CDP_API_KEY_SECRET, then pass them as { apiKeyId, apiKeySecret }.",
    );
  }
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
        "dual402: x402.cdpAuth.apiKeyId (env CDP_API_KEY_ID) is required when cdpAuth is set.",
      );
    }
    if (!apiKeySecret) {
      throw new Error(
        "dual402: x402.cdpAuth.apiKeySecret (env CDP_API_KEY_SECRET) is required when cdpAuth is set.",
      );
    }
    try {
      parseCdpPrivateKey(apiKeySecret);
    } catch (error) {
      throw new Error(
        `dual402: x402.cdpAuth.apiKeySecret (env CDP_API_KEY_SECRET) could not be parsed: ${errorMessage(error)}. ` +
          "Accepts a PEM block, a 48-byte PKCS#8 DER blob (base64), or a raw Ed25519 seed (32 or 64 bytes, base64).",
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
    _mppConfig: Object.freeze({
      currency: config.mpp.currency,
      recipient: config.mpp.recipient,
      testnet: config.mpp.testnet === true,
    }),
    _x402Config: x402Config,
    _x402Asset: x402Asset,

    charge(opts: ChargeOptions): DualChargeHandler {
      const { amount, description, waitForSettle = true } = opts;
      assertChargeAmount(amount);
      assertHeaderSafeDescription(description);

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
 * Mount `GET /openapi.json` and `GET /.well-known/x402` on the Express app.
 *
 * The OpenAPI spec is built from the `routes` you pass — every paid operation
 * advertises both an MPP and an x402 offer in its `x-payment-info.offers[]`,
 * with matching amounts and the configured payee/network. The
 * `/.well-known/x402` document is intentionally minimal:
 * `{ version: 1, resources: ["GET /quote"] }`.
 *
 * Runtime `PAYMENT-REQUIRED` headers (issued by the per-route middleware)
 * carry the richer per-route request/response schema hints, so agent clients
 * can preserve their inputs on a paid retry.
 *
 * Every entry in `routes` must use the **same** middleware object that was
 * registered on Express — discovery reads `_dualAmount` / `_dualDescription`
 * off the handler. Passing a route without a dual402 charge handler throws.
 */
export function dualDiscovery(
  app: Express,
  dual: Dual402Instance,
  config: DiscoveryConfig,
): void {
  const paths: Record<string, Record<string, unknown>> = {};
  const operationIds = new Set<string>();
  const routeKeys = new Set<string>();

  for (const route of config.routes) {
    assertDiscoveryRoute(route);
    const method = normalizeDiscoveryMethod(route.method);
    const routeKey = `${method} ${route.path}`;

    if (routeKeys.has(routeKey)) {
      throw new Error(`dualDiscovery: duplicate route ${routeKey}.`);
    }
    routeKeys.add(routeKey);

    if (operationIds.has(route.operationId)) {
      throw new Error(`dualDiscovery: duplicate operationId "${route.operationId}".`);
    }
    operationIds.add(route.operationId);

    if (typeof route.handler?._dualAmount !== "string") {
      throw new Error(
        `dualDiscovery: route ${routeKey} is missing a dual402 charge handler.`,
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
      "x-payment-info": buildDiscoveryPaymentInfo(dual, route),
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
      [method.toLowerCase()]: operation,
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
      new Set(
        config.routes.map((route) => `${normalizeDiscoveryMethod(route.method)} ${route.path}`),
      ),
    );
    res.json({ version: 1, resources });
  });
}

function buildDiscoveryPaymentInfo(
  dual: Dual402Instance,
  route: DiscoveryRoute,
): JsonObject {
  const amount = route.handler._dualAmount;
  if (!amount) {
    throw new Error(
      `dualDiscovery: route ${route.method.toUpperCase()} ${route.path} is missing a payment amount.`,
    );
  }

  const amountRaw = toSmallestUnit(amount, 6);
  const description = route.handler._dualDescription ?? route.summary;
  return {
    offers: [
      {
        amount: amountRaw,
        currency: dual._mppConfig.currency,
        description,
        intent: "charge",
        method: "tempo",
      },
      {
        amount: amountRaw,
        currency: dual._x402Config.asset,
        description,
        intent: "charge",
        method: "x402",
        network: dual._x402Config.network,
        payTo: dual._x402Config.payTo,
        scheme: "exact",
      },
    ],
  };
}

function assertDiscoveryRoute(
  route:
    | {
        method?: unknown;
        path?: unknown;
        operationId?: unknown;
        summary?: unknown;
      }
    | null
    | undefined,
): void {
  const label = `${String(route?.method ?? "UNKNOWN").toUpperCase()} ${String(
    route?.path ?? "",
  )}`;
  if (!route || typeof route.method !== "string" || route.method.trim() === "") {
    throw new Error("dualDiscovery: every route needs a non-empty HTTP method.");
  }
  normalizeDiscoveryMethod(route.method);
  if (typeof route.path !== "string" || !route.path.startsWith("/")) {
    throw new Error(`dualDiscovery: route ${label} needs an absolute path starting with "/".`);
  }
  if (typeof route.operationId !== "string" || route.operationId.trim() === "") {
    throw new Error(`dualDiscovery: route ${label} needs a stable operationId.`);
  }
  if (typeof route.summary !== "string" || route.summary.trim() === "") {
    throw new Error(`dualDiscovery: route ${label} needs a short summary.`);
  }
}

function normalizeDiscoveryMethod(method: string): string {
  const normalized = String(method ?? "").trim().toUpperCase();
  if (!HTTP_METHOD_RE.test(normalized) || !OPENAPI_HTTP_METHODS.has(normalized)) {
    throw new Error(`dualDiscovery: invalid HTTP method ${JSON.stringify(method)}.`);
  }
  return normalized;
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
        "Resolve every value through a fail-fast helper at startup (see AGENTS.md).",
    );
  }

  if (String(config.mpp.secretKey).length < 32) {
    throw new Error(
      "dual402: mpp.secretKey must be at least 32 characters (env MPP_SECRET_KEY). " +
        "Generate one with `openssl rand -hex 32`.",
    );
  }
  if (!EVM_ADDR_RE.test(config.mpp.currency)) {
    throw new Error(
      `dual402: mpp.currency (env USDC_TEMPO) must be an EVM token address, got ${JSON.stringify(config.mpp.currency)}. ` +
        "Use the Tempo USDC contract for your target network: testnet 0x20c0...0000, mainnet 0x20c0...e8b50.",
    );
  }
  if (!EVM_ADDR_RE.test(config.mpp.recipient)) {
    throw new Error(
      `dual402: mpp.recipient (env MPP_RECIPIENT) must be an EVM address, got ${JSON.stringify(config.mpp.recipient)}.`,
    );
  }
  if (String(config.x402.network).startsWith("eip155:") && !EVM_ADDR_RE.test(config.x402.payTo)) {
    throw new Error(
      `dual402: x402.payTo must be an EVM address for ${config.x402.network} (env X402_PAYEE_ADDRESS), got ${JSON.stringify(config.x402.payTo)}.`,
    );
  }
  if (config.x402.asset !== undefined && !EVM_ADDR_RE.test(config.x402.asset)) {
    throw new Error(
      `dual402: x402.asset (env X402_ASSET) must be an EVM token address, got ${JSON.stringify(config.x402.asset)}. ` +
        "Leave it unset to use the default USDC for x402.network.",
    );
  }
}

function normalizeFacilitatorUrl(value: string): string {
  const trimmed = String(value ?? "").trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`unsupported protocol ${url.protocol}`);
    }
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    throw new Error(
      `dual402: x402.facilitatorUrl must be an absolute http(s) URL (env X402_FACILITATOR_URL) — ${errorMessage(error)}. ` +
        "Try https://x402.org/facilitator (Sepolia) or https://api.cdp.coinbase.com/platform/v2/x402 (Base mainnet).",
    );
  }
}

function facilitatorHost(value: string): string {
  return new URL(value).host;
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
      `dual402.charge: amount must be a USDC decimal string like "0.02" - got ${JSON.stringify(amount)}. ` +
        "Pass a string, not a number, to avoid float precision drift.",
    );
  }
  if (/^0+(\.0+)?$/.test(amount)) {
    throw new Error(
      `dual402.charge: amount must be greater than zero - got ${JSON.stringify(amount)}.`,
    );
  }
}

function assertHeaderSafeDescription(description: string | undefined): void {
  if (description === undefined) return;
  if (typeof description !== "string") {
    throw new Error(
      `dual402.charge: description must be a string when set - got ${typeof description}.`,
    );
  }

  for (let i = 0; i < description.length; i += 1) {
    const code = description.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new Error(
        `dual402.charge: description must contain printable ASCII only (U+0020-U+007E) ` +
          `because it is serialized into the WWW-Authenticate header (RFC 9110). ` +
          `Invalid character at index ${i} (U+${code.toString(16).toUpperCase().padStart(4, "0")}). ` +
          "Replace em-dashes, smart quotes, and non-Latin characters with ASCII equivalents.",
      );
    }
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
