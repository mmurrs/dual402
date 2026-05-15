import crypto from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { createDual402, dualDiscovery } from "../dist/express.js";

const VALID_CONFIG = {
  mpp: {
    currency: "0x20c0000000000000000000000000000000000000",
    recipient: "0x000000000000000000000000000000000000dEaD",
    secretKey: "a".repeat(64),
    testnet: true,
  },
  x402: {
    payTo: "0x000000000000000000000000000000000000dEaD",
    network: "eip155:84532",
    facilitatorUrl: "https://x402.org/facilitator",
  },
};

function makePaymentSignature({
  amount = "20000",
  payTo = VALID_CONFIG.x402.payTo,
  network = VALID_CONFIG.x402.network,
  asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  includeAmount = true,
  includePayee = true,
} = {}) {
  const authorization = {
    from: "0x1111111111111111111111111111111111111111",
    nonce: "0x1234",
    validAfter: "1",
    validBefore: "9999999999",
  };
  if (includePayee) authorization.to = payTo;
  if (includeAmount) authorization.value = amount;

  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network,
        amount,
        asset,
        payTo,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
      payload: {
        authorization,
        signature: "0xdeadbeef",
      },
    }),
  ).toString("base64");
}

function makeApp() {
  return {
    routes: new Map(),
    get(path, handler) {
      this.routes.set(path, handler);
      return this;
    },
  };
}

