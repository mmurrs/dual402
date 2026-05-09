/**
 * Pure helpers with no side effects (other than reading `process.env.BASE_URL`
 * inside {@link resolveBaseUrl}, which is documented).
 */

import type { Request } from "express";

import type { JsonObject } from "./types.js";

/** Base64-encode a JSON-serializable value. Used for `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` headers. */
export function base64Json(data: unknown): string {
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

/** Narrow `unknown` to a non-array object, returning `null` otherwise. */
export function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/** Extract a string message from any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Truncate a value for safe logging. Stringifies non-strings with `JSON.stringify`. */
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
 * Shorten a hex string for safe logging. `0xabc...1234` by default.
 * Use for payer/wallet addresses and tx hashes in public logs.
 */
export function maskHex(
  value: unknown,
  { head = 6, tail = 4 }: { head?: number; tail?: number } = {},
): string {
  const str = String(value ?? "");
  if (str.length <= head + tail) return str;
  return `${str.slice(0, head)}...${str.slice(-tail)}`;
}

/**
 * Public-facing base URL for resource links in challenges. Honors
 * `process.env.BASE_URL` first (recommended behind a proxy / custom domain),
 * then falls back to the inbound request's `Host` header.
 */
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

/**
 * Convert a decimal string amount (e.g. `"0.02"`) to its smallest-unit integer
 * string (e.g. `"20000"` for 6 decimals). Throws on bad input or precision loss.
 */
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

/** Strict BigInt coercion that rejects floats and negative values. */
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

/** True iff both values represent the same non-negative integer. Returns `false` on bad input. */
export function amountsEqual(left: unknown, right: unknown): boolean {
  try {
    return toBigIntStrict(left) === toBigIntStrict(right);
  } catch {
    return false;
  }
}

/** Case-insensitive string equality, with type narrowing on the inputs. */
export function stringsEqualIgnoreCase(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return left.toLowerCase() === right.toLowerCase();
}
