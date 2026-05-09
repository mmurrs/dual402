/**
 * Building the `PAYMENT-REQUIRED` challenge body, the bazaar schema extension,
 * and the `res.status(402)` interception that lets us layer x402 headers on top
 * of mppx's MPP challenge.
 */

import type { Response } from "express";

import type { JsonObject, JsonSchema, PaymentRequirements } from "./types.js";
import { base64Json, errorMessage } from "./utils.js";

const BAZAAR_QUERY_METHODS = ["GET", "HEAD", "DELETE"];
const BAZAAR_BODY_METHODS = ["POST", "PUT", "PATCH"];

/** Build a single x402 `accepts` entry. */
export function buildAcceptsEntry(args: {
  network: string;
  amountRaw: string;
  asset: string;
  payTo: string;
  resourceUrl?: string;
  description?: string;
  extra: { name: string; version: string };
}): PaymentRequirements {
  const entry: PaymentRequirements = {
    scheme: "exact",
    network: args.network,
    amount: args.amountRaw,
    asset: args.asset,
    payTo: args.payTo,
    maxTimeoutSeconds: 300,
    extra: { ...args.extra },
  };

  if (args.resourceUrl) entry.resource = args.resourceUrl;
  if (args.description) entry.description = args.description;
  return entry;
}

/** Build the full `PAYMENT-REQUIRED` JSON body, including the optional bazaar extension. */
export function buildPaymentRequired(args: {
  network: string;
  amountRaw: string;
  asset: string;
  payTo: string;
  resourceUrl?: string;
  description?: string;
  extra: { name: string; version: string };
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  method?: string;
}): JsonObject {
  const method = args.method?.toUpperCase();
  const extensions = buildBazaarExtensions({
    method,
    inputSchema: args.inputSchema,
    outputSchema: args.outputSchema,
  });

  return {
    x402Version: 2,
    accepts: [
      buildAcceptsEntry({
        network: args.network,
        amountRaw: args.amountRaw,
        asset: args.asset,
        payTo: args.payTo,
        resourceUrl: args.resourceUrl,
        description: args.description,
        extra: args.extra,
      }),
    ],
    resource: {
      url: args.resourceUrl ?? "",
      ...(method && { method }),
      description: args.description ?? "",
      mimeType: "application/json",
    },
    ...(extensions && { extensions }),
  };
}

function buildBazaarExtensions(args: {
  method?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}): JsonObject | undefined {
  const { method = "", inputSchema, outputSchema } = args;
  const hasInput = !!inputSchema;
  const hasOutput = !!outputSchema;
  if (!hasInput && !hasOutput) return undefined;

  const upper = method.toUpperCase();
  const isBodyMethod = BAZAAR_BODY_METHODS.includes(upper);
  const isQueryMethod = BAZAAR_QUERY_METHODS.includes(upper);

  const infoInput: JsonObject = {
    type: "http",
    ...(upper && { method: upper }),
    ...(isBodyMethod && { bodyType: "json", body: {} }),
    ...(!isBodyMethod && hasInput && { queryParams: {} }),
  };

  const info: JsonObject = {
    input: infoInput,
    ...(hasOutput && { output: { type: "json", example: {} } }),
  };

  const inputProperties: JsonObject = {
    type: { type: "string", const: "http" },
    ...(upper && {
      method: {
        type: "string",
        enum: isBodyMethod
          ? BAZAAR_BODY_METHODS
          : isQueryMethod
            ? BAZAAR_QUERY_METHODS
            : [upper],
      },
    }),
    ...(isBodyMethod && {
      bodyType: { type: "string", enum: ["json", "form-data", "text"] },
      body: inputSchema ?? { type: "object" },
    }),
    ...(!isBodyMethod &&
      hasInput && {
        queryParams: {
          type: "object",
          ...inputSchema,
        },
      }),
  };

  const schema: JsonObject = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      input: {
        type: "object",
        properties: inputProperties,
        required: isBodyMethod ? ["type", "bodyType", "body"] : ["type"],
        additionalProperties: false,
      },
      ...(hasOutput && {
        output: {
          type: "object",
          properties: {
            type: { type: "string" },
            example: {
              type: "object",
              ...outputSchema,
            },
          },
          required: ["type"],
        },
      }),
    },
    required: ["input"],
  };

  return { bazaar: { info, schema } };
}

/**
 * Replace `res.status` with a wrapper that, on the first call with code 402,
 * stamps a `PAYMENT-REQUIRED` header onto the response. Lets us layer x402
 * onto an MPP-only mppx response without rebuilding the whole response.
 */
export function patchStatusToInject402(
  res: Response,
  paymentRequired: JsonObject,
): void {
  const origStatus = res.status.bind(res);
  (res as Response & { status: (code: number) => Response }).status = (code: number) => {
    if (code === 402 && !res.headersSent) {
      try {
        res.setHeader("PAYMENT-REQUIRED", base64Json(paymentRequired));
      } catch (error) {
        console.warn(
          `[dual402] could not attach PAYMENT-REQUIRED: ${errorMessage(error)}`,
        );
      }
    }
    return origStatus(code);
  };
}

/** Extract a `requestBody.content["application/json"].schema` if present. */
export function extractRequestBodySchema(
  requestBody:
    | {
        required?: boolean;
        content: {
          [mediaType: string]: {
            schema: JsonSchema;
          };
        };
      }
    | undefined,
): JsonSchema | undefined {
  return requestBody?.content?.["application/json"]?.schema;
}

/** Convert OpenAPI query-style parameters into a single JSON Schema object. */
export function parametersToSchema(
  parameters:
    | Array<{
        name: string;
        in: "query";
        required?: boolean;
        schema: JsonSchema;
        description?: string;
      }>
    | undefined,
): JsonSchema | undefined {
  if (!parameters || parameters.length === 0) return undefined;

  const required = parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name);
  const properties: Record<string, unknown> = {};

  for (const parameter of parameters) {
    properties[parameter.name] = {
      ...parameter.schema,
      ...(parameter.description && { description: parameter.description }),
    };
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
    additionalProperties: false,
  };
}
