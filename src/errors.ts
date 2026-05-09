/**
 * Public error class for invalid configuration. Caught and re-emitted by
 * {@link createDual402} and {@link Dual402Instance.charge}.
 */

/**
 * Stable error codes thrown for invalid configuration. Pattern-match on
 * `error.code` (rather than `error.message`) so phrasing changes don't break
 * consumer error handling.
 */
export type Dual402ConfigErrorCode =
  | "missing_required"
  | "invalid_evm_address"
  | "invalid_network"
  | "invalid_facilitator_url"
  | "weak_secret_key"
  | "missing_cdp_auth"
  | "invalid_cdp_auth"
  | "invalid_amount"
  | "invalid_description"
  | "unknown_network_asset";

/**
 * Thrown by {@link createDual402} and {@link Dual402Instance.charge} when
 * configuration fails validation. Has a stable `.code` for programmatic
 * handling and a human-readable `.message` for logs.
 */
export class Dual402ConfigError extends Error {
  readonly code: Dual402ConfigErrorCode;

  constructor(code: Dual402ConfigErrorCode, message: string) {
    super(message);
    this.name = "Dual402ConfigError";
    this.code = code;
  }
}
