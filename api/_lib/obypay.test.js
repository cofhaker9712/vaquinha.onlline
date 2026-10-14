import assert from "node:assert/strict";
import test from "node:test";
import { createCharge } from "./obypay.js";

test("creates an ObyPay charge with the documented endpoint and request shape", async (context) => {
  const originalKey = process.env.OBYPAY_API_KEY;
  process.env.OBYPAY_API_KEY = "test-only-key";
  context.after(() => {
    if (originalKey === undefined) delete process.env.OBYPAY_API_KEY;
    else process.env.OBYPAY_API_KEY = originalKey;
  });

  let requestUrl;
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({
      id: "transaction-test",
      amount: 5000,
      status: "pending",
      copyPaste: "pix-copy-paste-test",
      expiresAt: "2026-10-12T20:00:00.000Z",
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  });

  const order = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    amount: 50,
    customer: {
      name: "Maria da Silva",
      email: "maria@example.com",
      doc: "52998224725",
      docType: "cpf",
      phone: "11999999999",
    },
    callbackUrl: "https://vaquinha.example.com/api/webhook",
    tracking: {
      utm_source: "FACEBOOK",
      utm_campaign: "CAMPANHA|123",
      utm_medium: null,
      utm_content: null,
      utm_term: null,
      src: null,
      sck: null,
    },
  };
  const result = await createCharge(order);
  const sent = JSON.parse(requestOptions.body);

  assert.equal(requestUrl, "https://api.obypay.app/transactions");
  assert.equal(requestOptions.headers.Authorization, "test-only-key");
  assert.equal(requestOptions.headers["Idempotency-Key"], order.id);
  assert.equal(sent.amount, 5000);
  assert.equal(sent.customer.document, "52998224725");
  assert.equal(sent.webhookUrl, order.callbackUrl);
  assert.equal(sent.orderId, order.id);
  assert.deepEqual(sent.items, [{ name: "Doação para a campanha da Dany", quantity: 1, priceInCents: 5000 }]);
  assert.equal(result.data.pixCode, "pix-copy-paste-test");
});

test("reports an explicit gateway error when the response body is empty", async (context) => {
  const originalKey = process.env.OBYPAY_API_KEY;
  process.env.OBYPAY_API_KEY = "test-only-key";
  context.after(() => {
    if (originalKey === undefined) delete process.env.OBYPAY_API_KEY;
    else process.env.OBYPAY_API_KEY = originalKey;
  });

  context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
  await assert.rejects(
    createCharge({
      id: "550e8400-e29b-41d4-a716-446655440000",
      amount: 50,
      customer: {},
      callbackUrl: "https://vaquinha.example.com/api/webhook",
      tracking: {},
    }),
    (error) => error.status === 401
      && error.message === "O gateway retornou uma resposta vazia (HTTP 401).",
  );
});

test("reports an explicit gateway error when an error response is not JSON", async (context) => {
  const originalKey = process.env.OBYPAY_API_KEY;
  process.env.OBYPAY_API_KEY = "test-only-key";
  context.after(() => {
    if (originalKey === undefined) delete process.env.OBYPAY_API_KEY;
    else process.env.OBYPAY_API_KEY = originalKey;
  });

  context.mock.method(globalThis, "fetch", async () => new Response("<html>failure</html>", { status: 401 }));
  await assert.rejects(
    createCharge({
      id: "550e8400-e29b-41d4-a716-446655440000",
      amount: 50,
      customer: {},
      callbackUrl: "https://vaquinha.example.com/api/webhook",
      tracking: {},
    }),
    (error) => error.status === 401
      && error.message === "O gateway retornou uma resposta não JSON (HTTP 401).",
  );
});

test("retries a transient server error once with the same idempotency key", async (context) => {
  const originalKey = process.env.OBYPAY_API_KEY;
  process.env.OBYPAY_API_KEY = "test-only-key";
  context.after(() => {
    if (originalKey === undefined) delete process.env.OBYPAY_API_KEY;
    else process.env.OBYPAY_API_KEY = originalKey;
  });

  const keys = [];
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    keys.push(options.headers["Idempotency-Key"]);
    if (keys.length === 1) {
      return new Response(JSON.stringify({ error: "temporary failure" }), { status: 500 });
    }
    return new Response(JSON.stringify({
      id: "transaction-test",
      amount: 5000,
      status: "pending",
      copyPaste: "pix-copy-paste-test",
      expiresAt: "2026-10-12T20:00:00.000Z",
    }), { status: 201 });
  });

  const result = await createCharge({
    id: "550e8400-e29b-41d4-a716-446655440000",
    amount: 50,
    customer: {},
    callbackUrl: "https://vaquinha.example.com/api/webhook",
    tracking: {},
  });
  assert.equal(result.data.transactionId, "transaction-test");
  assert.deepEqual(keys, [
    "550e8400-e29b-41d4-a716-446655440000",
    "550e8400-e29b-41d4-a716-446655440000",
  ]);
});

test("does not retry rate limiting early and exposes the documented Retry-After delay", async (context) => {
  const originalKey = process.env.OBYPAY_API_KEY;
  process.env.OBYPAY_API_KEY = "test-only-key";
  context.after(() => {
    if (originalKey === undefined) delete process.env.OBYPAY_API_KEY;
    else process.env.OBYPAY_API_KEY = originalKey;
  });

  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "Retry-After": "12" },
    });
  });

  try {
    await createCharge({
      id: "550e8400-e29b-41d4-a716-446655440000",
      amount: 50,
      customer: {},
      callbackUrl: "https://vaquinha.example.com/api/webhook",
      tracking: {},
    });
    assert.fail("Expected rate limiting to reject the charge creation.");
  } catch (error) {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSeconds, 12);
    assert.match(error.message, /Aguarde antes de tentar novamente\./u);
  }
  assert.equal(requests, 1);
});
