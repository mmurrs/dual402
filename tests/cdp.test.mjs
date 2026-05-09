import crypto from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { parseCdpPrivateKey } from "../dist/express.js";

test("parseCdpPrivateKey accepts PEM-encoded Ed25519", () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const parsed = parseCdpPrivateKey(pem);
  assert.equal(parsed.asymmetricKeyType, "ed25519");
});

test("parseCdpPrivateKey accepts PKCS#8 DER (48-byte base64)", () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  assert.equal(der.length, 48, "Ed25519 PKCS#8 DER is 48 bytes");
  const parsed = parseCdpPrivateKey(der.toString("base64"));
  assert.equal(parsed.asymmetricKeyType, "ed25519");
});

test("parseCdpPrivateKey accepts a raw 32-byte seed", () => {
  const seed = crypto.randomBytes(32);
  const parsed = parseCdpPrivateKey(seed.toString("base64"));
  assert.equal(parsed.asymmetricKeyType, "ed25519");
});

test("parseCdpPrivateKey accepts a 64-byte seed||public concat by taking the first 32 bytes", () => {
  const seed = crypto.randomBytes(32);
  const pub = crypto.randomBytes(32);
  const parsed = parseCdpPrivateKey(Buffer.concat([seed, pub]).toString("base64"));
  assert.equal(parsed.asymmetricKeyType, "ed25519");
});

test("parseCdpPrivateKey rejects truly bad input with cdp_key_unrecognized", () => {
  assert.throws(
    () => parseCdpPrivateKey("not-a-real-key"),
    /cdp_key_unrecognized/,
  );
  assert.throws(
    () => parseCdpPrivateKey(Buffer.alloc(7).toString("base64")),
    /cdp_key_unrecognized/,
  );
});

test("parseCdpPrivateKey accepts ECDSA P-256 PEM", () => {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const parsed = parseCdpPrivateKey(pem);
  assert.equal(parsed.asymmetricKeyType, "ec");
});
