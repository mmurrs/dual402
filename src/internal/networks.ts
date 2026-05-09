/**
 * Network metadata: known USDC contracts. Update this file when adding default
 * support for a new chain.
 */

/** USDC contract address per CAIP-2 chain id. Used as the default `x402.asset`. */
export const USDC_BY_NETWORK: Record<string, `0x${string}`> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum mainnet
};

/** CAIP-2 chain ids that are mainnet (real money) — used to gate facilitator checks. */
export const KNOWN_MAINNETS = new Set([
  "eip155:1", // Ethereum
  "eip155:8453", // Base
  "eip155:137", // Polygon
  "eip155:42161", // Arbitrum
]);

/** Host of the Coinbase Developer Platform x402 facilitator. */
export const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";

/** Host of the public x402.org facilitator (Base Sepolia only). */
export const X402_PUBLIC_TESTNET_HOST = "x402.org";
