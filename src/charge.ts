import type { Request, RequestHandler, Response } from "express";

import {
  buildAcceptsEntry,
  buildBazaarExtensions,
  buildPaymentRequired,
  buildPaymentResourceInfo,
  maskHex,
  patchStatusToInject402,
  resolveBaseUrl,
  sanitizeLogValue,
  toSmallestUnit,
  x402Settle,
  x402Verify,
  type JsonObject,
  type JsonSchema,
  type BazaarRouteMetadata,
} from "./internal/x402.js";
import type { ChargeOptions, DualChargeHandler, OnVerify, ResolvedX402Config } from "./types.js";

type ChargeFactoryArgs = {
  mppx: any;
  x402Config: ResolvedX402Config;
  getOnVerify?: () => OnVerify | undefined;
};

export function createChargeFactory({
  mppx,
  x402Config,
  getOnVerify,
}: ChargeFactoryArgs): (opts: ChargeOptions) => DualChargeHandler {
  return function charge(opts: ChargeOptions): DualChargeHandler {
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
      const method = String(
        handler._dualCanonicalMethodsByPath?.[route] ??
          handler._dualCanonicalMethod ??
          req.method ??
          "GET",
      ).toUpperCase();
      const routeKey = `${method} ${route}`;
      const inputSchema =
        handler._dualInputSchemasByRoute?.[routeKey] ??
        handler._dualInputSchemasByMethod?.[method] ?? handler._dualInputSchema;
      const outputSchema =
        handler._dualOutputSchemasByRoute?.[routeKey] ??
        handler._dualOutputSchemasByMethod?.[method] ?? handler._dualOutputSchema;
      const bazaarMetadata =
        handler._dualBazaarByRoute?.[routeKey] ??
        handler._dualBazaarByMethod?.[method] ??
        handler._dualBazaar;
      const tags = handler._dualTagsByRoute?.[routeKey] ?? handler._dualTags;
      const resourceUrl = `${resolveBaseUrl(req)}${route}`;
      const resource = buildPaymentResourceInfo({
        resourceUrl,
        description,
        serviceName: handler._dualServiceName,
        tags,
        iconUrl: handler._dualIconUrl,
      });
      const extensions = buildBazaarExtensions({
        method,
        inputSchema,
        outputSchema,
        ...bazaarMetadata,
      });

      try {
        const x402Sig = readPaymentSignature(req);
        if (x402Sig) {
          const paymentRequirements = buildAcceptsEntry({
            network: x402Config.network,
            amountRaw,
            asset: x402Config.asset,
            payTo: x402Config.payTo,
            resourceUrl,
            description,
            extra: x402Config.extra,
          });
          const onVerify = getOnVerify?.();

          const verified = await x402Verify(x402Sig, x402Config.facilitatorUrl, {
            amount: amountRaw,
            payTo: x402Config.payTo,
            timeoutMs: x402Config.timeoutMs,
            paymentRequirements,
            resource,
            extensions,
            cdpAuth: x402Config.cdpAuth,
            onVerify: onVerify
              ? (payload: JsonObject) => onVerify?.(payload, { route, amount })
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
              { resource, extensions },
            );

            if (waitForSettle) {
              try {
                const result = await settlePromise;
                applyReceiptHeader(
                  res,
                  x402Config.network,
                  result.txHash,
                  result.extensionResponses ?? verified.extensionResponses,
                );
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
                  bazaarMetadata,
                  method,
                  serviceName: handler._dualServiceName,
                  tags,
                  iconUrl: handler._dualIconUrl,
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
              applyReceiptHeader(
                res,
                x402Config.network,
                verified.txHash,
                verified.extensionResponses,
              );
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
            resourceUrl,
            description,
            extra: x402Config.extra,
            inputSchema,
            outputSchema,
            ...bazaarMetadata,
            serviceName: handler._dualServiceName,
            tags,
            iconUrl: handler._dualIconUrl,
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
  };
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
  extensionResponses?: JsonObject,
): void {
  if (txHash && !res.headersSent) {
    res.setHeader(
      "PAYMENT-RESPONSE",
      Buffer.from(
        JSON.stringify({
          success: true,
          txHash,
          network,
          ...(extensionResponses && { extensionResponses }),
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
    bazaarMetadata?: BazaarRouteMetadata;
    method: string;
    serviceName?: string;
    tags?: string[];
    iconUrl?: string;
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
            ...args.bazaarMetadata,
            serviceName: args.serviceName,
            tags: args.tags,
            iconUrl: args.iconUrl,
            method: args.method,
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
