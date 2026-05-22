import { parseCdpPrivateKey } from "./internal/cdp.js";
import type { Dual402Config, ResolvedX402Config } from "./types.js";

const USDC_BY_NETWORK: Record<string, `0x${string}`> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";
const DEFAULT_FACILITATOR_TIMEOUT_MS = (() => {
  const env = Number.parseInt(process.env.X402_FACILITATOR_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 5_000;
})();

export type ResolvedX402ConfigResult = {
  x402Config: ResolvedX402Config;
  x402Asset: `0x${string}`;
};

export function resolveX402Config(config: Dual402Config): ResolvedX402ConfigResult {
  const x402Asset = config.x402.asset ?? USDC_BY_NETWORK[config.x402.network];
  if (!x402Asset) {
    throw new Error(
      `dual402: no default USDC known for x402.network "${config.x402.network}". ` +
        `Set x402.asset (env X402_ASSET) explicitly, or use one of ${Object.keys(USDC_BY_NETWORK).join(", ")}.`,
    );
  }

  const facilitatorUrl = normalizeFacilitatorUrl(config.x402.facilitatorUrl);
  const facilitatorUrlHost = facilitatorHost(facilitatorUrl);
  if (config.x402.network === "eip155:8453" && facilitatorUrlHost !== CDP_FACILITATOR_HOST) {
    throw new Error(
      `dual402: Base mainnet (x402.network=${config.x402.network}) requires Coinbase's CDP facilitator at ${CDP_FACILITATOR_HOST}, ` +
        `got x402.facilitatorUrl=${JSON.stringify(facilitatorUrl)}. ` +
        "Set X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402 and provide CDP_API_KEY_ID + CDP_API_KEY_SECRET.",
    );
  }
  if (facilitatorUrlHost === CDP_FACILITATOR_HOST && !config.x402.cdpAuth) {
    throw new Error(
      `dual402: x402.cdpAuth is required when x402.facilitatorUrl host is ${CDP_FACILITATOR_HOST}. ` +
        "Set CDP_API_KEY_ID and CDP_API_KEY_SECRET, then pass them as { apiKeyId, apiKeySecret }.",
    );
  }

  const timeoutMs =
    Number.isFinite(config.x402.timeoutMs) && Number(config.x402.timeoutMs) > 0
      ? Number(config.x402.timeoutMs)
      : DEFAULT_FACILITATOR_TIMEOUT_MS;
  const extra =
    config.x402.extra && typeof config.x402.extra === "object"
      ? Object.freeze({ ...config.x402.extra })
      : Object.freeze({ name: "USD Coin", version: "2" });

  let cdpAuth: ResolvedX402Config["cdpAuth"] = null;
  if (config.x402.cdpAuth) {
    const { apiKeyId, apiKeySecret } = config.x402.cdpAuth;
    if (!apiKeyId) {
      throw new Error(
        "dual402: x402.cdpAuth.apiKeyId (env CDP_API_KEY_ID) is required when cdpAuth is set.",
      );
    }
    if (!apiKeySecret) {
      throw new Error(
        "dual402: x402.cdpAuth.apiKeySecret (env CDP_API_KEY_SECRET) is required when cdpAuth is set.",
      );
    }
    try {
      parseCdpPrivateKey(apiKeySecret);
    } catch (error) {
      throw new Error(
        `dual402: x402.cdpAuth.apiKeySecret (env CDP_API_KEY_SECRET) could not be parsed: ${errorMessage(error)}. ` +
          "Accepts a PEM block, a 48-byte PKCS#8 DER blob (base64), or a raw Ed25519 seed (32 or 64 bytes, base64).",
      );
    }
    cdpAuth = Object.freeze({ apiKeyId, apiKeySecret });
  }

  return {
    x402Config: Object.freeze({
      payTo: config.x402.payTo,
      network: config.x402.network,
      asset: x402Asset,
      extra,
      facilitatorUrl,
      timeoutMs,
      cdpAuth,
    }),
    x402Asset,
  };
}

export function assertDual402Config(config: Dual402Config): void {
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
    throw new Error(
      `dual402: missing required config:\n  - ${missing.join("\n  - ")}\n` +
        "Resolve every value through a fail-fast helper at startup (see AGENTS.md).",
    );
  }

  if (String(config.mpp.secretKey).length < 32) {
    throw new Error(
      "dual402: mpp.secretKey must be at least 32 characters (env MPP_SECRET_KEY). " +
        "Generate one with `openssl rand -hex 32`.",
    );
  }
  if (!EVM_ADDR_RE.test(config.mpp.currency)) {
    throw new Error(
      `dual402: mpp.currency (env USDC_TEMPO) must be an EVM token address, got ${JSON.stringify(config.mpp.currency)}. ` +
        "Use the Tempo USDC contract for your target network: testnet 0x20c0...0000, mainnet 0x20c0...e8b50.",
    );
  }
  if (!EVM_ADDR_RE.test(config.mpp.recipient)) {
    throw new Error(
      `dual402: mpp.recipient (env MPP_RECIPIENT) must be an EVM address, got ${JSON.stringify(config.mpp.recipient)}.`,
    );
  }
  if (String(config.x402.network).startsWith("eip155:") && !EVM_ADDR_RE.test(config.x402.payTo)) {
    throw new Error(
      `dual402: x402.payTo must be an EVM address for ${config.x402.network} (env X402_PAYEE_ADDRESS), got ${JSON.stringify(config.x402.payTo)}.`,
    );
  }
  if (config.x402.asset !== undefined && !EVM_ADDR_RE.test(config.x402.asset)) {
    throw new Error(
      `dual402: x402.asset (env X402_ASSET) must be an EVM token address, got ${JSON.stringify(config.x402.asset)}. ` +
        "Leave it unset to use the default USDC for x402.network.",
    );
  }
}

function normalizeFacilitatorUrl(value: string): string {
  const trimmed = String(value ?? "").trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`unsupported protocol ${url.protocol}`);
    }
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    throw new Error(
      `dual402: x402.facilitatorUrl must be an absolute http(s) URL (env X402_FACILITATOR_URL) - ${errorMessage(error)}. ` +
        "Try https://x402.org/facilitator (Sepolia) or https://api.cdp.coinbase.com/platform/v2/x402 (Base mainnet).",
    );
  }
}

function facilitatorHost(value: string): string {
  return new URL(value).host;
}

export function resolveMppRealm(config: Dual402Config): string | undefined {
  const explicit = normalizeRealm(config.mpp.realm || process.env.MPP_REALM);
  if (explicit) return explicit;
  return normalizeRealm(process.env.BASE_URL);
}

function normalizeRealm(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    return new URL(trimmed).host;
  } catch {
    // fall through
  }

  try {
    return new URL(`https://${trimmed}`).host;
  } catch {
    return trimmed.replace(/^\/+|\/+$/g, "");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
