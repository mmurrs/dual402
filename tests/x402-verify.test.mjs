import crypto from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { createDual402 } from "../dist/express.js";

import {
  VALID_CONFIG,
  decodeBase64Json,
  encodeSignature,
  fakeFetchResponse,
  headerValue,
  makeReq,
  makeRes,
  runHandler,
  withFetch,
} from "./_helpers.mjs";

function authorizationPayload(overrides = {}) {
  return {
    payload: {
      authorization: {
        from: "0x1111111111111111111111111111111111111111",
        to: VALID_CONFIG.x402.payTo,
        value: "20000",
        nonce: "0x1234",
        validAfter: "1",
        validBefore: "9999999999",
        ...overrides.authorization,
      },
      signature: "0xdeadbeef",
    },
    ...overrides.top,
  };
}

test("verified x402 request with CDP auth uses CDP body shape and attaches receipt", async () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const apiKeySecret = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  const dual = createDual402({
    ...VALID_CONFIG,
    x402: {
      ...VALID_CONFIG.x402,
      network: "eip155:8453",
      facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
      cdpAuth: { apiKeyId: "test-key-id", apiKeySecret },
    },
  });

  const handler = dual.charge({
    amount: "0.02",
    description: "Paid route",
    waitForSettle: true,
  });

  const paymentSignature = encodeSignature({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: "20000",
      asset: dual._x402Asset,
      payTo: VALID_CONFIG.x402.payTo,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    },
    payload: {
      authorization: {
        from: "0x1111111111111111111111111111111111111111",
        to: VALID_CONFIG.x402.payTo,
        value: "20000",
        nonce: "0x1234",
        validAfter: "1",
        validBefore: "9999999999",
      },
      signature: "0xdeadbeef",
    },
    resource: "https://public.example/paid",
  });

  const calls = [];
  await withFetch(
    async (url, init) => {
      calls.push({
        url,
        headers: init?.headers,
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      if (String(url).endsWith("/verify")) {
        return fakeFetchResponse({ ok: true, json: { isValid: true } });
      }
      return fakeFetchResponse({
        ok: true,
        json: { success: true, transaction: `0x${"a".repeat(64)}` },
      });
    },
    async () => {
      const res = makeRes();
      const outcome = await runHandler(
        handler,
        makeReq({
          path: "/paid",
          originalUrl: "/paid",
          headers: { "payment-signature": paymentSignature },
          host: "public.example",
        }),
        res,
      );

      assert.equal(outcome.nextCalled, true);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, "https://api.cdp.coinbase.com/platform/v2/x402/verify");
      assert.equal(calls[1].url, "https://api.cdp.coinbase.com/platform/v2/x402/settle");
      assert.ok(String(calls[0].headers.Authorization).startsWith("Bearer "));

      assert.equal(calls[0].body.x402Version, 2);
      assert.equal(calls[0].body.paymentRequirements.amount, "20000");
      assert.equal(calls[0].body.paymentRequirements.extra.name, "USD Coin");
      assert.equal(calls[0].body.paymentRequirements.resource, undefined);
      assert.equal(calls[0].body.paymentPayload.accepted.resource, undefined);

      const receipt = decodeBase64Json(headerValue(res.headers, "payment-response"));
      assert.equal(receipt.success, true);
      assert.equal(receipt.network, "eip155:8453");
      assert.equal(receipt.txHash, `0x${"a".repeat(64)}`);
    },
  );
});

test("local payee mismatch fails closed before calling the facilitator", async () => {
  const dual = createDual402(VALID_CONFIG);
  const handler = dual.charge({ amount: "0.02", description: "Mismatch test" });

  let fetchCalls = 0;
  await withFetch(
    async () => {
      fetchCalls++;
      throw new Error("fetch should not have been called");
    },
    async () => {
      const res = makeRes();
      await runHandler(
        handler,
        makeReq({
          path: "/mismatch",
          headers: {
            "payment-signature": encodeSignature(
              authorizationPayload({
                authorization: {
                  to: "0x2222222222222222222222222222222222222222",
                },
              }),
            ),
          },
        }),
        res,
      );
      assert.equal(fetchCalls, 0);
      assert.equal(res.statusCode, 402);
    },
  );
});

test("local accepted-network mismatch fails closed before calling the facilitator", async () => {
  const dual = createDual402(VALID_CONFIG);
  const handler = dual.charge({ amount: "0.02", description: "Network test" });

  let fetchCalls = 0;
  await withFetch(
    async () => {
      fetchCalls++;
      throw new Error("fetch should not have been called");
    },
    async () => {
      const res = makeRes();
      await runHandler(
        handler,
        makeReq({
          path: "/network-mismatch",
          headers: {
            "payment-signature": encodeSignature({
              x402Version: 2,
              accepted: {
                scheme: "exact",
                network: "eip155:1",
                amount: "20000",
                asset: dual._x402Asset,
                payTo: VALID_CONFIG.x402.payTo,
                maxTimeoutSeconds: 300,
                extra: { name: "USD Coin", version: "2" },
              },
              payload: {
                authorization: {
                  from: "0x1111111111111111111111111111111111111111",
                  to: VALID_CONFIG.x402.payTo,
                  value: "20000",
                  nonce: "0x1234",
                },
                signature: "0xdeadbeef",
              },
            }),
          },
        }),
        res,
      );
      assert.equal(fetchCalls, 0);
      assert.equal(res.statusCode, 402);
    },
  );
});

