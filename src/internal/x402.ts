import type { Request, Response } from "express";
import { domainToASCII } from "node:url";

import { generateCdpJwt } from "./cdp.js";

export type JsonObject = Record<string, unknown>;
/** JSON Schema object (draft 2020-12 recommended) used for request/response hints in discovery. */
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

export type PaymentResourceInfo = {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
};

export type BazaarBodyType = "json" | "form-data" | "text";

export type BazaarRouteMetadata = {
  inputExample?: unknown;
  outputExample?: unknown;
  bodyType?: BazaarBodyType;
};

export type VerifyResult = {
  valid: boolean;
  reason?: string;
  txHash?: string;
  payload?: JsonObject;
  paymentRequirements?: JsonObject;
  extensionResponses?: JsonObject;
};

type CdpAuthLike = Readonly<{
  apiKeyId: string;
  apiKeySecret: string;
}> | null;

const MAX_SIGNATURE_BYTES = 16 * 1024;
const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";
const BAZAAR_QUERY_METHODS = ["GET", "HEAD", "DELETE"];
const BAZAAR_BODY_METHODS = ["POST", "PUT", "PATCH"];
const MAX_SERVICE_NAME_LENGTH = 32;
const MAX_TAG_LENGTH = 32;
const MAX_TAGS = 5;
const MAX_ICON_URL_LENGTH = 2048;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const UNICODE_CONTROL_RE = /\p{Cc}/u;
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const ALL_DIGITS_RE = /^\d+$/;
const HEX_LITERAL_RE = /^0x[0-9a-f]+$/i;
const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

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

/**
 * Shorten a hex string for safe logging — `0xabc...1234` by default.
 * Use for payer/wallet addresses and transaction hashes in public boot logs;
 * the full value is too noisy for routine output and shouldn't go on a
 * shared third-party-auditable log surface unmasked.
 */
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

