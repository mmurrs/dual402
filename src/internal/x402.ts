import type { Request, Response } from "express";

import { generateCdpJwt } from "./cdp.js";

export type JsonObject = Record<string, unknown>;
export type JsonSchema = Record<string, unknown>;

export type PaymentRequirements = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: JsonObject;
  resource?: string;
  description?: string;
};

export type VerifyResult = {
  valid: boolean;
  reason?: string;
  txHash?: string;
  payload?: JsonObject;
  paymentRequirements?: JsonObject;
};

type CdpAuthLike = Readonly<{
  apiKeyId: string;
  apiKeySecret: string;
}> | null;

const MAX_SIGNATURE_BYTES = 16 * 1024;
const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";
const BAZAAR_QUERY_METHODS = ["GET", "HEAD", "DELETE"];
const BAZAAR_BODY_METHODS = ["POST", "PUT", "PATCH"];

function base64Json(data: unknown): string {
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sanitizeLogValue(value: unknown, limit = 80): string {
  const str =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();
  return str.length > limit ? `${str.slice(0, limit)}...` : str;
}

export function maskHex(
  value: unknown,
  { head = 6, tail = 4 }: { head?: number; tail?: number } = {},
): string {
  const str = String(value ?? "");
  if (str.length <= head + tail) return str;
  return `${str.slice(0, head)}...${str.slice(-tail)}`;
}

export function resolveBaseUrl(req: Request): string {
  const override = process.env.BASE_URL;
  if (override && override.length > 0) {
    return override.replace(/\/+$/, "");
  }

  const host = req.get("host");
  if (!host) {
    console.warn(
      "[dual402] request has no Host header; resource URLs will be relative. Set BASE_URL to suppress this warning.",
    );
    return "";
  }

  return `${req.protocol}://${host}`;
}

export function toSmallestUnit(amount: string, decimals: number): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(amount).trim());
  if (!match) {
    throw new Error(`toSmallestUnit: invalid amount ${JSON.stringify(amount)}`);
  }

  const whole = match[1];
  const fractional = match[2] ?? "";
  if (fractional.length > decimals && /[1-9]/.test(fractional.slice(decimals))) {
    throw new Error(
      `toSmallestUnit: amount "${amount}" has more precision than ${decimals} decimals`,
    );
  }

  const padded = fractional.padEnd(decimals, "0").slice(0, decimals);
  return (whole + padded).replace(/^0+/, "") || "0";
}

