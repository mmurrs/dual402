/**
 * `dualDiscovery` mounts both OpenAPI and `.well-known/x402` from a shared route
 * list. The OpenAPI spec is the rich, schema-bearing artifact; `.well-known/x402`
 * is intentionally minimal — pricing and request shape live in the runtime
 * `PAYMENT-REQUIRED` header, not in static discovery.
 */

import type { Express, Request, Response } from "express";

import type { Dual402Instance, DualChargeHandler } from "./charge.js";
import type { JsonObject, JsonSchema } from "./internal/types.js";
import {
  extractRequestBodySchema,
  parametersToSchema,
} from "./internal/x402-headers.js";
import { resolveBaseUrl } from "./internal/utils.js";

/**
 * One paid route, as described to {@link dualDiscovery}. The `handler` must be
 * the same charge middleware passed to `app.get(...)` / `app.post(...)` — the
 * discovery layer reads amount/description metadata off it.
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

const DEFAULT_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    results: { type: "array", items: { type: "object" } },
  },
  required: ["results"],
};

/**
 * Mount `GET /openapi.json` and `GET /.well-known/x402` on the Express app. The
 * OpenAPI spec is built from the `routes` you pass; `/.well-known/x402` advertises
 * the minimal `{ version: 1, resources: [...] }` shape. Runtime `PAYMENT-REQUIRED`
 * headers carry the richer per-route schemas so agent clients can retry with a
 * valid body.
 *
 * Every route's `handler` must be the same middleware you registered on the app —
 * discovery reads amount/description metadata off it and threads schemas into it.
 */
export function dualDiscovery(
  app: Express,
  _dual: Dual402Instance,
  config: DiscoveryConfig,
): void {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of config.routes) {
    if (typeof route.handler?._dualAmount !== "string") {
      throw new Error(
        `dualDiscovery: route ${route.method.toUpperCase()} ${route.path} is missing a dual402 charge handler.`,
      );
    }

    const requestBody = resolveRequestBody(route);
    const inputSchema =
      extractRequestBodySchema(requestBody) ?? parametersToSchema(route.parameters);
    const outputSchema = route.responseSchema ?? DEFAULT_RESPONSE_SCHEMA;
    const method = route.method.toUpperCase();

    annotateHandlerWithSchemas(route.handler, route.path, method, inputSchema, outputSchema);

    paths[route.path] = {
      ...(paths[route.path] ?? {}),
      [route.method]: buildOperation(route, requestBody, outputSchema),
    };
  }

  const spec = buildOpenApiSpec(config, paths);

  app.get("/openapi.json", (req: Request, res: Response) => {
    const baseUrl = resolveBaseUrl(req);
    res.json({
      ...spec,
      ...(baseUrl && { servers: [{ url: baseUrl }] }),
    });
  });

  app.get("/.well-known/x402", (_req: Request, res: Response) => {
    const resources = Array.from(
      new Set(config.routes.map((route) => `${route.method.toUpperCase()} ${route.path}`)),
    );
    res.json({ version: 1, resources });
  });
}

function resolveRequestBody(route: DiscoveryRoute): DiscoveryRoute["requestBody"] {
  if (route.requestBody) return route.requestBody;
  if (!route.requestBodySchema) return undefined;
  return {
    required: route.requestBodyRequired ?? true,
    content: {
      "application/json": { schema: route.requestBodySchema },
    },
  };
}

function annotateHandlerWithSchemas(
  handler: DualChargeHandler,
  routePath: string,
  method: string,
  inputSchema: JsonSchema | undefined,
  outputSchema: JsonSchema,
): void {
  const routeKey = `${method} ${routePath}`;

  if (inputSchema) {
    handler._dualInputSchema ??= inputSchema;
    handler._dualInputSchemasByMethod ??= {};
    handler._dualInputSchemasByMethod[method] = inputSchema;
    handler._dualInputSchemasByRoute ??= {};
    handler._dualInputSchemasByRoute[routeKey] = inputSchema;
  }
  handler._dualOutputSchema ??= outputSchema;
  handler._dualOutputSchemasByMethod ??= {};
  handler._dualOutputSchemasByMethod[method] = outputSchema;
  handler._dualOutputSchemasByRoute ??= {};
  handler._dualOutputSchemasByRoute[routeKey] = outputSchema;
}

function buildOperation(
  route: DiscoveryRoute,
  requestBody: DiscoveryRoute["requestBody"],
  outputSchema: JsonSchema,
): Record<string, unknown> {
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
          "application/json": { schema: outputSchema },
        },
      },
      402: { description: "Payment Required" },
    },
  };

  if (route.parameters?.length) operation.parameters = route.parameters;
  if (requestBody) operation.requestBody = requestBody;
  return operation;
}

function buildOpenApiSpec(
  config: DiscoveryConfig,
  paths: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
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

  if (config.serviceInfo) spec["x-service-info"] = config.serviceInfo;
  return spec;
}