function makeRes() {
  const headers = {};
  return {
    headers,
    headersSent: false,
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      headers[name] = value;
    },
    getHeader(name) {
      return headers[name];
    },
    set(name, value) {
      this.setHeader(name, value);
      return this;
    },
    header(name, value) {
      this.setHeader(name, value);
      return this;
    },
    append(name, value) {
      this.setHeader(name, value);
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    send(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    end(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

function makeReq({
  method = "GET",
  path = "/demo",
  originalUrl = path,
  headers = {},
  host = "internal.test",
  protocol = "https",
} = {}) {
  return {
    method,
    path,
    url: originalUrl,
    originalUrl,
    headers,
    protocol,
    get(name) {
      return name.toLowerCase() === "host" ? host : undefined;
    },
  };
}

async function runHandler(handler, req, res) {
  let nextCalled = false;
  let nextArg;
  await Promise.race([
    Promise.resolve(
      handler(req, res, (arg) => {
        nextCalled = true;
        nextArg = arg;
      }),
    ),
    new Promise((resolve) => setTimeout(resolve, 30)),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  return { nextCalled, nextArg };
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === lower);
  return match?.[1];
}

function decodeBase64Json(value) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf-8"));
}

function fakeFetchResponse({ ok, status = ok ? 200 : 500, json, text = "" }) {
  return {
    ok,
    status,
    async json() {
      return json;
    },
    async text() {
      return text;
    },
  };
}

test("createDual402 validates required config", () => {
  assert.throws(
    () => createDual402({ mpp: {}, x402: {} }),
    /missing required config/,
  );
  assert.throws(
    () =>
      createDual402({
        ...VALID_CONFIG,
        x402: { ...VALID_CONFIG.x402, facilitatorUrl: "not-a-url" },
      }),
    /facilitatorUrl must be an absolute http\(s\) URL/,
  );
  assert.throws(
    () =>
      createDual402({
        ...VALID_CONFIG,
        mpp: { ...VALID_CONFIG.mpp, secretKey: "short" },
      }),
    /secretKey must be at least 32 characters/,
  );
  assert.throws(
    () =>
      createDual402({
        ...VALID_CONFIG,
        x402: { ...VALID_CONFIG.x402, payTo: "not-an-address" },
      }),
    /x402\.payTo must be an EVM address/,
  );
  assert.throws(
    () =>
      createDual402({
        ...VALID_CONFIG,
        x402: {
          ...VALID_CONFIG.x402,
          facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
          network: "eip155:8453",
        },
      }),
    /cdpAuth is required/,
  );
  assert.throws(
    () =>
      createDual402({
        ...VALID_CONFIG,
        x402: {
          ...VALID_CONFIG.x402,
          network: "eip155:8453",
          facilitatorUrl: "https://x402.org/facilitator",
        },
      }),
    /Base mainnet.*CDP/,
  );
});

test("charge validates header-safe descriptions", () => {
  const dual = createDual402(VALID_CONFIG);

  assert.throws(
    () => dual.charge({ amount: "0.02", description: "Bad — dash" }),
    /printable ASCII only/,
  );
  assert.throws(
    () => dual.charge({ amount: "0.02", description: "bad\r\nHeader: value" }),
    /printable ASCII only/,
  );
});

test("dualDiscovery keeps route metadata isolated when one handler is reused", async () => {
  const app = makeApp();
  const dual = createDual402(VALID_CONFIG);
  const sharedCharge = dual.charge({ amount: "0.02", description: "Shared route" });

  dualDiscovery(app, dual, {
    info: { title: "Test", description: "Test", version: "1.0.0" },
    routes: [
      {
        method: "get",
        path: "/one",
        handler: sharedCharge,
        operationId: "routeOne",
        summary: "Route one",
        parameters: [
          { name: "foo", in: "query", required: true, schema: { type: "string" } },
        ],
      },
      {
        method: "get",
        path: "/two",
        handler: sharedCharge,
        operationId: "routeTwo",
        summary: "Route two",
        parameters: [
          { name: "bar", in: "query", required: true, schema: { type: "number" } },
        ],
      },
    ],
  });

  const openapiRes = makeRes();
  await app.routes.get("/openapi.json")(makeReq(), openapiRes);
  assert.ok(openapiRes.body.paths["/one"].get);

  const previousBaseUrl = process.env.BASE_URL;
  process.env.BASE_URL = "https://public.example";
  try {
    const resOne = makeRes();
    await runHandler(
      sharedCharge,
      makeReq({ path: "/one", originalUrl: "/one?foo=abc" }),
      resOne,
    );
    assert.equal(resOne.statusCode, 402);
    const paymentRequiredOne = decodeBase64Json(
      headerValue(resOne.headers, "payment-required"),
    );
    assert.equal(paymentRequiredOne.accepts[0].resource, "https://public.example/one");
    assert.ok(
      paymentRequiredOne.extensions.bazaar.schema.properties.input.properties.queryParams.properties.foo,
    );
    assert.equal(
      paymentRequiredOne.extensions.bazaar.schema.properties.input.properties.queryParams.properties.bar,
      undefined,
    );

    const resTwo = makeRes();
    await runHandler(
      sharedCharge,
      makeReq({ path: "/two", originalUrl: "/two?bar=2" }),
      resTwo,
    );
    assert.equal(resTwo.statusCode, 402);
    const paymentRequiredTwo = decodeBase64Json(
      headerValue(resTwo.headers, "payment-required"),
    );
    assert.equal(paymentRequiredTwo.accepts[0].resource, "https://public.example/two");
    assert.ok(
      paymentRequiredTwo.extensions.bazaar.schema.properties.input.properties.queryParams.properties.bar,
    );
    assert.equal(
      paymentRequiredTwo.extensions.bazaar.schema.properties.input.properties.queryParams.properties.foo,
      undefined,
    );
  } finally {
    if (previousBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previousBaseUrl;
  }
});

test("dualDiscovery normalizes uppercase OpenAPI method keys", async () => {
  const app = makeApp();
  const dual = createDual402(VALID_CONFIG);
  const charge = dual.charge({ amount: "0.02" });

  dualDiscovery(app, dual, {
    routes: [
      {
        method: "GET",
        path: "/caps",
        handler: charge,
        operationId: "routeCaps",
        summary: "Route caps",
      },
    ],
  });

  const res = makeRes();
  await app.routes.get("/openapi.json")(makeReq(), res);
  assert.ok(res.body.paths["/caps"].get);
  assert.equal(res.body.paths["/caps"].GET, undefined);
});

test("verified x402 requests use CDP body shape and attach receipt headers", async () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const apiKeySecret = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();

  const dual = createDual402({
    ...VALID_CONFIG,
    x402: {
      ...VALID_CONFIG.x402,
      network: "eip155:8453",
      facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
      cdpAuth: {
        apiKeyId: "test-key-id",
        apiKeySecret,
      },
    },
  });

  const handler = dual.charge({
    amount: "0.02",
    description: "Paid route",
    waitForSettle: true,
  });

  const paymentSignature = Buffer.from(
    JSON.stringify({
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
    }),
  ).toString("base64");

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({
      url,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });

    if (String(url).endsWith("/verify")) {
      return fakeFetchResponse({
        ok: true,
        json: { isValid: true },
      });
    }

    return fakeFetchResponse({
      ok: true,
      json: {
        success: true,
        transaction: `0x${"a".repeat(64)}`,
      },
    });
  };

  try {
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
  } finally {
    global.fetch = originalFetch;
  }
});

test("x402 settlement is blocking by default", async () => {
  const dual = createDual402(VALID_CONFIG);
  const handler = dual.charge({ amount: "0.02", description: "Default settle" });

  let releaseSettle;
  let settleStarted;
  const settleStartedPromise = new Promise((resolve) => {
    settleStarted = resolve;
  });
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith("/verify")) {
      return fakeFetchResponse({ ok: true, json: { isValid: true } });
    }
    settleStarted();
    return new Promise((resolve) => {
      releaseSettle = () =>
        resolve(
          fakeFetchResponse({
            ok: true,
            json: { success: true, transaction: `0x${"b".repeat(64)}` },
          }),
        );
    });
  };

  try {
    const res = makeRes();
    let nextCalled = false;
    const promise = handler(
      makeReq({ headers: { "payment-signature": makePaymentSignature() } }),
      res,
      () => {
        nextCalled = true;
      },
    );

    await settleStartedPromise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nextCalled, false, "next() must wait for settlement by default");

    releaseSettle();
    await promise;
    assert.equal(nextCalled, true);
    const receipt = decodeBase64Json(headerValue(res.headers, "payment-response"));
    assert.equal(receipt.txHash, `0x${"b".repeat(64)}`);
  } finally {
    global.fetch = originalFetch;
  }
});