test("self-transfer (from === payTo) fails closed before facilitator", async () => {
  const dual = createDual402(VALID_CONFIG);
  const handler = dual.charge({ amount: "0.02", description: "Self transfer" });

  let fetchCalls = 0;
  await withFetch(
    async () => {
      fetchCalls++;
      throw new Error("fetch should not have been called");
    },
    async () => {
      const res = makeRes();
      await runHandler(
        handler,
        makeReq({
          path: "/self",
          headers: {
            "payment-signature": encodeSignature(
              authorizationPayload({
                authorization: { from: VALID_CONFIG.x402.payTo },
              }),
            ),
          },
        }),
        res,
      );
      assert.equal(fetchCalls, 0);
      assert.equal(res.statusCode, 402);
    },
  );
});

test("onVerify hook returning false rejects the payment", async () => {
  let hookCalls = 0;
  const dual = createDual402({
    ...VALID_CONFIG,
    onVerify: () => {
      hookCalls++;
      return false;
    },
  });
  const handler = dual.charge({ amount: "0.02", description: "Hook" });

  let fetchCalls = 0;
  await withFetch(
    async () => {
      fetchCalls++;
      return fakeFetchResponse({ ok: true, json: { isValid: true } });
    },
    async () => {
      const res = makeRes();
      await runHandler(
        handler,
        makeReq({
          path: "/hooked",
          headers: { "payment-signature": encodeSignature(authorizationPayload()) },
        }),
        res,
      );
      assert.equal(hookCalls, 1, "hook should have been called");
      assert.equal(fetchCalls, 0, "facilitator should not be called when hook rejects");
      assert.equal(res.statusCode, 402);
    },
  );
});

test("onVerify hook that throws is treated as rejection", async () => {
  const dual = createDual402({
    ...VALID_CONFIG,
    onVerify: () => {
      throw new Error("bad caller");
    },
  });
  const handler = dual.charge({ amount: "0.02", description: "Hook throws" });

  await withFetch(
    async () => {
      throw new Error("fetch should not have been called");
    },
    async () => {
      const res = makeRes();
      await runHandler(
        handler,
        makeReq({
          path: "/hook-throws",
          headers: { "payment-signature": encodeSignature(authorizationPayload()) },
        }),
        res,
      );
      assert.equal(res.statusCode, 402);
    },
  );
});

test("onVerify hook receives route + amount context", async () => {
  let received;
  const dual = createDual402({
    ...VALID_CONFIG,
    onVerify: (_payload, ctx) => {
      received = ctx;
      return true;
    },
  });
  const handler = dual.charge({ amount: "0.02", description: "Hook ctx" });

  await withFetch(
    async () =>
      fakeFetchResponse({
        ok: true,
        json: { isValid: true, txHash: "0xfeedface" },
      }),
    async () => {
      await runHandler(
        handler,
        makeReq({
          path: "/ctx",
          headers: { "payment-signature": encodeSignature(authorizationPayload()) },
        }),
        makeRes(),
      );
    },
  );
  assert.deepEqual(received, { route: "/ctx", amount: "0.02" });
});

test("waitForSettle: false returns immediately and settles in the background", async () => {
  const dual = createDual402(VALID_CONFIG);
  const handler = dual.charge({ amount: "0.02", description: "Async settle" });

  let settleResolved = false;
  let settleCalled = false;
  await withFetch(
    async (url) => {
      if (String(url).endsWith("/verify")) {
        return fakeFetchResponse({
          ok: true,
          json: { isValid: true, txHash: "0xfeedface" },
        });
      }
      settleCalled = true;
      return await new Promise((resolve) => {
        setTimeout(() => {
          settleResolved = true;
          resolve(
            fakeFetchResponse({
              ok: true,
              json: { success: true, transaction: "0xabcabcabc" },
            }),
          );
        }, 5);
      });
    },
    async () => {
      const res = makeRes();
      const outcome = await runHandler(
        handler,
        makeReq({
          path: "/async",
          headers: { "payment-signature": encodeSignature(authorizationPayload()) },
        }),
        res,
      );
      assert.equal(outcome.nextCalled, true);
      assert.ok(headerValue(res.headers, "payment-response"));
      assert.equal(settleCalled, true);
      assert.equal(settleResolved, false, "next() ran before settle resolved");
    },
  );
});

test("facilitator timeout returns reason=facilitator_timeout and falls through to 402", async () => {
  const dual = createDual402({
    ...VALID_CONFIG,
    x402: { ...VALID_CONFIG.x402, timeoutMs: 5 },
  });
  const handler = dual.charge({ amount: "0.02", description: "Timeout" });

  await withFetch(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener("abort", onAbort);
      }),
    async () => {
      const res = makeRes();
      await runHandler(
        handler,
        makeReq({
          path: "/timeout",
          headers: { "payment-signature": encodeSignature(authorizationPayload()) },
        }),
        res,
      );
      assert.equal(res.statusCode, 402, "verify timeout falls through to 402 challenge");
    },
  );
});

test("waitForSettle: true returns 502 with PAYMENT-REQUIRED on settle failure", async () => {
  const dual = createDual402(VALID_CONFIG);
  const handler = dual.charge({
    amount: "0.02",
    description: "Settle fail",
    waitForSettle: true,
  });

  await withFetch(
    async (url) => {
      if (String(url).endsWith("/verify")) {
        return fakeFetchResponse({ ok: true, json: { isValid: true } });
      }
      return fakeFetchResponse({ ok: false, status: 503, text: "facilitator down" });
    },
    async () => {
      const res = makeRes();
      await runHandler(
        handler,
        makeReq({
          path: "/settle-fail",
          headers: { "payment-signature": encodeSignature(authorizationPayload()) },
        }),
        res,
      );
      assert.equal(res.statusCode, 502);
      assert.equal(res.body?.error, "payment_settle_failed");
      assert.ok(headerValue(res.headers, "payment-required"), "should attach a fresh challenge");
    },
  );
});
