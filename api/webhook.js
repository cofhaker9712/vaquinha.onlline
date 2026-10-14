import { getDatabase } from "./_lib/db.js";
import { HttpError, handleError, sendJson } from "./_lib/http.js";
import { isValidWebhookSignature } from "./_lib/webhook-signature.js";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) {
      throw new HttpError(413, "O webhook excedeu o tamanho permitido.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: "Método não permitido." });
    return;
  }

  try {
    const webhookSecret = process.env.OBYPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("OBYPAY_WEBHOOK_SECRET não está configurado.");
      sendJson(res, 503, { error: "O webhook ainda não está configurado." });
      return;
    }

    const rawBody = await readRawBody(req);
    const signature = req.headers["obpay-signature"] ?? req.headers["x-obpay-signature"] ?? req.headers["x-signature"];
    if (!isValidWebhookSignature(rawBody, signature, webhookSecret)) {
      sendJson(res, 401, { error: "Assinatura do webhook inválida." });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new HttpError(400, "O corpo do webhook não contém JSON válido.");
    }

    const data = payload?.data;
    const event = payload?.event;
    const orderId = data?.orderId ?? data?.externalId ?? data?.metadata?.pedido ?? data?.order_id;
    const transactionId = data?.id ?? data?.transactionId ?? data?.transaction_id;
    const amount = Number(data?.amount ?? data?.grossAmount ?? 0);
    const statuses = {
      "payment.approved": "PAID",
      "payment.failed": "FAILED",
      "payment.expired": "EXPIRED",
      "payment.disputed": "MED",
    };

    if (typeof event !== "string"
      || !["payment.created", ...Object.keys(statuses)].includes(event)
      || typeof transactionId !== "string"
      || typeof orderId !== "string"
      || !Number.isFinite(amount)
      || amount <= 0) {
      throw new HttpError(400, "O webhook não contém os dados esperados da transação.");
    }
    if (statuses[event] && data?.status && String(data.status).toUpperCase() !== statuses[event]) {
      throw new HttpError(400, "O status do webhook não corresponde ao evento informado.");
    }

    const sql = await getDatabase();
    const [result] = await sql.query(
      `WITH candidate AS (
         SELECT id
         FROM vaquinha_donation_orders
         WHERE id = $3 AND transaction_id = $1 AND amount = $4
       ),
       accepted AS (
         INSERT INTO vaquinha_webhook_events (transaction_id, event)
         SELECT $1, $2 FROM candidate
         ON CONFLICT DO NOTHING
         RETURNING transaction_id
       ),
       updated AS (
         UPDATE vaquinha_donation_orders
         SET status = $5,
             paid_at = CASE WHEN $5 = 'PAID' THEN COALESCE($6::timestamptz, NOW()) ELSE paid_at END
         WHERE id = $3 AND $5 IS NOT NULL AND status = 'PENDING'
           AND EXISTS (SELECT 1 FROM accepted)
         RETURNING id
       )
       SELECT
         EXISTS (SELECT 1 FROM candidate) AS matched,
         EXISTS (SELECT 1 FROM accepted) AS first_delivery,
         EXISTS (SELECT 1 FROM updated) AS updated`,
      [
        transactionId,
        event,
        orderId,
        amount / 100,
        statuses[event] ?? null,
        data?.paidAt ?? null,
      ],
    );

    if (!result?.matched) {
      console.error("Webhook ObyPay sem pedido correspondente ou com valor divergente.", { event });
    }
    sendJson(res, 200, {
      received: true,
      duplicate: result?.matched === true && result?.first_delivery !== true,
    });
  } catch (error) {
    handleError(res, error);
  }
}
