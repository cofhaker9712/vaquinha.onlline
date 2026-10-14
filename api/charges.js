import QRCode from "qrcode";
import { validateDonation, getCallbackUrl } from "./_lib/campaign.js";
import { getDatabase } from "./_lib/db.js";
import { GatewayError, createCharge } from "./_lib/obypay.js";
import { handleError, readJson, requireMethod, sendJson } from "./_lib/http.js";

export const config = { api: { bodyParser: false } };

function paymentResponse(order) {
  return {
    orderId: order.id,
    transactionId: order.transaction_id,
    status: order.status,
    amount: Number(order.amount),
    pixCode: order.pix_code,
    qrCode: null,
    expiresAt: order.expires_at,
  };
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  let orderId;
  try {
    const donation = validateDonation(await readJson(req));
    orderId = donation.orderId;
    const callbackUrl = getCallbackUrl();
    const sql = await getDatabase();

    await sql.query(
      `INSERT INTO vaquinha_donation_orders (id, amount, tracking)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [donation.orderId, donation.amount, JSON.stringify(donation.tracking)],
    );

    const [existing] = await sql.query(
      "SELECT id, amount, status, transaction_id, pix_code, expires_at FROM vaquinha_donation_orders WHERE id = $1",
      [donation.orderId],
    );
    if (!existing || Number(existing.amount) !== donation.amount) {
      sendJson(res, 409, { error: "Esta tentativa de contribuição não pôde ser reutilizada." });
      return;
    }

    if (existing.status !== "PENDING") {
      sendJson(res, 409, { error: "Esta contribuição já foi finalizada.", status: existing.status });
      return;
    }

    let order = existing;
    if (!order.transaction_id || !order.pix_code) {
      const result = await createCharge({
        id: donation.orderId,
        amount: donation.amount,
        customer: donation.customer,
        tracking: donation.tracking,
        callbackUrl,
      });
      const charge = result?.data;
      if (!charge?.transactionId || !charge?.pixCode || !charge?.expiresAt) {
        throw new GatewayError(502, "O gateway não retornou os dados necessários para o PIX.");
      }

      [order] = await sql.query(
        `UPDATE vaquinha_donation_orders
         SET transaction_id = $2, pix_code = $3, expires_at = $4
         WHERE id = $1 AND status = 'PENDING'
         RETURNING id, amount, status, transaction_id, pix_code, expires_at`,
        [donation.orderId, charge.transactionId, charge.pixCode, charge.expiresAt],
      );
      if (!order) {
        throw new Error("A cobrança foi criada, mas o pedido não pôde ser atualizado.");
      }
    }

    const qrCode = await QRCode.toDataURL(order.pix_code, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
    });
    sendJson(res, 200, { ...paymentResponse(order), qrCode });
  } catch (error) {
    if (error instanceof GatewayError) {
      console.error("Falha na solicitação de cobrança ObyPay.", { status: error.status });
      if (error.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      sendJson(res, error.status >= 500 ? 502 : error.status, {
        error: error.message,
        orderId,
      });
      return;
    }
    handleError(res, error);
  }
}
