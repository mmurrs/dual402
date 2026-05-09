import assert from "node:assert/strict";
import test from "node:test";

import { Dual402ConfigError, createDual402 } from "../dist/express.js";

import { VALID_CONFIG } from "./_helpers.mjs";

test("non-string description throws invalid_description", () => {
  const dual = createDual402(VALID_CONFIG);
  try {
    dual.charge({ amount: "0.02", description: 42 });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof Dual402ConfigError);
    assert.equal(error.code, "invalid_description");
  }
});

test("non-ASCII descriptions throw invalid_description", () => {
  const dual = createDual402(VALID_CONFIG);
  for (const description of ["Bad — dash", "bad\r\nHeader: value", "naïve", "tab\there"]) {
    try {
      dual.charge({ amount: "0.02", description });
      assert.fail(`expected throw for ${JSON.stringify(description)}`);
    } catch (error) {
      assert.ok(error instanceof Dual402ConfigError);
      assert.equal(error.code, "invalid_description");
    }
  }
});

test("non-string amount throws invalid_amount", () => {
  const dual = createDual402(VALID_CONFIG);
  try {
    dual.charge({ amount: 0.02 });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof Dual402ConfigError);
    assert.equal(error.code, "invalid_amount");
  }
});

test("non-decimal amounts throw invalid_amount", () => {
  const dual = createDual402(VALID_CONFIG);
  for (const amount of ["abc", "-0.02", "0..02", "0.0.2", "$1.00", " 0.02 "]) {
    try {
      dual.charge({ amount });
      assert.fail(`expected throw for ${JSON.stringify(amount)}`);
    } catch (error) {
      assert.ok(error instanceof Dual402ConfigError);
      assert.equal(error.code, "invalid_amount");
    }
  }
});

test("zero amounts throw invalid_amount", () => {
  const dual = createDual402(VALID_CONFIG);
  for (const amount of ["0", "0.0", "0.000000"]) {
    try {
      dual.charge({ amount });
      assert.fail(`expected throw for ${JSON.stringify(amount)}`);
    } catch (error) {
      assert.ok(error instanceof Dual402ConfigError);
      assert.equal(error.code, "invalid_amount");
      assert.match(error.message, /must be > 0/);
    }
  }
});

test("amounts beyond 6 decimals throw invalid_amount with a clear message", () => {
  const dual = createDual402(VALID_CONFIG);
  try {
    dual.charge({ amount: "0.0000001" });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof Dual402ConfigError);
    assert.equal(error.code, "invalid_amount");
    assert.match(error.message, /more than 6 decimal places/);
  }
});

test("amounts at the precision boundary are accepted", () => {
  const dual = createDual402(VALID_CONFIG);
  for (const amount of ["0.000001", "1", "1.0", "1.123456", "999.999999"]) {
    const handler = dual.charge({ amount, description: "boundary" });
    assert.equal(handler._dualAmount, amount);
  }
});
