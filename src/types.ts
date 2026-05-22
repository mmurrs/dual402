import type { RequestHandler } from "express";

import type { JsonObject, JsonSchema } from "./internal/x402.js";

/** MPP (Tempo USDC) configuration. Passed to `createDual402` as `mpp`. */
export type MppConfig = {
  /**
   * Tempo USDC token contract address.
   * - Mainnet: `0x20c000000000000000000000b9537d11c60e8b50`
   * - Testnet: `0x20c0000000000000000000000000000000000000`
   *
   * Must align with `testnet` - mixing them will fail when mppx tries to settle.
   */
  currency: `0x${string}`;
  /** EVM address that receives MPP payments. Must not equal any wallet you use to test paying - self-transfers fail on common facilitators. */
  recipient: `0x${string}`;
  /** HMAC key used by mppx to bind challenges to this server. 32+ random bytes; generate with `openssl rand -hex 32`. */
  secretKey: string;
  /** Hostname advertised in MPP `WWW-Authenticate` challenges. Defaults to the request `Host` header, then `BASE_URL`. Set explicitly when running behind a proxy. */
  realm?: string;
  /** Use Tempo testnet (chain 42431) instead of mainnet (chain 4217). Default `false`. */
  testnet?: boolean;
};

/**
 * Coinbase Developer Platform credentials for the CDP-hosted x402 facilitator.
 * Required when `x402.facilitatorUrl` resolves to `api.cdp.coinbase.com`,
 * which is the case for Base mainnet.
 */
export type CdpAuth = {
  /** UUID from `portal.cdp.coinbase.com`, or the full `organizations/.../apiKeys/...` path. */
  apiKeyId: string;
  /**
   * The CDP private key. Accepts any of the formats CDP issues:
   * - PEM block (begins with `-----BEGIN`)
   * - 48-byte PKCS#8 DER blob, base64-encoded
   * - Raw Ed25519 seed (32 or 64 bytes, base64-encoded)
   *
   * Treated as a secret; never logged.
   */
  apiKeySecret: string;
};

/** x402 (EVM USDC) configuration. Passed to `createDual402` as `x402`. */
export type X402Config = {
  /** EVM address that receives x402 payments. Must not equal any wallet you use to test paying. */
  payTo: `0x${string}`;
  /**
   * CAIP-2 chain ID.
   * - Base mainnet: `"eip155:8453"`
   * - Base Sepolia: `"eip155:84532"`
   * - Ethereum mainnet: `"eip155:1"`
   *
   * Anything else needs an explicit `asset` because dual402 only ships the
   * default USDC for the chains above.
   */
  network: string;
  /**
   * Facilitator `/verify` + `/settle` endpoint.
   * - Base mainnet: `"https://api.cdp.coinbase.com/platform/v2/x402"` - requires `cdpAuth`.
   * - Base Sepolia: `"https://x402.org/facilitator"`.
   *
   * Pointing Base mainnet at the Sepolia host throws at startup.
   */
  facilitatorUrl: string;
  /** USDC contract address. Defaults to the known USDC for `network`; set explicitly to use a different stablecoin. */
  asset?: `0x${string}`;
  /** EIP-712 domain for the asset. Defaults to `{ name: "USD Coin", version: "2" }` - only override if the user explicitly knows the asset's domain differs. */
  extra?: { name: string; version: string };
  /** Facilitator fetch timeout in ms. Default `5000`. Overridable at process scope via the `X402_FACILITATOR_TIMEOUT_MS` env var. */
  timeoutMs?: number;
  /** CDP credentials. Required when `facilitatorUrl` host is `api.cdp.coinbase.com`. */
  cdpAuth?: CdpAuth;
};

/** Full configuration for `createDual402`. */
export type Dual402Config = {
  mpp: MppConfig;
  x402: X402Config;
  /**
   * Optional hook called after the facilitator's `/verify` succeeds but before
   * `/settle` or `next()`. Return `false` to reject the payment. Useful for
   * replay protection (track payer + nonce) or per-caller policy.
   *
   * The `payload` parameter is the canonicalized x402 payment payload - the
   * same shape sent to the facilitator's `/verify`. It carries the payer
   * (`payload.authorization.from`), the route's resource URL, and the nonce.
   */
  onVerify?: OnVerify;
};

export type OnVerify = (
  payload: JsonObject,
  ctx: { route: string; amount: string },
) => void | boolean | Promise<void | boolean>;

