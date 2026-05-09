/**
 * Facilitator-side x402 verify and settle. Local fail-closed checks (amount,
 * payee, network, asset, optional onVerify hook) run *before* any network call
 * so the facilitator never sees obviously bad payloads.
 */

import { generateCdpJwt } from "./cdp.js";
import type { CdpAuthLike, JsonObject, PaymentRequirements, VerifyResult } from "./types.js";
import {
  amountsEqual,
  asObject,
  errorMessage,
  maskHex,
  sanitizeLogValue,
  stringsEqualIgnoreCase,
} from "./utils.js";

const MAX_SIGNATURE_BYTES = 16 * 1024;
const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";

/** Optional hook a caller can install to reject payments after envelope checks. */
export type OnVerifyHook =
  | ((payload: JsonObject) => void | boolean | Promise<void | boolean>)
  | null;

/** All inputs needed by {@link x402Verify} besides the raw signature header. */
export type VerifyContext = {
  amount: string;
  payTo: string;
  timeoutMs: number;
  paymentRequirements?: PaymentRequirements;
  cdpAuth: CdpAuthLike;
  onVerify: OnVerifyHook;
};

/**
 * Verify an x402 payment payload. Runs strict local checks first (amount, payee,
 * network, asset) and only calls the facilitator when those pass.
 */
export async function x402Verify(
  paymentSignature: string,
  facilitatorUrl: string,
  expected: VerifyContext,
): Promise<VerifyResult> {
  const payload = decodePaymentPayload(paymentSignature);
  if (!payload) return { valid: false, reason: "payload_malformed" };
  if (!looksLikeX402Envelope(payload)) {
    return { valid: false, reason: "envelope_unrecognized" };
  }

  const acceptedCheck = compareAcceptedToExpected(payload, expected);
  if (acceptedCheck) return acceptedCheck;

  const amountCheck = comparePayloadAmount(payload, expected.amount);
  if (amountCheck) return amountCheck;

  const payeeCheck = comparePayloadPayee(payload, expected.payTo);
  if (payeeCheck) return payeeCheck;

  const selfTransferCheck = checkSelfTransfer(payload, expected.payTo);
  if (selfTransferCheck) return selfTransferCheck;

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
      reason: valid ? undefined : (rawReason ?? "facilitator_rejected"),
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

/** Settle a previously-verified x402 payment. Throws on facilitator failure. */
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

function looksLikeX402Envelope(payload: JsonObject): boolean {
  const p = payload as Record<string, unknown>;
  if ("signature" in p || "authorization" in p || "scheme" in p) return true;
  const nested = asObject(p.payload);
  return !!nested && ("signature" in nested || "authorization" in nested);
}

function extractPayloadAmount(payload: JsonObject): unknown {
  const p = payload as Record<string, unknown>;
  const inner = asObject(p.payload);
  const innerAuth = inner ? asObject(inner.authorization) : null;
  const directAuth = asObject(p.authorization);
  return (
    innerAuth?.value ??
    directAuth?.value ??
    inner?.amount ??
    p.amount ??
    p.value
  );
}

function extractPayloadFrom(payload: JsonObject): unknown {
  const p = payload as Record<string, unknown>;
  const inner = asObject(p.payload);
  const innerAuth = inner ? asObject(inner.authorization) : null;
  const directAuth = asObject(p.authorization);
  return innerAuth?.from ?? directAuth?.from ?? p.from;
}

function extractPayloadPayee(payload: JsonObject): unknown {
  const p = payload as Record<string, unknown>;
  const inner = asObject(p.payload);
  const innerAuth = inner ? asObject(inner.authorization) : null;
  const directAuth = asObject(p.authorization);
  return (
    innerAuth?.to ??
    directAuth?.to ??
    inner?.payTo ??
    p.payTo ??
    p.to
  );
}

function compareAcceptedToExpected(
  payload: JsonObject,
  expected: VerifyContext,
): VerifyResult | null {
  const accepted = asObject(payload.accepted);
  if (!accepted || !expected.paymentRequirements) return null;

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

  return null;
}

function comparePayloadAmount(payload: JsonObject, expectedAmount: string): VerifyResult | null {
  const paymentAmount = extractPayloadAmount(payload);
  if (paymentAmount === undefined || paymentAmount === null) return null;
  if (!amountsEqual(paymentAmount, expectedAmount)) {
    console.warn(
      `[dual402] x402 amount mismatch got=${sanitizeLogValue(paymentAmount)} want=${expectedAmount}`,
    );
    return { valid: false, reason: "amount_mismatch" };
  }
  return null;
}

function comparePayloadPayee(payload: JsonObject, expectedPayTo: string): VerifyResult | null {
  const rawPayee = extractPayloadPayee(payload);
  if (rawPayee === undefined || rawPayee === null || rawPayee === "") return null;
  if (!stringsEqualIgnoreCase(rawPayee, expectedPayTo)) {
    console.warn(
      `[dual402] x402 payee mismatch got=${maskHex(rawPayee)} want=${maskHex(expectedPayTo)}`,
    );
    return { valid: false, reason: "payee_mismatch" };
  }
  return null;
}

function checkSelfTransfer(payload: JsonObject, expectedPayTo: string): VerifyResult | null {
  const from = extractPayloadFrom(payload);
  if (typeof from !== "string" || from === "") return null;
  if (stringsEqualIgnoreCase(from, expectedPayTo)) {
    console.warn(
      `[dual402] x402 self-transfer detected from=${maskHex(from)} payTo=${maskHex(expectedPayTo)}`,
    );
    return { valid: false, reason: "self_transfer" };
  }
  return null;
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
