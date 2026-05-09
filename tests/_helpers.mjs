/**
 * Shared test helpers: an in-memory Express stand-in plus a `VALID_CONFIG`
 * baseline that individual test files can spread over.
 */

export const VALID_CONFIG = {
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

export function makeApp() {
  return {
    routes: new Map(),
    get(path, handler) {
      this.routes.set(`GET ${path}`, handler);
      return this;
    },
    post(path, handler) {
      this.routes.set(`POST ${path}`, handler);
      return this;
    },
  };
}

export function makeRes() {
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

export function makeReq({
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

export async function runHandler(handler, req, res) {
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

export function headerValue(headers, name) {
  const lower = name.toLowerCase();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === lower);
  return match?.[1];
}

export function decodeBase64Json(value) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf-8"));
}

export function fakeFetchResponse({ ok, status = ok ? 200 : 500, json, text = "" }) {
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

/** Encode a JSON-serializable value as a base64 PAYMENT-SIGNATURE header value. */
export function encodeSignature(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Run `fn` while `global.fetch` is replaced with `mockFetch`. Restores the
 * original even if `fn` throws.
 */
export async function withFetch(mockFetch, fn) {
  const original = global.fetch;
  global.fetch = mockFetch;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}
