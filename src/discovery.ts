import type { Express, Request, Response } from "express";

import {
  buildAcceptsEntry,
  buildBazaarExtensions,
  extractRequestBodySchema,
  parametersToSchema,
  resolveBaseUrl,
  toSmallestUnit,
  type JsonObject,
  type JsonSchema,
} from "./internal/x402.js";
import type {
  DiscoveryConfig,
  DiscoveryRoute,
  Dual402Instance,
  PaidRouteOptions,
} from "./types.js";

const DEFAULT_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    results: { type: "array", items: { type: "object" } },
  },
  required: ["results"],
};

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

/**
 * Define a paid route once. The returned object can be passed straight into
 * `app.get(...)` / `app.post(...)` for Express mounting, and into the `routes`
 * array of `dualDiscovery` so the OpenAPI spec stays in sync with the actual
 * middleware.
 *
 * Prefer `paidRoute()` over the lower-level `Dual402Instance.charge` when the
 * route should be discoverable.
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
 * Mount `GET /openapi.json` and `GET /.well-known/x402` on the Express app.
 *
 * The OpenAPI spec is built from the `routes` you pass - every paid operation
 * advertises both an MPP and an x402 offer in its `x-payment-info.offers[]`,
 * with matching amounts and the configured payee/network. The
 * `/.well-known/x402` document publishes Bazaar-style x402 resource metadata
 * including service name, route tags, icon URL, payment requirements, and
 * request/response schema extensions.
 *
 * Runtime `PAYMENT-REQUIRED` headers carry the richer per-route
 * request/response schema hints, so agent clients can preserve their inputs on
 * a paid retry.
 *
 * Every entry in `routes` must use the same middleware object registered on
 * Express. Discovery reads `_dualAmount` / `_dualDescription` off that handler
 * and attaches the route schemas to the same handler object for paid retries.
 */
export function dualDiscovery(
  app: Express,
  dual: Dual402Instance,
  config: DiscoveryConfig,
): void {
  const paths: Record<string, Record<string, unknown>> = {};
  const operationIds = new Set<string>();
  const routeKeys = new Set<string>();
  const mountedAt = new Date().toISOString();
  const serviceName = config.serviceName ?? config.info?.title;
  const serviceTags = normalizeTags(config.tags);

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
    if (serviceName) route.handler._dualServiceName = serviceName;
    const routeTags = mergeTags(serviceTags, route.tags);
    if (routeTags.length > 0) {
      route.handler._dualTags ??= routeTags;
      route.handler._dualTagsByRoute ??= {};
      route.handler._dualTagsByRoute[`${method} ${route.path}`] = routeTags;
    }
    if (config.iconUrl) route.handler._dualIconUrl = config.iconUrl;

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
    spec["x-service-info"] = {
      ...config.serviceInfo,
      ...(serviceName && { serviceName }),
      ...(serviceTags.length > 0 && { tags: serviceTags }),
      ...(config.iconUrl && { iconUrl: config.iconUrl }),
    };
  } else if (serviceName || serviceTags.length > 0 || config.iconUrl) {
    spec["x-service-info"] = {
      ...(serviceName && { serviceName }),
      ...(serviceTags.length > 0 && { tags: serviceTags }),
      ...(config.iconUrl && { iconUrl: config.iconUrl }),
    };
  }

  app.get("/openapi.json", (req: Request, res: Response) => {
    const baseUrl = resolveBaseUrl(req);
    res.json({
      ...spec,
      ...(baseUrl && { servers: [{ url: baseUrl }] }),
    });
  });

  app.get("/.well-known/x402", (req: Request, res: Response) => {
    const baseUrl = resolveBaseUrl(req);
    const resources = config.routes.map((route) =>
      buildX402Resource({
        baseUrl,
        config,
        dual,
        mountedAt,
        route,
      }),
    );
    res.json({
      x402Version: 2,
      payTo: dual._x402Config.payTo,
      resources,
      pagination: {
        limit: resources.length,
        offset: 0,
        total: resources.length,
      },
    });
  });
}

function buildX402Resource(args: {
  baseUrl: string;
  config: DiscoveryConfig;
  dual: Dual402Instance;
  mountedAt: string;
  route: DiscoveryRoute;
}): JsonObject {
  const { baseUrl, config, dual, mountedAt, route } = args;
  const amount = route.handler._dualAmount;
  if (!amount) {
    throw new Error(
      `dualDiscovery: route ${route.method.toUpperCase()} ${route.path} is missing a payment amount.`,
    );
  }

  const method = normalizeDiscoveryMethod(route.method);
  const routeKey = `${method} ${route.path}`;
  const resourceUrl = `${baseUrl}${route.path}`;
  const description = route.description ?? route.handler._dualDescription ?? route.summary;
  const inputSchema =
    route.handler._dualInputSchemasByRoute?.[routeKey] ??
    route.handler._dualInputSchemasByMethod?.[method] ??
    route.handler._dualInputSchema;
  const outputSchema =
    route.handler._dualOutputSchemasByRoute?.[routeKey] ??
    route.handler._dualOutputSchemasByMethod?.[method] ??
    route.handler._dualOutputSchema;
  const extensions = buildBazaarExtensions({ method, inputSchema, outputSchema });
  const serviceName = config.serviceName ?? config.info?.title;
  const tags = mergeTags(config.tags, route.tags);

  return {
    resource: resourceUrl,
    description,
    type: "http",
    x402Version: 2,
    lastUpdated: mountedAt,
    accepts: [
      buildAcceptsEntry({
        network: dual._x402Config.network,
        amountRaw: toSmallestUnit(amount, 6),
        asset: dual._x402Config.asset,
        payTo: dual._x402Config.payTo,
        resourceUrl,
        description,
        extra: dual._x402Config.extra,
      }),
    ],
    ...(extensions && { extensions }),
    ...(serviceName && { serviceName }),
    ...(tags.length > 0 && { tags }),
    ...(config.iconUrl && { iconUrl: config.iconUrl }),
  };
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

function normalizeTags(tags: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const tag of tags ?? []) {
    const value = String(tag).trim();
    if (value) normalized.add(value);
  }
  return Array.from(normalized);
}

function mergeTags(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] {
  return normalizeTags([...(first ?? []), ...(second ?? [])]);
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
