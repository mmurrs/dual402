/**
 * Shared types used across dual402 internals. Public-facing types live in the
 * top-level files (charge.ts, config.ts, discovery.ts, errors.ts) and are
 * re-exported from express.ts.
 */

/** A plain JSON object — `{ [k]: unknown }`, never an array. */
export type JsonObject = Record<string, unknown>;

/** JSON Schema object (draft 2020-12 recommended) used for request/response hints in discovery. */
export type JsonSchema = Record<string, unknown>;

/** Canonical wire form of an x402 `accepts` entry. */
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

/** Result of {@link x402Verify}. `payload` and `paymentRequirements` are only set when `valid` is true. */
export type VerifyResult = {
  valid: boolean;
  reason?: string;
  txHash?: string;
  payload?: JsonObject;
  paymentRequirements?: JsonObject;
};

/** Frozen CDP credentials passed to the wire layer. `null` when no CDP auth is configured. */
export type CdpAuthLike = Readonly<{
  apiKeyId: string;
  apiKeySecret: string;
}> | null;