/** Per-route options for `Dual402Instance.charge`. */
export type ChargeOptions = {
  /** Price in USDC as a decimal string, e.g. `"0.02"` for two cents. Pass a string, not a number, to avoid float drift. */
  amount: string;
  /** Human-readable description shown in the MPP `WWW-Authenticate` header. Printable ASCII only - em-dashes and smart quotes throw at config time. */
  description?: string;
  /** Block on x402 settlement before returning the response. Default `true`. Set `false` only on low-value routes where you accept a settle failure after the response was sent. */
  waitForSettle?: boolean;
};

/** Options for `paidRoute`. Combines OpenAPI route metadata with a per-route price. */
export type PaidRouteOptions = Omit<DiscoveryRoute, "handler"> & {
  /** Price in USDC as a decimal string, e.g. `"0.02"` for two cents. Pass a string, not a number, to avoid float drift. */
  amount: string;
  /** Short payment challenge description shown in the MPP `WWW-Authenticate` header. Defaults to `summary`. Printable ASCII only. */
  paymentDescription?: string;
  /** Block on x402 settlement before returning the response. Default `true`. */
  waitForSettle?: boolean;
};

/**
 * One paid route, as described to `dualDiscovery`. The `handler` must be the same
 * charge middleware passed to `app.get(...)` / `app.post(...)` - the discovery layer reads
 * amount/description metadata off it.
 */
export type DiscoveryRoute = {
  /** HTTP method, lowercase. */
  method: string;
  /** Absolute path starting with `/`. */
  path: string;
  /** Middleware returned by `Dual402Instance.charge`. */
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

/** Config for `dualDiscovery`. */
export type DiscoveryConfig = {
  /** OpenAPI `info` block. */
  info?: {
    title: string;
    description: string;
    version: string;
    /** Free-form guidance for agent clients - e.g. worked examples, which route to pick when. */
    "x-guidance"?: string;
  };
  /** Additional `info.x-service` metadata (categories, keywords) for aggregator discovery. */
  serviceInfo?: Record<string, unknown>;
  /** Service name surfaced in Bazaar-style x402 discovery. Defaults to `info.title`. */
  serviceName?: string;
  /** Service-level tags surfaced in Bazaar-style x402 discovery. Route tags are merged with these. */
  tags?: string[];
  /** Optional service icon URL surfaced in Bazaar-style x402 discovery. */
  iconUrl?: string;
  /** Optional array of signed proofs that this service owns the advertised wallets. */
  ownershipProofs?: JsonObject[];
  /** Every paid route the service exposes. */
  routes: DiscoveryRoute[];
};

/** @internal Shared handler shape used by charge middleware and discovery metadata. */
export type DualChargeHandler = RequestHandler & {
  _dualAmount?: string;
  _dualDescription?: string;
  _dualInputSchema?: JsonSchema;
  _dualOutputSchema?: JsonSchema;
  _dualInputSchemasByMethod?: Record<string, JsonSchema>;
  _dualOutputSchemasByMethod?: Record<string, JsonSchema>;
  _dualInputSchemasByRoute?: Record<string, JsonSchema>;
  _dualOutputSchemasByRoute?: Record<string, JsonSchema>;
  _dualServiceName?: string;
  _dualTags?: string[];
  _dualTagsByRoute?: Record<string, string[]>;
  _dualIconUrl?: string;
};

/** @internal Resolved MPP config after startup validation. */
export type ResolvedMppConfig = Readonly<{
  currency: `0x${string}`;
  recipient: `0x${string}`;
  testnet: boolean;
}>;

/** @internal Resolved x402 config after startup validation. */
export type ResolvedX402Config = Readonly<{
  payTo: `0x${string}`;
  network: string;
  asset: `0x${string}`;
  extra: Readonly<{ name: string; version: string }>;
  facilitatorUrl: string;
  timeoutMs: number;
  cdpAuth: Readonly<CdpAuth> | null;
}>;

/**
 * The object returned by `createDual402`. The only public method is `charge`,
 * which mints per-route middleware. Most apps should reach for `paidRoute`
 * instead so the charge handler and the OpenAPI metadata stay aligned.
 */
export type Dual402Instance = {
  /**
   * Mint Express middleware for one paid route. The same middleware verifies
   * x402 credentials (via the configured facilitator) and MPP credentials
   * (via mppx), and emits a 402 with both challenges when none is present.
   */
  charge(options: ChargeOptions): DualChargeHandler;
  /** @internal The underlying mppx instance. Prefer the public `charge()` API. */
  _mppx: any;
  /** @internal Resolved MPP config after defaults and validation. */
  _mppConfig: ResolvedMppConfig;
  /** @internal Resolved x402 config after defaults and validation. */
  _x402Config: ResolvedX402Config;
  /** @internal Resolved USDC contract address. */
  _x402Asset: string;
};
