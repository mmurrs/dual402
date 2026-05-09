import assert from "node:assert/strict";
import test from "node:test";

import { Dual402ConfigError, createDual402 } from "../dist/express.js";

import { VALID_CONFIG } from "./_helpers.mjs";

test("createDual402 throws Dual402ConfigError(missing_required) when required fields are absent", () => {
  try {
    createDual402({ mpp: {}, x402: {} });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof Dual402ConfigError);
    assert.equal(error.code, "missing_required");
    assert.match(error.message, /missing required config/);
  }
});

test("invalid facilitatorUrl throws Dual402ConfigError(invalid_facilitator_url)", () => {
  try {
    createDual402({
      ...VALID_CONFIG,
      x402: { ...VALID_CONFIG.x402, facilitatorUrl: "not-a-url" },
    });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof Dual402ConfigError);
    assert.equal(error.code, "invalid_facilitator_url");
  }
});

test("malformed EVM addresses throw invalid_evm_address (not warn)", () => {
  for (const [field, override] of [
    ["x402.payTo", { x402: { ...VALID_CONFIG.x402, payTo: "0xnothex" } }],
    ["mpp.recipient", { mpp: { ...VALID_CONFIG.mpp, recipient: "0xshort" } }],
    [
      "mpp.currency",
      { mpp: { ...VALID_CONFIG.mpp, currency: "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" } },
    ],
    [
      "x402.asset",
      { x402: { ...VALID_CONFIG.x402, asset: "0x000000000000000000000000000000000000000G" } },
    ],
  ]) {
    try {
      createDual402({ ...VALID_CONFIG, ...override });
      assert.fail(`expected throw for ${field}`);
    } catch (error) {
      assert.ok(error instanceof Dual402ConfigError, `expected Dual402ConfigError for ${field}`);
      assert.equal(error.code, "invalid_evm_address");
      assert.match(error.message, new RegExp(field.replace(".", "\\.")));
    }
  }
});

test("non-CAIP-2 network strings throw invalid_network", () => {
  for (const network of ["base-mainnet", "8453", "EIP155:8453", "eip155 : 8453", ""]) {
    try {
      createDual402({
        ...VALID_CONFIG,
        x402: { ...VALID_CONFIG.x402, network },
      });
      assert.fail(`expected throw for network=${JSON.stringify(network)}`);
    } catch (error) {
      assert.ok(error instanceof Dual402ConfigError);
      const expected = network === "" ? "missing_required" : "invalid_network";
      assert.equal(error.code, expected);
    }
  }
});

test("unknown CAIP-2 namespace warns but does not throw", () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    createDual402({
      ...VALID_CONFIG,
      x402: {
        ...VALID_CONFIG.x402,
        network: "cosmos:cosmoshub-4",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      },
    });
  } finally {
    console.warn = original;
  }
  assert.ok(
    warnings.some((m) => /namespace "cosmos" is unknown/.test(String(m))),
    "expected unknown-namespace warning",
  );
});

test("short secretKey throws weak_secret_key", () => {
  try {
    createDual402({
      ...VALID_CONFIG,
      mpp: { ...VALID_CONFIG.mpp, secretKey: "tooshort" },
    });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof Dual402ConfigError);
    assert.equal(error.code, "weak_secret_key");
    assert.match(error.message, /at least 32/);
  }
});

test("non-string secretKey throws weak_secret_key", () => {
  try {
    createDual402({
      ...VALID_CONFIG,
      mpp: { ...VALID_CONFIG.mpp, secretKey: 12345 },
    });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof Dual402ConfigError);
    assert.equal(error.code, "weak_secret_key");
  }
});

test("CDP-hosted facilitator without cdpAuth throws missing_cdp_auth", () => {
  try {
    createDual402({
      ...VALID_CONFIG,
      x402: {
        ...VALID_CONFIG.x402,
        network: "eip155:8453",
        facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
      },
    });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof Dual402ConfigError);
    assert.equal(error.code, "missing_cdp_auth");
    assert.match(error.message, /cdpAuth/);
  }
});

test("Base mainnet with x402.org facilitator emits a warning (not a throw)", () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    createDual402({
      ...VALID_CONFIG,
      x402: {
        ...VALID_CONFIG.x402,
        network: "eip155:8453",
        facilitatorUrl: "https://x402.org/facilitator",
      },
    });
  } finally {
    console.warn = original;
  }
  assert.ok(
    warnings.some((m) => /public x402.org facilitator/.test(String(m))),
    "expected mainnet/x402.org warning",
  );
});

test("cdpAuth with malformed key throws invalid_cdp_auth", () => {
  try {
    createDual402({
      ...VALID_CONFIG,
      x402: {
        ...VALID_CONFIG.x402,
        network: "eip155:8453",
        facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
        cdpAuth: { apiKeyId: "k", apiKeySecret: "not-a-real-key" },
      },
    });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof Dual402ConfigError);
    assert.equal(error.code, "invalid_cdp_auth");
  }
});

test("unknown network without explicit asset throws unknown_network_asset", () => {
  try {
    createDual402({
      ...VALID_CONFIG,
      x402: { ...VALID_CONFIG.x402, network: "eip155:999999" },
    });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof Dual402ConfigError);
    assert.equal(error.code, "unknown_network_asset");
  }
});
