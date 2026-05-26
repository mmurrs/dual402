/**
 * dual402
 *
 * Public entrypoint for the Express middleware that gates routes behind both
 * x402 (Base USDC, via a facilitator) and MPP (Tempo USDC, via mppx).
 *
 * Three public functions:
 *
 * - `createDual402` validates config and creates a `Dual402Instance`.
 * - `paidRoute` creates Express middleware plus OpenAPI metadata for one route.
 * - `dualDiscovery` mounts `GET /openapi.json` and `GET /.well-known/x402`.
 */

import { Mppx, tempo } from "mppx/express";

import { createChargeFactory } from "./charge.js";
import {
  assertDual402Config,
  resolveMppRealm,
  resolveX402Config,
} from "./config.js";
export { dualDiscovery, paidRoute } from "./discovery.js";
export type { JsonSchema } from "./internal/x402.js";
export { maskHex } from "./internal/x402.js";
export { parseCdpPrivateKey } from "./internal/cdp.js";
export type {
  CdpAuth,
  BazaarBodyType,
  BazaarRouteMetadata,
  ChargeOptions,
  DiscoveryConfig,
  DiscoveryRoute,
  Dual402Config,
  Dual402Instance,
  MppConfig,
  PaidRouteOptions,
  X402Config,
} from "./types.js";
import type { Dual402Config, Dual402Instance } from "./types.js";

/**
 * Validate the dual402 config and return an instance. Fails fast at startup for
 * misconfigurations that would cost money in production: pointing Base mainnet
 * at a testnet facilitator, missing CDP credentials when the facilitator host
 * is `api.cdp.coinbase.com`, an unparseable `CDP_API_KEY_SECRET`, an unknown
 * USDC for `x402.network`, or an MPP secret shorter than 32 characters.
 *
 * @example
 * ```ts
 * const dual = createDual402({
 *   mpp: {
 *     currency: process.env.USDC_TEMPO,
 *     recipient: process.env.MPP_RECIPIENT,
 *     secretKey: process.env.MPP_SECRET_KEY,
 *   },
 *   x402: {
 *     payTo: process.env.X402_PAYEE_ADDRESS,
 *     network: "eip155:8453",
 *     facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
 *     cdpAuth: {
 *       apiKeyId: process.env.CDP_API_KEY_ID,
 *       apiKeySecret: process.env.CDP_API_KEY_SECRET,
 *     },
 *   },
 * });
 *
 * const chargeQuote = dual.charge({ amount: "0.02", description: "Quote lookup" });
 * app.get("/quote", chargeQuote, (req, res) => res.json({ price: 42 }));
 * ```
 */
export function createDual402(config: Dual402Config): Dual402Instance {
  assertDual402Config(config);
  const mppRealm = resolveMppRealm(config);
  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        currency: config.mpp.currency,
        recipient: config.mpp.recipient,
        ...(config.mpp.testnet && { testnet: true }),
      }),
    ],
    secretKey: config.mpp.secretKey,
    ...(mppRealm && { realm: mppRealm }),
  });
  const { x402Config, x402Asset } = resolveX402Config(config);

  return {
    _mppx: mppx,
    _mppConfig: Object.freeze({
      currency: config.mpp.currency,
      recipient: config.mpp.recipient,
      testnet: config.mpp.testnet === true,
    }),
    _x402Config: x402Config,
    _x402Asset: x402Asset,
    charge: createChargeFactory({
      mppx,
      x402Config,
      getOnVerify: () => config.onVerify,
    }),
  };
}
