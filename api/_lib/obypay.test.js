import assert from "node:assert/strict";
import test from "node:test";
import { createCharge, getTransaction, safeGatewayLog } from "./obypay.js";

const order = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  amount: 50,
  customer: {
    name: "Maria da Silva",
    email: "maria@example.com",
    doc: "52998224725",
    phone: "11999999999",
  },
  callbackUrl: "https://vaquinha.example.com/api/webhook",
  storeUrl: "https://vaquinha.example.com",
};

function withTestApiKey(context) {
  const originalKey = process.env.OBYPAY_API_KEY;
  process.env.OBYPAY_API_KEY = "test-only-key";
  context.after(() => {
    if (originalKey === undefined) delete process.env.OBYPAY_API_KEY;
    else process.env.OBYPAY_API_KEY = originalKey;
  });
}

test("creates a charge with the documented ObyPay authentication and request fields", async (context) => {
  withTestApiKey(context);
  let requestUrl;
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({
      id: "transaction-test",
      amount: 5000,
      status: "pending",
      qrCodeBase64: "aGVsbG8=",
      copyPaste: "pix-copy-paste-test",
      expiresAt: "2026-10-12T20:00:00.000Z",
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  });

  const result = await createCharge(order);
  const sent = JSON.parse(requestOptions.body);

  assert.equal(requestUrl, "https://api.obypay.app/transactions");
  assert.equal(requestOptions.headers.Authorization, "test-only-key");
  assert.equal(requestOptions.headers.Authorization.startsWith("Bearer "), false);
  assert.equal(requestOptions.headers["Idempotency-Key"], undefined);
  assert.deepEqual(sent, {
    amount: 5000,
    webhook: order.callbackUrl,
    description: "Doação para a campanha da Dany",
    externalId: order.id,
    storeUrl: order.storeUrl,
    customer: {
      name: "Maria da Silva",
      email: "maria@example.com",
      phone: "11999999999",
      document: "52998224725",
    },
    products: [{
      name: "Doação para a campanha da Dany",
      quantity: 1,
      priceInCents: 5000,
    }],
  });
  assert.deepEqual(result, {
    transactionId: "transaction-test",
    externalId: null,
    pixCode: "pix-copy-paste-test",
    qrCodeBase64: "aGVsbG8=",
    expiresAt: "2026-10-12T20:00:00.000Z",
    amount: 5000,
  });
});

test("accepts documented fields inside a data response envelope and permits missing expiration", async (context) => {
  withTestApiKey(context);
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    data: {
      id: "transaction-test",
      amount: 200,
      copyPaste: "pix-copy-paste-test",
      qrCodeBase64: "aGVsbG8=",
    },
  }), { status: 201 }));

  const result = await createCharge({ ...order, amount: 2 });
  assert.equal(result.transactionId, "transaction-test");
  assert.equal(result.amount, 200);
  assert.equal(result.expiresAt, null);
});

test("rejects amounts below the documented 50-cent ObyPay minimum before calling the API", async (context) => {
  withTestApiKey(context);
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new Response("{}", { status: 201 });
  });

  await assert.rejects(
    createCharge({ ...order, amount: 0.49 }),
    (error) => error.status === 400,
  );
  assert.equal(requests, 0);
});

test("sends donation amounts in integer cents and rejects a mismatched provider amount", async (context) => {
  withTestApiKey(context);
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    id: "transaction-test",
    amount: 4999,
    copyPaste: "pix-copy-paste-test",
  }), { status: 201 }));

  await assert.rejects(
    createCharge(order),
    (error) => error.status === 502 && error.code === "AMOUNT_MISMATCH",
  );
});

test("rejects a response linked to a different external order ID", async (context) => {
  withTestApiKey(context);
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    id: "transaction-test",
    externalId: "another-order",
    amount: 5000,
    copyPaste: "pix-copy-paste-test",
  }), { status: 201 }));

  await assert.rejects(
    createCharge(order),
    (error) => error.status === 502 && error.code === "EXTERNAL_ID_MISMATCH",
  );
});

test("does not retry an ambiguous provider failure that could create duplicate charges", async (context) => {
  withTestApiKey(context);
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new Response(JSON.stringify({
      code: "INTERNAL_SERVER_ERROR",
      message: "Não foi possível concluir a solicitação.",
    }), { status: 500 });
  });

  await assert.rejects(createCharge(order), (error) => error.status === 500);
  assert.equal(requests, 1);
});

test("logs only redacted ObyPay error details", async (context) => {
  withTestApiKey(context);
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    code: "BAD_REQUEST",
    message: "Documento 52998224725 telefone 11999999999 e-mail maria@example.com chave test-only-key",
  }), { status: 400 }));

  await assert.rejects(createCharge(order), (error) => {
    const details = safeGatewayLog(error, order.customer);
    assert.equal(details.status, 400);
    assert.equal(details.code, "BAD_REQUEST");
    assert.doesNotMatch(details.message, /52998224725|11999999999|maria@example\.com|test-only-key/u);
    return true;
  });
});

test("preserves a provider string error as a safe log message", async (context) => {
  withTestApiKey(context);
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    error: "Erro ao criar transação no adquirente",
  }), { status: 400 }));

  await assert.rejects(createCharge(order), (error) => {
    const details = safeGatewayLog(error, order.customer);
    assert.equal(details.status, 400);
    assert.match(details.message, /Erro ao criar transação no adquirente/u);
    return true;
  });
});

test("reads a transaction by its documented ID endpoint and normalizes amount in cents", async (context) => {
  withTestApiKey(context);
  let requestUrl;
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({
      data: {
        id: "transaction/test",
        amount: 5000,
        externalId: order.id,
        status: "approved",
      },
    }), { status: 200 });
  });

  const transaction = await getTransaction("transaction/test");
  assert.equal(requestUrl, "https://api.obypay.app/transactions/transaction%2Ftest");
  assert.equal(requestOptions.headers.Authorization, "test-only-key");
  assert.equal(transaction.status, "APPROVED");
  assert.equal(transaction.amount, 5000);
  assert.equal(transaction.externalId, order.id);
});

test("reports an explicit gateway error when an error response has no body", async (context) => {
  withTestApiKey(context);
  context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
  await assert.rejects(
    createCharge(order),
    (error) => error.status === 401 && error.code === "HTTP_401",
  );
});

test("preserves the provider Retry-After value without retrying", async (context) => {
  withTestApiKey(context);
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new Response(JSON.stringify({
      code: "TOO_MANY_REQUESTS",
      message: "Tente mais tarde.",
    }), {
      status: 429,
      headers: { "Retry-After": "12" },
    });
  });

  await assert.rejects(createCharge(order), (error) => error.retryAfterSeconds === 12);
  assert.equal(requests, 1);
});