function toBigIntStrict(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`not a safe non-negative integer: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    return BigInt(value);
  }
  throw new Error(`cannot coerce to BigInt: ${typeof value}`);
}

function amountsEqual(left: unknown, right: unknown): boolean {
  try {
    return toBigIntStrict(left) === toBigIntStrict(right);
  } catch {
    return false;
  }
}

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

async function fetchJsonWithTimeout(
  url: string,
  body: JsonObject,
  timeoutMs: number,
  cdpAuth: CdpAuthLike,
): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (cdpAuth) {
    const parsed = new URL(url);
    if (parsed.host === CDP_FACILITATOR_HOST) {
      headers.Authorization = `Bearer ${generateCdpJwt({
        apiKeyId: cdpAuth.apiKeyId,
        apiKeySecret: cdpAuth.apiKeySecret,
        requestMethod: "POST",
        requestHost: parsed.host,
        requestPath: parsed.pathname,
        expiresIn: 120,
      })}`;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function decodePaymentPayload(paymentSignature: string): JsonObject | null {
  try {
    const raw = String(paymentSignature);
    if (raw.length === 0 || raw.length > MAX_SIGNATURE_BYTES) return null;
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    return asObject(parsed);
  } catch {
    return null;
  }
}

function extractPayloadAmount(payload: JsonObject): unknown {
  const p = payload as any;
  return (
    p?.payload?.authorization?.value ??
    p?.authorization?.value ??
    p?.payload?.amount ??
    p?.amount ??
    p?.value
  );
}

function extractPayloadPayee(payload: JsonObject): unknown {
  const p = payload as any;
  return (
    p?.payload?.authorization?.to ??
    p?.authorization?.to ??
    p?.payload?.payTo ??
    p?.payTo ??
    p?.to
  );
}

function looksLikeX402Envelope(payload: JsonObject): boolean {
  const p = payload as any;
  if ("signature" in p || "authorization" in p || "scheme" in p) return true;
  const nested = asObject(p.payload);
  return !!nested && ("signature" in nested || "authorization" in nested);
}

function canonicalizeRequirements(
  requirements: JsonObject | PaymentRequirements | undefined,
): JsonObject | undefined {
  if (!requirements || typeof requirements !== "object") return requirements;
  const req = requirements as PaymentRequirements;
  return {
    scheme: req.scheme,
    network: req.network,
    amount: req.amount,
    asset: req.asset,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    ...(req.extra && { extra: req.extra }),
  };
}

function canonicalizePaymentPayload(payload: JsonObject): JsonObject {
  const accepted = asObject((payload as { accepted?: unknown }).accepted);
  if (!accepted) return payload;
  return {
    ...payload,
    accepted: canonicalizeRequirements(accepted),
  };
}

export async function x402Verify(
  paymentSignature: string,
  facilitatorUrl: string,
  expected: {
    amount: string;
    payTo: string;
    timeoutMs: number;
    paymentRequirements?: PaymentRequirements;
    cdpAuth: CdpAuthLike;
    onVerify: ((payload: JsonObject) => void | boolean | Promise<void | boolean>) | null;
  },
): Promise<VerifyResult> {
  const payload = decodePaymentPayload(paymentSignature);
  if (!payload) return { valid: false, reason: "payload_malformed" };
  if (!looksLikeX402Envelope(payload)) {
    return { valid: false, reason: "envelope_unrecognized" };
  }

  const paymentAmount = extractPayloadAmount(payload);
  if (paymentAmount !== undefined && paymentAmount !== null) {
    if (!amountsEqual(paymentAmount, expected.amount)) {
      console.warn(
        `[dual402] x402 amount mismatch got=${sanitizeLogValue(paymentAmount)} want=${expected.amount}`,
      );
      return { valid: false, reason: "amount_mismatch" };
    }
  }

  const rawPayee = extractPayloadPayee(payload);
  if (rawPayee !== undefined && rawPayee !== null && rawPayee !== "") {
    const got = String(rawPayee).toLowerCase();
    const want = String(expected.payTo).toLowerCase();
    if (got !== want) {
      console.warn(
        `[dual402] x402 payee mismatch got=${maskHex(got)} want=${maskHex(want)}`,
      );
      return { valid: false, reason: "payee_mismatch" };
    }
  }

  if (expected.onVerify) {
    try {
      const hookResult = await expected.onVerify(payload);
      if (hookResult === false) {
        return { valid: false, reason: "rejected_by_hook" };
      }
    } catch (error) {
      console.warn(`[dual402] onVerify hook threw: ${errorMessage(error)}`);
      return { valid: false, reason: "hook_error" };
    }
  }

  const wirePayload = canonicalizePaymentPayload(payload);
  const wireRequirements = canonicalizeRequirements(expected.paymentRequirements);
  const body =
    wireRequirements && expected.paymentRequirements
      ? {
          x402Version: 2,
          paymentPayload: wirePayload,
          paymentRequirements: wireRequirements,
        }
      : { payload };

  try {
    const res = await fetchJsonWithTimeout(
      `${facilitatorUrl}/verify`,
      body,
      expected.timeoutMs,
      expected.cdpAuth,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[dual402] facilitator /verify status=${res.status} body=${sanitizeLogValue(text, 400)}`,
      );
      return { valid: false, reason: `facilitator_${res.status}` };
    }

    const data = asObject(await res.json().catch(() => null));
    if (!data) {
      return { valid: false, reason: "facilitator_bad_json" };
    }

    const valid = data.isValid === true || data.valid === true;
    const rawReason =
      typeof data.invalidReason === "string"
        ? data.invalidReason
        : typeof data.reason === "string"
          ? data.reason
          : undefined;

    return {
      valid,
      reason: valid ? undefined : rawReason ?? "facilitator_rejected",
      txHash: typeof data.txHash === "string" ? data.txHash : undefined,
      payload: valid ? wirePayload : undefined,
      paymentRequirements: valid ? wireRequirements : undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error(
        `[dual402] facilitator /verify TIMEOUT after ${expected.timeoutMs}ms`,
      );
      return { valid: false, reason: "facilitator_timeout" };
    }
    console.error(`[dual402] facilitator /verify error: ${errorMessage(error)}`);
    return { valid: false, reason: "verify_error" };
  }
}

export async function x402Settle(
  payload: JsonObject,
  facilitatorUrl: string,
  timeoutMs: number,
  paymentRequirements: JsonObject | PaymentRequirements | undefined,
  cdpAuth: CdpAuthLike,
): Promise<{ txHash?: string } & JsonObject> {
  const wirePayload = canonicalizePaymentPayload(payload);
  const wireRequirements = canonicalizeRequirements(paymentRequirements);
  const body =
    wireRequirements && paymentRequirements
      ? {
          x402Version: 2,
          paymentPayload: wirePayload,
          paymentRequirements: wireRequirements,
        }
      : { payload };

  const res = await fetchJsonWithTimeout(
    `${facilitatorUrl}/settle`,
    body,
    timeoutMs,
    cdpAuth,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`facilitator /settle ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = asObject(await res.json().catch(() => ({}))) ?? {};
  return {
    ...data,
    txHash:
      typeof data.transaction === "string"
        ? data.transaction
        : typeof data.txHash === "string"
          ? data.txHash
          : undefined,
  };
}

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
