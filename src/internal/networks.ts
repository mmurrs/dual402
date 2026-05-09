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
