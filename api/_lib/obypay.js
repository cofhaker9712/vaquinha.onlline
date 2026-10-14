import { HttpError } from "./http.js";

const API_BASE_URL = "https://api.obypay.app";

export class GatewayError extends Error {
  constructor(status, code, providerMessage, transactionId) {
    super(providerMessage || "Não foi possível concluir a solicitação na ObyPay.");
    this.status = status;
    this.code = code;
    this.providerMessage = providerMessage;
    this.transactionId = transactionId;
  }
}

function apiKey() {
  const key = process.env.OBYPAY_API_KEY;
  if (!key) {
    throw new HttpError(503, "A integração ObyPay ainda não foi configurada.");
  }
  return key;
}

function retryAfterSeconds(response) {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function redactProviderMessage(message, key, customer = {}) {
  let safeMessage = String(message || "").slice(0, 1000);
  for (const value of [key, ...Object.values(customer)]) {
    if (typeof value === "string" && value.length > 0) {
      safeMessage = safeMessage.replaceAll(value, "[redigido]");
    }
  }
  return safeMessage
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu, "[e-mail]")
    .replace(/\b\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[.\s-]?\d{2}\b/gu, "[documento]")
    .replace(/\+?\d[\d\s().-]{8,}\d/gu, "[telefone]")
    .slice(0, 500);
}

function payloadError(payload, status, key, customer) {
  const nested = payload?.error && typeof payload.error === "object" ? payload.error : null;
  const errorString = typeof payload?.error === "string" ? payload.error : null;
  const errorStringIsCode = errorString && /^[A-Za-z0-9_]{1,64}$/u.test(errorString);
  const codeCandidate = payload?.code ?? nested?.code ?? (errorStringIsCode ? errorString : null);
  const code = typeof codeCandidate === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(codeCandidate)
    ? codeCandidate
    : `HTTP_${status}`;
  const messageCandidate = payload?.message ?? nested?.message
    ?? (errorString && !errorStringIsCode ? errorString : null)
    ?? payload?.detail
    ?? "A ObyPay recusou a solicitação.";

  return { code, message: redactProviderMessage(messageCandidate, key, customer) };
}

function normalizeTransaction(payload) {
  const data = payload && typeof payload === "object" && payload.data
    && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data
    : payload;

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const amount = data.amount === undefined || data.amount === null
    ? null
    : Number(data.amount);

  return {
    transactionId: typeof data.id === "string" && data.id.trim() ? data.id.trim() : null,
    externalId: typeof data.externalId === "string" ? data.externalId : null,
    amount,
    status: typeof data.status === "string" ? data.status.toUpperCase() : "",
    pixCode: typeof data.copyPaste === "string" && data.copyPaste.trim()
      ? data.copyPaste.trim()
      : null,
    qrCodeBase64: typeof data.qrCodeBase64 === "string" && data.qrCodeBase64.trim()
      ? data.qrCodeBase64.trim()
      : null,
    expiresAt: data.expiresAt ?? null,
    paidAt: data.paidAt ?? null,
  };
}

async function request(path, options = {}, sensitiveCustomer = {}) {
  const key = apiKey();
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      redirect: "error",
      ...options,
      headers: {
        Authorization: key,
        ...options.headers,
      },
      signal: AbortSignal.timeout(7000),
    });
  } catch {
    throw new GatewayError(
      502,
      "NETWORK_ERROR",
      "Não foi possível estabelecer comunicação com a ObyPay.",
    );
  }

  let responseText;
  try {
    responseText = await response.text();
  } catch {
    throw new GatewayError(502, "RESPONSE_READ_ERROR", "Não foi possível ler a resposta da ObyPay.");
  }

  let payload = null;
  if (responseText.trim()) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new GatewayError(
        response.ok ? 502 : response.status,
        "INVALID_RESPONSE",
        response.ok
          ? "A ObyPay retornou uma resposta inválida."
          : "A ObyPay retornou uma resposta não JSON.",
      );
    }
  } else if (!response.ok) {
    throw new GatewayError(response.status, `HTTP_${response.status}`, "A ObyPay retornou uma resposta vazia.");
  } else {
    throw new GatewayError(502, "EMPTY_RESPONSE", "A ObyPay retornou uma resposta vazia.");
  }

  if (!response.ok) {
    const providerError = payloadError(payload, response.status, key, sensitiveCustomer);
    const error = new GatewayError(
      response.status,
      providerError.code,
      providerError.message,
      payload?.data?.id ?? payload?.id ?? null,
    );
    error.retryAfterSeconds = response.status === 429 ? retryAfterSeconds(response) : undefined;
    throw error;
  }

  return payload;
}

export function safeGatewayLog(error, customer = {}) {
  return {
    status: error.status,
    code: error.code,
    message: redactProviderMessage(error.providerMessage, process.env.OBYPAY_API_KEY || "", customer),
  };
}

export async function createCharge(order) {
  const amountCents = Number(order.amount) * 100;
  if (!Number.isSafeInteger(amountCents) || amountCents < 50) {
    throw new HttpError(400, "O valor da contribuição não atende ao mínimo aceito pela ObyPay.");
  }

  const payload = {
    amount: amountCents,
    webhook: order.callbackUrl,
    description: "Doação para a campanha da Dany",
    externalId: order.id,
    storeUrl: order.storeUrl,
    customer: {
      name: order.customer.name,
      email: order.customer.email,
      phone: order.customer.phone,
      document: order.customer.doc,
    },
    products: [
      {
        name: "Doação para a campanha da Dany",
        quantity: 1,
        priceInCents: amountCents,
      },
    ],
  };

  const response = await request("/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, order.customer);
  const charge = normalizeTransaction(response);

  if (!charge?.transactionId || !charge.pixCode) {
    throw new GatewayError(
      502,
      "INCOMPLETE_CHARGE",
      "A resposta de sucesso da ObyPay não contém o ID ou o código Copia e Cola.",
    );
  }
  if (charge.externalId && charge.externalId !== order.id) {
    throw new GatewayError(
      502,
      "EXTERNAL_ID_MISMATCH",
      "O identificador de pedido retornado pela ObyPay não corresponde à solicitação.",
      charge.transactionId,
    );
  }
  if (charge.amount !== null && (!Number.isSafeInteger(charge.amount) || charge.amount !== amountCents)) {
    throw new GatewayError(
      502,
      "AMOUNT_MISMATCH",
      "O valor retornado pela ObyPay não corresponde ao valor solicitado.",
    );
  }
  if (charge.expiresAt !== null && Number.isNaN(Date.parse(charge.expiresAt))) {
    throw new GatewayError(502, "INVALID_EXPIRATION", "A validade retornada pela ObyPay é inválida.");
  }

  return {
    transactionId: charge.transactionId,
    externalId: charge.externalId,
    pixCode: charge.pixCode,
    qrCodeBase64: charge.qrCodeBase64,
    expiresAt: charge.expiresAt,
    amount: charge.amount ?? amountCents,
  };
}

export async function getTransaction(transactionId) {
  const payload = await request(`/transactions/${encodeURIComponent(transactionId)}`);
  const transaction = normalizeTransaction(payload);
  if (!transaction?.transactionId) {
    throw new GatewayError(502, "INVALID_TRANSACTION", "A resposta da ObyPay não contém uma transação válida.");
  }
  return transaction;
}
