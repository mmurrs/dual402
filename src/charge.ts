/**
 * `createDual402` factory and the per-route charge middleware. Detects which
 * payment protocol the client speaks, runs the protocol-specific verify path,
 * and on 402 emits a single response carrying both x402 and MPP challenges.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Mppx, tempo } from "mppx/express";

import {
  type CdpAuth,
  type Dual402Config,
  type ResolvedX402Config,
  assertConfig,
  normalizeFacilitatorUrl,
} from "./config.js";
import { Dual402ConfigError } from "./errors.js";
import { parseCdpPrivateKey } from "./internal/cdp.js";
import { USDC_BY_NETWORK } from "./internal/networks.js";
import type { JsonObject, JsonSchema } from "./internal/types.js";
import {
  base64Json,
  errorMessage,
  maskHex,
  resolveBaseUrl,
  sanitizeLogValue,
  toSmallestUnit,
} from "./internal/utils.js";
import {
  buildAcceptsEntry,
  buildPaymentRequired,
  patchStatusToInject402,
} from "./internal/x402-headers.js";
import { x402Settle, x402Verify } from "./internal/x402-wire.js";

/** Per-route options for {@link Dual402Instance.charge}. */
export type ChargeOptions = {
  /** Price in USDC as a decimal string. E.g. `"0.02"` = 2 cents. */
  amount: string;
  /** Human-readable description. ASCII only — ends up in `WWW-Authenticate` header values. */
  description?: string;
  /** Block on x402 settlement before returning the response. Default is fire-and-forget. */
  waitForSettle?: boolean;
};

/** Express middleware returned by {@link Dual402Instance.charge}. Discovery reads metadata off it. */
export type DualChargeHandler = RequestHandler & {
  _dualAmount?: string;
  _dualDescription?: string;
  _dualInputSchema?: JsonSchema;
  _dualOutputSchema?: JsonSchema;
  _dualInputSchemasByMethod?: Record<string, JsonSchema>;
  _dualOutputSchemasByMethod?: Record<string, JsonSchema>;
  _dualInputSchemasByRoute?: Record<string, JsonSchema>;
  _dualOutputSchemasByRoute?: Record<string, JsonSchema>;
};

/** The object returned by {@link createDual402}. Use `.charge()` to mint per-route middleware. */
export type Dual402Instance = {
  /** Create an Express middleware that accepts both x402 and MPP payments for this route. */
  charge(options: ChargeOptions): DualChargeHandler;
  /** @internal The underlying mppx instance. Prefer the public `charge()` API. */
  _mppx: unknown;
  /** @internal Resolved x402 config after defaults and validation. */
  _x402Config: ResolvedX402Config;
  /** @internal Resolved USDC contract address. */
  _x402Asset: string;
};

