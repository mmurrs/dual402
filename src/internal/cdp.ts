import crypto from "node:crypto";

const ED25519_PKCS8_DER_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

function ecdsaDerToRaw(der: Buffer): Buffer {
  const rLen = der[3] ?? 0;
  let r = der.subarray(4, 4 + rLen);
  const sLen = der[4 + rLen + 1] ?? 0;
  let s = der.subarray(4 + rLen + 2, 4 + rLen + 2 + sLen);
  if (r.length > 32 && r[0] === 0) r = r.subarray(1);
  if (s.length > 32 && s[0] === 0) s = s.subarray(1);
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length);
  s.copy(out, 64 - s.length);
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse a Coinbase Developer Platform API key secret into a Node `KeyObject`,
 * normalizing across the formats CDP issues:
 *
 * - PEM block (begins with `-----BEGIN`)
 * - PKCS#8 DER (48-byte base64 blob)
 * - Raw Ed25519 seed (32 or 64 bytes, base64-encoded)
 *
 * Throws an `Error` whose message starts with `cdp_key_unrecognized:` when the
 * input does not match any known shape. The message includes the byte length
 * of the decoded blob, which is the most useful diagnostic for "I copy-pasted
 * the wrong field from the CDP portal".
 */
export function parseCdpPrivateKey(secret: string): crypto.KeyObject {
  const trimmed = String(secret).trim();

  if (trimmed.includes("BEGIN")) {
    return crypto.createPrivateKey({ key: trimmed, format: "pem" });
  }

  try {
    return crypto.createPrivateKey(trimmed);
  } catch {
    // fall through to raw handling
  }

  const raw = Buffer.from(trimmed, "base64");
  if (raw.length === 48) {
    try {
      return crypto.createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
    } catch (error) {
      throw new Error(
        `cdp_key_unrecognized: 48-byte base64 blob is not PKCS#8 DER (${errorMessage(error)})`,
      );
    }
  }

  const seed = raw.length === 64 ? raw.subarray(0, 32) : raw.length === 32 ? raw : null;
  if (!seed) {
    throw new Error(
      `cdp_key_unrecognized: expected PEM, PKCS#8 DER (48 bytes), or raw Ed25519 (32/64 bytes); got ${raw.length} bytes`,
    );
  }

  return crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_DER_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/**
 * Sign a short-lived CDP JWT for a single facilitator request. Used by the
 * x402 verify/settle calls when the facilitator is hosted at
 * `api.cdp.coinbase.com`.
 *
 * The token's `uris` claim binds it to one `${requestMethod} ${requestHost}${requestPath}`
 * tuple, so it cannot be replayed against a different endpoint.
 *
 * @internal
 */
export function generateCdpJwt(args: {
  apiKeyId: string;
  apiKeySecret: string;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
  expiresIn?: number;
}): string {
  const {
    apiKeyId,
    apiKeySecret,
    requestMethod,
    requestHost,
    requestPath,
    expiresIn = 120,
  } = args;

  const privateKey = parseCdpPrivateKey(apiKeySecret);
  const keyType = privateKey.asymmetricKeyType;
  const alg =
    keyType === "ed25519" ? "EdDSA" : keyType === "ec" ? "ES256" : null;

  if (!alg) {
    throw new Error(`cdp_jwt_unsupported_key_type:${keyType}`);
  }

  const header = {
    alg,
    typ: "JWT",
    kid: apiKeyId,
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: apiKeyId,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: now,
    exp: now + expiresIn,
    uris: [`${requestMethod} ${requestHost}${requestPath}`],
  };

  const signingInput =
    `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const rawSignature = Buffer.from(
    crypto.sign(
      alg === "EdDSA" ? null : "sha256",
      Buffer.from(signingInput),
      privateKey,
    ),
  );
  const signature =
    alg === "ES256" ? Buffer.from(ecdsaDerToRaw(rawSignature)) : rawSignature;

  return `${signingInput}.${base64url(signature)}`;
}