export function buildPaymentResourceInfo(args: {
  resourceUrl?: string;
  description?: string;
  serviceName?: unknown;
  tags?: unknown;
  iconUrl?: unknown;
}): PaymentResourceInfo {
  const serviceMetadata = sanitizeResourceServiceMetadata({
    serviceName: args.serviceName,
    tags: args.tags,
    iconUrl: args.iconUrl,
  });

  return {
    url: args.resourceUrl ?? "",
    ...(args.description && { description: args.description }),
    mimeType: "application/json",
    ...serviceMetadata,
  };
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
  inputExample?: unknown;
  outputExample?: unknown;
  bodyType?: BazaarBodyType;
  method?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}): JsonObject {
  const method = args.method?.toUpperCase();
  const extensions = buildBazaarExtensions({
    method,
    inputSchema: args.inputSchema,
    outputSchema: args.outputSchema,
    inputExample: args.inputExample,
    outputExample: args.outputExample,
    bodyType: args.bodyType,
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
    resource: buildPaymentResourceInfo({
      resourceUrl: args.resourceUrl,
      description: args.description,
      serviceName: args.serviceName,
      tags: args.tags,
      iconUrl: args.iconUrl,
    }),
    ...(extensions && { extensions }),
  };
}

export function buildBazaarExtensions(args: {
  method?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  inputExample?: unknown;
  outputExample?: unknown;
  bodyType?: BazaarBodyType;
}): JsonObject | undefined {
  const { method = "", inputSchema, outputSchema } = args;
  const hasInput = !!inputSchema || args.inputExample !== undefined;
  const hasOutput = !!outputSchema || args.outputExample !== undefined;
  if (!hasInput && !hasOutput) return undefined;

  const upper = method.toUpperCase();
  const isBodyMethod = BAZAAR_BODY_METHODS.includes(upper);
  const isQueryMethod = BAZAAR_QUERY_METHODS.includes(upper);
  if (!isBodyMethod && !isQueryMethod) return undefined;

  const bodyType = args.bodyType ?? "json";
  const inputExample =
    args.inputExample !== undefined
      ? args.inputExample
      : inputSchema
        ? exampleFromJsonSchema(inputSchema)
        : {};
  const outputExample =
    args.outputExample !== undefined
      ? args.outputExample
      : outputSchema
        ? exampleFromJsonSchema(outputSchema)
        : undefined;

  const infoInput: JsonObject = {
    type: "http",
    ...(upper && { method: upper }),
    ...(isBodyMethod && { bodyType, body: inputExample ?? {} }),
    ...(!isBodyMethod && hasInput && { queryParams: inputExample ?? {} }),
  };

  const info: JsonObject = {
    input: infoInput,
    ...(hasOutput && {
      output: {
        type: "json",
        ...(outputExample !== undefined && { example: outputExample }),
      },
    }),
  };

  const methodEnum = upper
    ? [upper]
    : isBodyMethod
      ? BAZAAR_BODY_METHODS
      : BAZAAR_QUERY_METHODS;
  const inputProperties: JsonObject = {
    type: { type: "string", const: "http" },
    method: {
      type: "string",
      enum: methodEnum,
    },
    ...(isBodyMethod && {
      bodyType: { type: "string", enum: ["json", "form-data", "text"] },
      body: inputSchema ?? schemaFromExample(inputExample) ?? { type: "object" },
    }),
    ...(!isBodyMethod &&
      hasInput && {
        queryParams: {
          type: "object",
          ...(inputSchema ?? schemaFromExample(inputExample)),
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
        required: isBodyMethod
          ? ["type", "method", "bodyType", "body"]
          : ["type", "method"],
        additionalProperties: false,
      },
      ...(hasOutput && {
        output: {
          type: "object",
          properties: {
            type: { type: "string" },
            example: {
              ...(outputSchema ??
                schemaFromExample(outputExample) ?? {
                  type: "object",
                }),
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

export function sanitizeResourceServiceMetadata(args: {
  serviceName?: unknown;
  tags?: unknown;
  iconUrl?: unknown;
}): Pick<PaymentResourceInfo, "serviceName" | "tags" | "iconUrl"> {
  const out: Pick<PaymentResourceInfo, "serviceName" | "tags" | "iconUrl"> = {};
  if (isValidServiceName(args.serviceName)) out.serviceName = args.serviceName;
  const tags = sanitizeTags(args.tags);
  if (tags) out.tags = tags;
  if (isValidIconUrl(args.iconUrl)) out.iconUrl = args.iconUrl;
  return out;
}

function isValidServiceName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_SERVICE_NAME_LENGTH) return false;
  if (UNICODE_CONTROL_RE.test(value)) return false;
  return PRINTABLE_ASCII_RE.test(value);
}

function sanitizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (entry.length === 0 || entry.length > MAX_TAG_LENGTH) continue;
    if (UNICODE_CONTROL_RE.test(entry) || !PRINTABLE_ASCII_RE.test(entry)) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length === MAX_TAGS) break;
  }

  return out.length > 0 ? out : undefined;
}

function isValidIconUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_ICON_URL_LENGTH) return false;
  if (CONTROL_CHAR_RE.test(value)) return false;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.host.startsWith("[")) return false;

  let hostname: string;
  try {
    hostname = decodeURIComponent(parsed.hostname);
  } catch {
    return false;
  }

  hostname = domainToASCII(hostname).toLowerCase();
  if (!hostname) return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return false;
  if (IPV4_RE.test(hostname)) return false;
  if (ALL_DIGITS_RE.test(hostname)) return false;
  if (HEX_LITERAL_RE.test(hostname)) return false;
  return true;
}

function exampleFromJsonSchema(schema: JsonSchema | undefined): unknown {
  const object = asObject(schema);
  if (!object) return {};
  if ("const" in object) return object.const;
  if (Array.isArray(object.enum) && object.enum.length > 0) return object.enum[0];
  if ("default" in object) return object.default;
  if (Array.isArray(object.examples) && object.examples.length > 0) {
    return object.examples[0];
  }

  const rawType = object.type;
  const type = Array.isArray(rawType)
    ? rawType.find((value) => value !== "null")
    : rawType;

  if (type === "object" || asObject(object.properties)) {
    const properties = asObject(object.properties) ?? {};
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(properties)) {
      out[key] = exampleFromJsonSchema(asObject(value) ?? undefined);
    }
    return out;
  }

  if (type === "array") return [];
  if (type === "integer") return exampleNumber(object, true);
  if (type === "number") return exampleNumber(object, false);
  if (type === "boolean") return true;
  if (type === "null") return null;
  if (type === "string") return exampleString(object);
  return {};
}

function exampleNumber(schema: JsonObject, integer: boolean): number {
  const minimum =
    typeof schema.minimum === "number"
      ? schema.minimum
      : typeof schema.exclusiveMinimum === "number"
        ? schema.exclusiveMinimum + 1
        : 0;
  return integer ? Math.ceil(minimum) : minimum;
}

function exampleString(schema: JsonObject): string {
  if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (schema.format === "date") return "2026-01-01";
  if (schema.format === "uri" || schema.format === "url") {
    return "https://example.com";
  }

  const minLength =
    typeof schema.minLength === "number" && schema.minLength > 0
      ? schema.minLength
      : 1;
  const maxLength =
    typeof schema.maxLength === "number" && schema.maxLength > 0
      ? schema.maxLength
      : undefined;
  const length = maxLength ? Math.min(minLength, maxLength) : minLength;
  return "x".repeat(length);
}

function schemaFromExample(example: unknown): JsonSchema | undefined {
  if (example === undefined) return undefined;
  if (example === null) return { type: "null" };
  if (Array.isArray(example)) {
    return {
      type: "array",
      ...(example.length > 0 && { items: schemaFromExample(example[0]) }),
    };
  }
  if (typeof example === "object") {
    const properties: JsonObject = {};
    for (const [key, value] of Object.entries(example as JsonObject)) {
      properties[key] = schemaFromExample(value) ?? {};
    }
    return { type: "object", properties };
  }
  if (typeof example === "string") return { type: "string" };
  if (typeof example === "number") {
    return { type: Number.isInteger(example) ? "integer" : "number" };
  }
  if (typeof example === "boolean") return { type: "boolean" };
  return undefined;
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

function stringsEqualIgnoreCase(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return left.toLowerCase() === right.toLowerCase();
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

function resourceInfoFromRequirements(
  requirements: JsonObject | PaymentRequirements | undefined,
): PaymentResourceInfo | undefined {
  if (!requirements || typeof requirements !== "object") return undefined;
  const req = requirements as PaymentRequirements;
  if (typeof req.resource !== "string" || req.resource.length === 0) return undefined;
  return buildPaymentResourceInfo({
    resourceUrl: req.resource,
    description: req.description,
  });
}

function normalizeResourceInfo(
  value: unknown,
  fallbackResource?: PaymentResourceInfo,
): PaymentResourceInfo | undefined {
  const resource = asObject(value);
  const normalized =
    typeof value === "string" && value.length > 0
      ? buildPaymentResourceInfo({ resourceUrl: value })
      : resource && typeof resource.url === "string" && resource.url.length > 0
        ? buildPaymentResourceInfo({
            resourceUrl: resource.url,
            description:
              typeof resource.description === "string" ? resource.description : undefined,
            serviceName: resource.serviceName,
            tags: Array.isArray(resource.tags) ? resource.tags : undefined,
            iconUrl: resource.iconUrl,
          })
        : undefined;

  if (!fallbackResource) return normalized;

  return {
    ...fallbackResource,
    mimeType: fallbackResource.mimeType ?? "application/json",
  };
}

function mergeExtensions(
  clientExtensions: unknown,
  serverExtensions: JsonObject | undefined,
): JsonObject | undefined {
  const client = asObject(clientExtensions);
  const sanitizedClient = client ? { ...client } : undefined;
  delete sanitizedClient?.bazaar;

  if (!sanitizedClient && !serverExtensions) return undefined;
  if (
    sanitizedClient &&
    Object.keys(sanitizedClient).length === 0 &&
    !serverExtensions
  ) {
    return undefined;
  }

  return {
    ...(sanitizedClient ?? {}),
    ...(serverExtensions ?? {}),
  };
}

function canonicalizePaymentPayload(
  payload: JsonObject,
  options: {
    fallbackResource?: PaymentResourceInfo;
    serverExtensions?: JsonObject;
  } = {},
): JsonObject {
  const accepted = asObject((payload as { accepted?: unknown }).accepted);
  const next: JsonObject = accepted
    ? {
        ...payload,
        accepted: canonicalizeRequirements(accepted),
      }
    : { ...payload };

  const resource = normalizeResourceInfo(next.resource, options.fallbackResource);
  if (resource) {
    next.resource = resource;
  }

  const extensions = mergeExtensions(next.extensions, options.serverExtensions);
  if (extensions) {
    next.extensions = extensions;
  } else {
    delete next.extensions;
  }

  return next;
}

export async function x402Verify(
  paymentSignature: string,
  facilitatorUrl: string,
  expected: {
    amount: string;
    payTo: string;
    timeoutMs: number;
    paymentRequirements?: PaymentRequirements;
    resource?: PaymentResourceInfo;
    extensions?: JsonObject;
    cdpAuth: CdpAuthLike;
    onVerify: ((payload: JsonObject) => void | boolean | Promise<void | boolean>) | null;
  },
): Promise<VerifyResult> {
  const payload = decodePaymentPayload(paymentSignature);
  if (!payload) return { valid: false, reason: "payload_malformed" };
  if (!looksLikeX402Envelope(payload)) {
    return { valid: false, reason: "envelope_unrecognized" };
  }

  const accepted = asObject((payload as { accepted?: unknown }).accepted);
  if (accepted && expected.paymentRequirements) {
    if (
      accepted.amount !== undefined &&
      accepted.amount !== null &&
      !amountsEqual(accepted.amount, expected.amount)
    ) {
      console.warn(
        `[dual402] x402 accepted amount mismatch got=${sanitizeLogValue(accepted.amount)} want=${expected.amount}`,
      );
      return { valid: false, reason: "accepted_amount_mismatch" };
    }
    if (
      typeof accepted.payTo === "string" &&
      !stringsEqualIgnoreCase(accepted.payTo, expected.payTo)
    ) {
      console.warn(
        `[dual402] x402 accepted payee mismatch got=${maskHex(accepted.payTo)} want=${maskHex(expected.payTo)}`,
      );
      return { valid: false, reason: "accepted_payee_mismatch" };
    }
    if (
      typeof accepted.network === "string" &&
      accepted.network !== expected.paymentRequirements.network
    ) {
      console.warn(
        `[dual402] x402 accepted network mismatch got=${sanitizeLogValue(accepted.network)} want=${expected.paymentRequirements.network}`,
      );
      return { valid: false, reason: "accepted_network_mismatch" };
    }
    if (
      typeof accepted.asset === "string" &&
      !stringsEqualIgnoreCase(accepted.asset, expected.paymentRequirements.asset)
    ) {
      console.warn(
        `[dual402] x402 accepted asset mismatch got=${maskHex(accepted.asset)} want=${maskHex(expected.paymentRequirements.asset)}`,
      );
      return { valid: false, reason: "accepted_asset_mismatch" };
    }
  }

  const paymentAmount = extractPayloadAmount(payload);
  if (paymentAmount === undefined || paymentAmount === null) {
    return { valid: false, reason: "amount_missing" };
  }
  if (!amountsEqual(paymentAmount, expected.amount)) {
    console.warn(
      `[dual402] x402 amount mismatch got=${sanitizeLogValue(paymentAmount)} want=${expected.amount}`,
    );
    return { valid: false, reason: "amount_mismatch" };
  }

  const rawPayee = extractPayloadPayee(payload);
  if (rawPayee === undefined || rawPayee === null || rawPayee === "") {
    return { valid: false, reason: "payee_missing" };
  }
  const got = String(rawPayee).toLowerCase();
  const want = String(expected.payTo).toLowerCase();
  if (got !== want) {
    console.warn(
      `[dual402] x402 payee mismatch got=${maskHex(got)} want=${maskHex(want)}`,
    );
    return { valid: false, reason: "payee_mismatch" };
  }

  const wirePayload = canonicalizePaymentPayload(
    payload,
    {
      fallbackResource:
        expected.resource ?? resourceInfoFromRequirements(expected.paymentRequirements),
      serverExtensions: expected.extensions,
    },
  );
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
    const extensionResponses = parseExtensionResponses(res.headers);

    const valid = data.isValid === true || data.valid === true;
    const rawReason =
      typeof data.invalidReason === "string"
        ? data.invalidReason
        : typeof data.reason === "string"
          ? data.reason
          : undefined;

    if (valid && expected.onVerify) {
      try {
        const hookResult = await expected.onVerify(wirePayload);
        if (hookResult === false) {
          return { valid: false, reason: "rejected_by_hook" };
        }
      } catch (error) {
        console.warn(`[dual402] onVerify hook threw: ${errorMessage(error)}`);
        return { valid: false, reason: "hook_error" };
      }
    }

    return {
      valid,
      reason: valid ? undefined : rawReason ?? "facilitator_rejected",
      txHash: typeof data.txHash === "string" ? data.txHash : undefined,
      payload: valid ? wirePayload : undefined,
      paymentRequirements: valid ? wireRequirements : undefined,
      ...(extensionResponses && { extensionResponses }),
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
  options: {
    resource?: PaymentResourceInfo;
    extensions?: JsonObject;
  } = {},
): Promise<{ txHash?: string; extensionResponses?: JsonObject } & JsonObject> {
  const wirePayload = canonicalizePaymentPayload(payload, {
    fallbackResource:
      options.resource ?? resourceInfoFromRequirements(paymentRequirements),
    serverExtensions: options.extensions,
  });
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
  const extensionResponses = parseExtensionResponses(res.headers);
  return {
    ...data,
    txHash:
      typeof data.transaction === "string"
        ? data.transaction
        : typeof data.txHash === "string"
          ? data.txHash
          : undefined,
    ...(extensionResponses && { extensionResponses }),
  };
}

function parseExtensionResponses(headers: Headers): JsonObject | undefined {
  const value = headers.get("extension-responses");
  if (!value) return undefined;

  try {
    return asObject(JSON.parse(Buffer.from(value, "base64").toString("utf8"))) ?? undefined;
  } catch {
    return undefined;
  }
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