const DEFAULT_FACILITATOR_TIMEOUT_MS = (() => {
  const env = Number.parseInt(process.env.X402_FACILITATOR_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 5_000;
})();

/**
 * Create a dual-protocol payment handler. Validates config and resolves
 * defaults for the x402 asset / facilitator timeout / EIP-712 domain.
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
    throw new Dual402ConfigError(
      "unknown_network_asset",
      `dual402: no default USDC for network "${config.x402.network}". ` +
        `Set x402.asset explicitly or pick one of ${Object.keys(USDC_BY_NETWORK).join(", ")}.`,
    );
  }

  const facilitatorUrl = normalizeFacilitatorUrl(config.x402.facilitatorUrl);
  const timeoutMs =
    Number.isFinite(config.x402.timeoutMs) && Number(config.x402.timeoutMs) > 0
      ? Number(config.x402.timeoutMs)
      : DEFAULT_FACILITATOR_TIMEOUT_MS;
  const extra =
    config.x402.extra && typeof config.x402.extra === "object"
      ? Object.freeze({ ...config.x402.extra })
      : Object.freeze({ name: "USD Coin", version: "2" });

  const cdpAuth = resolveCdpAuth(config.x402.cdpAuth);

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
      assertHeaderSafeDescription(description);

      const mppCharge = (mppx as { charge(opts: { amount: string; description?: string }): RequestHandler })
        .charge({ amount, description });
      const amountRaw = toSmallestUnit(amount, 6);

      const handler: DualChargeHandler = async (req, res, next) => {
        const route = resolveRoutePath(req);
        const method = String(req.method || "GET").toUpperCase();
        const routeKey = `${method} ${route}`;
        const inputSchema = lookupSchema(handler._dualInputSchemasByRoute, handler._dualInputSchemasByMethod, handler._dualInputSchema, routeKey, method);
        const outputSchema = lookupSchema(handler._dualOutputSchemasByRoute, handler._dualOutputSchemasByMethod, handler._dualOutputSchema, routeKey, method);

        try {
          const x402Sig = readPaymentSignature(req);
          if (x402Sig) {
            const handled = await handleX402Path(req, res, next, {
              x402Sig,
              x402Config,
              amount,
              amountRaw,
              description,
              route,
              waitForSettle,
              inputSchema,
              outputSchema,
              onVerify: config.onVerify,
            });
            if (handled) return;
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
            next(arg as Parameters<NextFunction>[0]);
          });
        } catch (error) {
          console.error(`[dual402] handler error route=${route}:`, error);
          next(error as Parameters<NextFunction>[0]);
        }
      };

      handler._dualAmount = amount;
      handler._dualDescription = description;
      return handler;
    },
  };
}

type X402PathArgs = {
  x402Sig: string;
  x402Config: ResolvedX402Config;
  amount: string;
  amountRaw: string;
  description?: string;
  route: string;
  waitForSettle: boolean;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  onVerify: Dual402Config["onVerify"];
};

/**
 * Run the x402 verify + settle path. Returns true when this layer fully handled
 * the response (success or settle-failed-502); false when the request should
 * fall through to the MPP/challenge path.
 */
async function handleX402Path(
  req: Request,
  res: Response,
  next: NextFunction,
  args: X402PathArgs,
): Promise<boolean> {
  const { x402Config, amount, amountRaw, description, route, waitForSettle, inputSchema, outputSchema, onVerify } = args;

  const paymentRequirements = buildAcceptsEntry({
    network: x402Config.network,
    amountRaw,
    asset: x402Config.asset,
    payTo: x402Config.payTo,
    resourceUrl: `${resolveBaseUrl(req)}${route}`,
    description,
    extra: x402Config.extra,
  });

  const verified = await x402Verify(args.x402Sig, x402Config.facilitatorUrl, {
    amount: amountRaw,
    payTo: x402Config.payTo,
    timeoutMs: x402Config.timeoutMs,
    paymentRequirements,
    cdpAuth: x402Config.cdpAuth,
    onVerify: onVerify
      ? (payload: JsonObject) => onVerify(payload, { route, amount })
      : null,
  });

  if (!verified.valid || !verified.payload) {
    console.warn(
      `[dual402] x402 verify failed reason=${verified.reason ?? "unknown"} route=${route}`,
    );
    return false;
  }

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
      res.status(502).json({
        error: "payment_settle_failed",
        reason: sanitizeLogValue(errorMessage(error), 200),
      });
      return true;
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

  next();
  return true;
}

function resolveRoutePath(req: Request): string {
  if (typeof req.path === "string" && req.path.length > 0) return req.path;
  const fromUrl = String(req.originalUrl || "").split("?")[0];
  return fromUrl || "/";
}

function lookupSchema(
  byRoute: Record<string, JsonSchema> | undefined,
  byMethod: Record<string, JsonSchema> | undefined,
  fallback: JsonSchema | undefined,
  routeKey: string,
  method: string,
): JsonSchema | undefined {
  return byRoute?.[routeKey] ?? byMethod?.[method] ?? fallback;
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
    res.setHeader("PAYMENT-RESPONSE", base64Json({ success: true, txHash, network }));
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
      base64Json(
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
    );
  } catch {
    // best effort
  }
}

function logSettle(amount: string, route: string, txHash?: string): void {
  const suffix = txHash ? ` tx=${maskHex(txHash)}` : "";
  console.log(`[PAY] x402 settled amount=${amount} route=${route}${suffix}`);
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

function resolveCdpAuth(cdpAuth: CdpAuth | undefined): Readonly<CdpAuth> | null {
  if (!cdpAuth) return null;
  const { apiKeyId, apiKeySecret } = cdpAuth;
  if (!apiKeyId) {
    throw new Dual402ConfigError(
      "invalid_cdp_auth",
      "dual402: x402.cdpAuth.apiKeyId is required when cdpAuth is set.",
    );
  }
  if (!apiKeySecret) {
    throw new Dual402ConfigError(
      "invalid_cdp_auth",
      "dual402: x402.cdpAuth.apiKeySecret is required when cdpAuth is set.",
    );
  }
  try {
    parseCdpPrivateKey(apiKeySecret);
  } catch (error) {
    throw new Dual402ConfigError(
      "invalid_cdp_auth",
      `dual402: CDP_API_KEY_SECRET could not be parsed: ${errorMessage(error)}`,
    );
  }
  return Object.freeze({ apiKeyId, apiKeySecret });
}

function assertChargeAmount(amount: string): void {
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) {
    throw new Dual402ConfigError(
      "invalid_amount",
      `dual402.charge: amount must be a decimal string like "0.02" — got ${JSON.stringify(amount)}`,
    );
  }
  if (/^0+(\.0+)?$/.test(amount)) {
    throw new Dual402ConfigError(
      "invalid_amount",
      `dual402.charge: amount must be > 0 — got ${JSON.stringify(amount)}.`,
    );
  }
}

function assertHeaderSafeDescription(description: string | undefined): void {
  if (description === undefined) return;
  if (typeof description !== "string") {
    throw new Dual402ConfigError(
      "invalid_description",
      `dual402.charge: description must be a string when set — got ${typeof description}`,
    );
  }

  for (let i = 0; i < description.length; i += 1) {
    const code = description.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new Dual402ConfigError(
        "invalid_description",
        "dual402.charge: description must contain printable ASCII only because it is used in HTTP payment headers. " +
          `Invalid character at index ${i} (U+${code.toString(16).toUpperCase().padStart(4, "0")}).`,
      );
    }
  }
}
