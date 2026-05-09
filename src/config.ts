/**
 * Public configuration types and the {@link assertConfig} validator. Keeps
 * the user-facing shape definitions away from the runtime code in charge.ts
 * so consumers can read the contract in one place.
 */

import { Dual402ConfigError } from "./errors.js";
import {
  CDP_FACILITATOR_HOST,
  KNOWN_MAINNETS,
  X402_PUBLIC_TESTNET_HOST,
} from "./internal/networks.js";
import type { JsonObject } from "./internal/types.js";
import { errorMessage } from "./internal/utils.js";

/** MPP (Tempo USDC) configuration — passed to {@link createDual402}. */
export type MppConfig = {
  /** Tempo USDC token contract address. Mainnet `0x20C0...E8b50`, testnet `0x20c0...0000`. */
  currency: `0x${string}`;
  /** EVM address that receives MPP payments. Must not equal the payer's wallet. */
  recipient: `0x${string}`;
  /** HMAC key used by mppx to sign/verify payment challenges. 32+ random bytes. */
  secretKey: string;
  /** Hostname advertised in MPP `WWW-Authenticate` challenges. Defaults to the request host; set when behind a proxy. */
  realm?: string;
  /** Use Tempo testnet (chain 42431) instead of mainnet (chain 4217). */
  testnet?: boolean;
};

/** Coinbase Developer Platform credentials for the CDP-hosted x402 facilitator. Required on Base mainnet. */
export type CdpAuth = {
  /** UUID from portal.cdp.coinbase.com (or `organizations/.../apiKeys/...` path). */
  apiKeyId: string;
  /** Base64 Ed25519 key or PEM block. Keep out of logs. */
  apiKeySecret: string;
};

/** x402 (EVM USDC) configuration — passed to {@link createDual402}. */
export type X402Config = {
  /** EVM address that receives x402 payments. Must not equal the payer's wallet. */
  payTo: `0x${string}`;
  /** CAIP-2 chain ID. `eip155:8453` for Base mainnet, `eip155:84532` for Base Sepolia. */
  network: string;
  /** Facilitator `/verify` + `/settle` endpoint. Mainnet: `https://api.cdp.coinbase.com/platform/v2/x402` (needs `cdpAuth`). */
  facilitatorUrl: string;
  /** USDC contract address. Defaults to the known USDC for `network` if unset. */
  asset?: `0x${string}`;
  /** EIP-712 domain for the asset. Defaults to `{ name: "USD Coin", version: "2" }` — do not override unless you know what you're doing. */
  extra?: { name: string; version: string };
  /** Facilitator fetch timeout in ms. Default 5000, override via `X402_FACILITATOR_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** CDP credentials. Required when `facilitatorUrl` is CDP-hosted. */
  cdpAuth?: CdpAuth;
};

/** Full configuration for {@link createDual402}. */
export type Dual402Config = {
  mpp: MppConfig;
  x402: X402Config;
  /**
   * Optional hook called after envelope checks pass but before `next()`.
   * Return `false` to reject the payment; useful for replay protection or per-caller policy.
   */
  onVerify?: (
    payload: JsonObject,
    ctx: { route: string; amount: string },
  ) => void | boolean | Promise<void | boolean>;
};