test("onVerify runs only after facilitator verification and before settlement", async () => {
  const events = [];
  const dual = createDual402({
    ...VALID_CONFIG,
    onVerify() {
      events.push("hook");
    },
  });
  const handler = dual.charge({ amount: "0.02" });

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith("/verify")) {
      events.push("verify");
      return fakeFetchResponse({ ok: true, json: { isValid: true } });
    }
    events.push("settle");
    return fakeFetchResponse({
      ok: true,
      json: { success: true, transaction: `0x${"c".repeat(64)}` },
    });
  };

  try {
    await runHandler(
      handler,
      makeReq({ headers: { "payment-signature": makePaymentSignature() } }),
      makeRes(),
    );
    assert.deepEqual(events, ["verify", "hook", "settle"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("local missing amount or payee fails closed before calling the facilitator", async () => {
  const dual = createDual402(VALID_CONFIG);
  const handler = dual.charge({ amount: "0.02", description: "Missing field test" });

  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls++;
    throw new Error("fetch should not have been called");
  };

  try {
    for (const paymentSignature of [
      makePaymentSignature({ includeAmount: false }),
      makePaymentSignature({ includePayee: false }),
    ]) {
      const res = makeRes();
      await runHandler(
        handler,
        makeReq({
          path: "/missing",
          originalUrl: "/missing",
          headers: { "payment-signature": paymentSignature },
        }),
        res,
      );
      assert.equal(res.statusCode, 402);
    }
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("local payee mismatch fails closed before calling the facilitator", async () => {
  const dual = createDual402(VALID_CONFIG);
  const handler = dual.charge({ amount: "0.02", description: "Mismatch test" });

  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls++;
    throw new Error("fetch should not have been called");
  };

  try {
    const forgedSignature = Buffer.from(
      JSON.stringify({
        payload: {
          authorization: {
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            value: "20000",
            nonce: "0x1234",
          },
          signature: "0xdeadbeef",
        },
      }),
    ).toString("base64");

    const res = makeRes();
    await runHandler(
      handler,
      makeReq({
        path: "/mismatch",
        originalUrl: "/mismatch",
        headers: { "payment-signature": forgedSignature },
      }),
      res,
    );

    assert.equal(fetchCalls, 0);
    assert.equal(res.statusCode, 402);
  } finally {
    global.fetch = originalFetch;
  }
});

test("local accepted network mismatch fails closed before calling the facilitator", async () => {
  const dual = createDual402(VALID_CONFIG);
  const handler = dual.charge({ amount: "0.02", description: "Network test" });

  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls++;
    throw new Error("fetch should not have been called");
  };

  try {
    const forgedSignature = Buffer.from(
      JSON.stringify({
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
    ).toString("base64");

    const res = makeRes();
    await runHandler(
      handler,
      makeReq({
        path: "/network-mismatch",
        originalUrl: "/network-mismatch",
        headers: { "payment-signature": forgedSignature },
      }),
      res,
    );

    assert.equal(fetchCalls, 0);
    assert.equal(res.statusCode, 402);
  } finally {
    global.fetch = originalFetch;
  }
});
