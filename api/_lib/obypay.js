import { HttpError } from "./http.js";

const API_BASE_URL = "https://api.obypay.app";

export class GatewayError extends Error {
  constructor(status, message, transactionId, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.transactionId = transactionId;
    this.retryAfterSeconds = retryAfterSeconds;
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

function normalizePayload(payload) {
  const data = payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "data")
    ? payload.data
    : payload;

  if (!data || typeof data !== "object") {
    return { transactionId: null, pixCode: null, qrCode: null, expiresAt: null, amount: 0, status: "" };
  }

  return {
    transactionId: data.id ?? data.transactionId ?? data.transaction_id ?? payload?.transactionId ?? payload?.id ?? null,
    pixCode: data.copyPaste ?? data.copy_paste ?? data.pixCode ?? data.pix_code ?? payload?.copyPaste ?? payload?.pixCode ?? null,
    qrCode: data.qrCodeBase64 ?? data.qrCodeUrl ?? data.qrCode ?? data.qr_code_url ?? payload?.qrCodeBase64 ?? payload?.qrCodeUrl ?? payload?.qrCode ?? null,
    expiresAt: data.expiresAt ?? data.expires_at ?? payload?.expiresAt ?? payload?.expires_at ?? null,
    amount: Number(data.amount ?? payload?.amount ?? 0),
    status: String(data.status ?? payload?.status ?? "").toUpperCase(),
  };
}

async function request(path, options = {}) {
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
    throw new GatewayError(502, "Não foi possível conectar ao gateway. Tente novamente.");
  }

  let responseText = "";
  try {
    responseText = await response.text();
  } catch {
    throw new GatewayError(502, "Não foi possível ler a resposta do gateway.");
  }

  let payload;
  if (responseText.trim()) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new GatewayError(
        response.ok ? 502 : response.status,
        response.ok
          ? "O gateway retornou uma resposta inválida."
          : `O gateway retornou uma resposta não JSON (HTTP ${response.status}).`,
      );
    }
  } else if (!response.ok) {
    throw new GatewayError(
      response.status,
      `O gateway retornou uma resposta vazia (HTTP ${response.status}).`,
    );
  } else {
    throw new GatewayError(502, "O gateway retornou uma resposta vazia.");
  }

  if (!response.ok) {
    const code = payload?.code || payload?.error?.code || payload?.error || "BAD_REQUEST";
    const message = payload?.message || payload?.error?.message || {
      400: "Confira os dados informados e tente novamente.",
      401: "A chave de API do gateway é inválida.",
      403: "A conta do gateway não está habilitada para receber cobranças.",
      404: "A cobrança não foi encontrada no gateway.",
      429: "O gateway limitou temporaneamente as solicitações. Aguarde antes de tentar novamente.",
    }[response.status] || `O gateway não conseguiu processar a cobrança. Tente novamente. (${code})`;

    throw new GatewayError(
      response.status,
      message,
      payload?.id ?? payload?.data?.id ?? payload?.transactionId ?? payload?.data?.transactionId ?? payload?.error?.transactionId,
      response.status === 429 ? retryAfterSeconds(response) : undefined,
    );
  }

  return payload;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function createCharge(order) {
  const amountCents = Math.max(50, Math.round(Number(order.amount) * 100));
  const payload = {
    amount: amountCents,
    description: "Doação para a campanha da Dany",
    externalId: order.id,
    webhook: order.callbackUrl,
    customer: {
      name: order.customer?.name || "Contribuinte",
      email: order.customer?.email || undefined,
      phone: order.customer?.phone || undefined,
      document: order.customer?.doc || order.customer?.document || undefined,
    },
    items: [
      {
        name: "Doação para a campanha da Dany",
        quantity: 1,
        priceInCents: amountCents,
      },
    ],
  };

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request("/transactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": order.id,
        },
        body: JSON.stringify(payload),
      });

      const normalized = normalizePayload(response);
      if (!normalized.transactionId || (!normalized.pixCode && !normalized.qrCode)) {
        throw new GatewayError(502, "O gateway não retornou os dados necessários para o PIX.");
      }

      return {
        success: true,
        data: {
          transactionId: normalized.transactionId,
          pixCode: normalized.pixCode,
          qrCode: normalized.qrCode,
          expiresAt: normalized.expiresAt,
          amount: normalized.amount || amountCents,
        },
      };
    } catch (error) {
      lastError = error;
      const retryable = error instanceof GatewayError
        && ([500, 502, 503, 504].includes(error.status)
          || (error.status === 409 && Boolean(error.transactionId)));
      if (!retryable) {
        throw error;
      }
      if (attempt === 1) break;
      await delay(1000);
    }
  }

  throw lastError;
}

export function getTransaction(transactionId) {
  return request(`/transactions/${encodeURIComponent(transactionId)}`);
}
