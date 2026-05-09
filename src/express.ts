/**
 * dual402 — Express middleware that accepts both x402 (Coinbase, EVM USDC) and
 * MPP (Tempo USDC) payments on every route. Public entrypoint: re-exports the
 * full surface from the focused modules in this package.
 *
 * @see {@link createDual402} to wire up the dual-protocol handler.
 * @see {@link dualDiscovery} to mount `/openapi.json` and `/.well-known/x402`.
 */

export { createDual402 } from "./charge.js";
export type {
  ChargeOptions,
  Dual402Instance,
  DualChargeHandler,
} from "./charge.js";

export { dualDiscovery } from "./discovery.js";
export type { DiscoveryConfig, DiscoveryRoute } from "./discovery.js";

export type {
  CdpAuth,
  Dual402Config,
  MppConfig,
  ResolvedX402Config,
  X402Config,
} from "./config.js";

export { Dual402ConfigError } from "./errors.js";
export type { Dual402ConfigErrorCode } from "./errors.js";

export type { JsonSchema } from "./internal/types.js";
export { maskHex } from "./internal/utils.js";
export { parseCdpPrivateKey } from "./internal/cdp.js";