/** Resolved x402 config after defaults are applied. Frozen and used internally. */
export type ResolvedX402Config = Readonly<{
  payTo: `0x${string}`;
  network: string;
  asset: `0x${string}`;
  extra: Readonly<{ name: string; version: string }>;
  facilitatorUrl: string;
  timeoutMs: number;
  cdpAuth: Readonly<CdpAuth> | null;
}>;

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const CAIP2_RE = /^[a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const KNOWN_CAIP2_NAMESPACES = new Set(["eip155", "solana"]);
const MIN_SECRET_KEY_LENGTH = 32;

/** Validate that the user-supplied {@link Dual402Config} has all required fields. */
export function assertConfig(config: Dual402Config): void {
  const missing: string[] = [];
  if (!config?.mpp?.secretKey) missing.push("mpp.secretKey (env MPP_SECRET_KEY)");
  if (!config?.mpp?.currency) missing.push("mpp.currency (env USDC_TEMPO)");
  if (!config?.mpp?.recipient) missing.push("mpp.recipient (env MPP_RECIPIENT)");
  if (!config?.x402?.payTo) missing.push("x402.payTo (env X402_PAYEE_ADDRESS)");
  if (!config?.x402?.network) missing.push("x402.network (env X402_NETWORK)");
  if (!config?.x402?.facilitatorUrl) {
    missing.push("x402.facilitatorUrl (env X402_FACILITATOR_URL)");
  }

  if (missing.length > 0) {
    throw new Dual402ConfigError(
      "missing_required",
      `dual402: missing required config:\n  - ${missing.join("\n  - ")}\n` +
        "Create a .env from your example values before booting.",
    );
  }

  assertEvmAddress("x402.payTo", config.x402.payTo);
  assertEvmAddress("mpp.recipient", config.mpp.recipient);
  assertEvmAddress("mpp.currency", config.mpp.currency);
  if (config.x402.asset !== undefined) {
    assertEvmAddress("x402.asset", config.x402.asset);
  }

  assertCaip2Network(config.x402.network);
  assertSecretKey(config.mpp.secretKey);
}

function assertCaip2Network(network: string): void {
  if (!CAIP2_RE.test(network)) {
    throw new Dual402ConfigError(
      "invalid_network",
      `dual402: x402.network "${network}" is not a valid CAIP-2 chain id ` +
        `(expected something like "eip155:8453").`,
    );
  }
  const namespace = network.split(":")[0];
  if (!KNOWN_CAIP2_NAMESPACES.has(namespace)) {
    console.warn(
      `[dual402] x402.network namespace "${namespace}" is unknown to dual402; ` +
        "the facilitator may not support it.",
    );
  }
}

function assertSecretKey(secretKey: unknown): void {
  if (typeof secretKey !== "string") {
    throw new Dual402ConfigError(
      "weak_secret_key",
      `dual402: mpp.secretKey must be a string — got ${typeof secretKey}.`,
    );
  }
  if (secretKey.length < MIN_SECRET_KEY_LENGTH) {
    throw new Dual402ConfigError(
      "weak_secret_key",
      `dual402: mpp.secretKey is too short (${secretKey.length} chars, need at least ${MIN_SECRET_KEY_LENGTH}). ` +
        "Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`.",
    );
  }
}

/** Throw {@link Dual402ConfigError} if `value` isn't a 0x-prefixed 40-hex address. */
export function assertEvmAddress(field: string, value: string): void {
  if (!EVM_ADDR_RE.test(value)) {
    throw new Dual402ConfigError(
      "invalid_evm_address",
      `dual402: ${field} "${value}" is not a valid 0x-prefixed 40-hex EVM address.`,
    );
  }
}

/**
 * Cross-check the facilitator host against the configured network. Throws if a
 * CDP-hosted facilitator is used without `cdpAuth`; warns if a known mainnet is
 * paired with the public testnet facilitator (which would silently fail at verify).
 */
export function assertFacilitatorMatchesNetwork(
  facilitatorUrl: string,
  network: string,
  cdpAuth: CdpAuth | undefined,
): void {
  let host = "";
  try {
    host = new URL(facilitatorUrl).host.toLowerCase();
  } catch {
    return;
  }

  if (host === CDP_FACILITATOR_HOST && !cdpAuth) {
    throw new Dual402ConfigError(
      "missing_cdp_auth",
      `dual402: facilitatorUrl is CDP-hosted (${CDP_FACILITATOR_HOST}) but x402.cdpAuth is not set. ` +
        "Provide CDP_API_KEY_ID and CDP_API_KEY_SECRET, or use a non-CDP facilitator.",
    );
  }

  if (KNOWN_MAINNETS.has(network) && host === X402_PUBLIC_TESTNET_HOST) {
    console.warn(
      `[dual402] facilitatorUrl host "${host}" is the public x402.org facilitator, ` +
        `which only supports Base Sepolia, but x402.network "${network}" is a mainnet. ` +
        "Switch to api.cdp.coinbase.com (with cdpAuth) or a mainnet-capable facilitator.",
    );
  }
}

/** Parse, normalize, and validate the facilitator URL. Throws on bad protocol or shape. */
export function normalizeFacilitatorUrl(value: string): string {
  const trimmed = String(value ?? "").trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`unsupported protocol ${url.protocol}`);
    }
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    throw new Dual402ConfigError(
      "invalid_facilitator_url",
      `dual402: x402.facilitatorUrl must be an absolute http(s) URL: ${errorMessage(error)}`,
    );
  }
}
