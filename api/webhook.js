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
    const rawBody = await readRawBody(req);
    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new HttpError(400, "O corpo do webhook não contém JSON válido.");
    }

    if (payload?.event === "webhook.test") {
      sendJson(res, 200, { received: true });
      return;
    }

    const webhookSecret = process.env.OBYPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("OBYPAY_WEBHOOK_SECRET não está configurado.");
      sendJson(res, 503, { error: "O webhook ainda não está configurado." });
      return;
    }

    if (!isValidWebhookSignature(
      rawBody,
      req.headers["obypay-signature"],
      webhookSecret,
    )) {
      sendJson(res, 401, { error: "Assinatura do webhook inválida." });
      return;
    }

    if (payload?.event !== "payment.approved") {
      sendJson(res, 200, { received: true, ignored: true });
      return;
    }

    const data = payload.data;
    const transactionId = data?.id;
    const orderId = data?.externalId;
    const amountCents = data?.amount;
    if (typeof transactionId !== "string" || !transactionId.trim()
      || typeof orderId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)
      || !Number.isSafeInteger(amountCents)
      || amountCents < 50) {
      throw new HttpError(400, "O webhook não contém os dados esperados da cobrança aprovada.");
    }

    const sql = await getDatabase();
    const [result] = await sql.query(
      `WITH candidate AS (
         SELECT id
         FROM vaquinha_donation_orders
         WHERE id = $3 AND amount = $4
           AND (transaction_id IS NULL OR transaction_id = $1)
       ),
       accepted AS (
         INSERT INTO vaquinha_webhook_events (transaction_id, event)
         SELECT $1, $2 FROM candidate
         ON CONFLICT DO NOTHING
         RETURNING transaction_id
       ),
       updated AS (
         UPDATE vaquinha_donation_orders
         SET transaction_id = COALESCE(transaction_id, $1),
             status = 'PAID',
             paid_at = COALESCE(paid_at, NOW())
         WHERE id = $3 AND status IN ('PENDING', 'FAILED', 'EXPIRED')
           AND EXISTS (SELECT 1 FROM accepted)
         RETURNING id
       )
       SELECT
         EXISTS (SELECT 1 FROM candidate) AS matched,
         EXISTS (SELECT 1 FROM accepted) AS first_delivery,
         EXISTS (SELECT 1 FROM updated) AS updated`,
      [transactionId, payload.event, orderId, amountCents / 100],
    );

    if (!result?.matched) {
      console.error("Webhook ObyPay aprovado sem contribuição correspondente ou com valor divergente.", {
        event: payload.event,
      });
      sendJson(res, 200, { received: true, matched: false });
      return;
    }

    sendJson(res, 200, {
      received: true,
      duplicate: result.first_delivery !== true,
    });
  } catch (error) {
    handleError(res, error);
  }
}
