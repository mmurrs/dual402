import assert from "node:assert/strict";
import test from "node:test";

import { createDual402, dualDiscovery } from "../dist/express.js";

import {
  VALID_CONFIG,
  decodeBase64Json,
  headerValue,
  makeApp,
  makeReq,
  makeRes,
  runHandler,
} from "./_helpers.mjs";

test("dualDiscovery threads per-route metadata into the handler", async () => {
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
    const paymentRequiredOne = decodeBase64Json(headerValue(resOne.headers, "payment-required"));
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
    const paymentRequiredTwo = decodeBase64Json(headerValue(resTwo.headers, "payment-required"));
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

test("POST routes with requestBodySchema produce a body-shaped bazaar extension", async () => {
  const app = makeApp();
  const dual = createDual402(VALID_CONFIG);
  const charge = dual.charge({ amount: "0.05", description: "Echo" });

  dualDiscovery(app, dual, {
    info: { title: "POST test", description: "", version: "1.0.0" },
    routes: [
      {
        method: "post",
        path: "/echo",
        handler: charge,
        operationId: "echo",
        summary: "Echo body",
        requestBodySchema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
      },
    ],
  });

  const previousBaseUrl = process.env.BASE_URL;
  process.env.BASE_URL = "https://public.example";
  try {
    const res = makeRes();
    await runHandler(
      charge,
      makeReq({ method: "POST", path: "/echo", originalUrl: "/echo" }),
      res,
    );
    assert.equal(res.statusCode, 402);

    const paymentRequired = decodeBase64Json(headerValue(res.headers, "payment-required"));
    const inputProps =
      paymentRequired.extensions.bazaar.schema.properties.input.properties;
    assert.equal(inputProps.method.enum.includes("POST"), true);
    assert.equal(inputProps.bodyType.enum.includes("json"), true);
    assert.deepEqual(inputProps.body.required, ["msg"]);
    assert.deepEqual(
      paymentRequired.extensions.bazaar.schema.properties.input.required,
      ["type", "bodyType", "body"],
    );
  } finally {
    if (previousBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previousBaseUrl;
  }
});

test("dualDiscovery throws when a route handler is not a dual402 charge handler", () => {
  const app = makeApp();
  const dual = createDual402(VALID_CONFIG);
  const fakeHandler = (_req, _res, next) => next();
  assert.throws(
    () =>
      dualDiscovery(app, dual, {
        info: { title: "Bad", description: "", version: "1.0.0" },
        routes: [
          {
            method: "get",
            path: "/bad",
            handler: fakeHandler,
            operationId: "bad",
            summary: "Missing dual amount",
          },
        ],
      }),
    /missing a dual402 charge handler/,
  );
});

test("openapi.json exposes x-payment-info per route, .well-known/x402 lists resources", async () => {
  const app = makeApp();
  const dual = createDual402(VALID_CONFIG);
  const charge = dual.charge({ amount: "0.02", description: "Quote" });

  dualDiscovery(app, dual, {
    info: { title: "Spec test", description: "", version: "1.2.3" },
    routes: [
      {
        method: "get",
        path: "/quote",
        handler: charge,
        operationId: "quote",
        summary: "Quote",
      },
    ],
  });

  const openapiHandler = app.routes.get("GET /openapi.json");
  const wellKnownHandler = app.routes.get("GET /.well-known/x402");
  assert.ok(openapiHandler && wellKnownHandler);

  const previousBaseUrl = process.env.BASE_URL;
  process.env.BASE_URL = "https://public.example";
  try {
    const openapiRes = makeRes();
    openapiHandler(makeReq({ path: "/openapi.json" }), openapiRes);
    assert.equal(openapiRes.body.openapi, "3.1.0");
    assert.equal(openapiRes.body.info.title, "Spec test");
    const op = openapiRes.body.paths["/quote"].get;
    assert.equal(op["x-payment-info"].price.amount, "0.02");
    assert.deepEqual(openapiRes.body.servers, [{ url: "https://public.example" }]);

    const wkRes = makeRes();
    wellKnownHandler(makeReq({ path: "/.well-known/x402" }), wkRes);
    assert.deepEqual(wkRes.body, { version: 1, resources: ["GET /quote"] });
  } finally {
    if (previousBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previousBaseUrl;
  }
});
