import { getDatabase } from "../_lib/db.js";
import { getTransaction, GatewayError } from "../_lib/obypay.js";
import { HttpError, handleError, requireMethod, sendJson } from "../_lib/http.js";

export const config = { api: { bodyParser: false } };

const FINAL_STATUSES = new Set(["PAID", "FAILED", "EXPIRED", "MED"]);

export default async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;

  try {
    const orderId = req.query?.orderId;
    if (typeof orderId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
      throw new HttpError(400, "Identificador de contribuição inválido.");
    }

    const sql = await getDatabase();
    let [order] = await sql.query(
      "SELECT status, amount, transaction_id, expires_at, paid_at FROM vaquinha_donation_orders WHERE id = $1",
      [orderId],
    );
    if (!order) {
      throw new HttpError(404, "Esta contribuição não foi encontrada.");
    }

    if (order.status === "PENDING" && order.expires_at
      && Date.now() > new Date(order.expires_at).getTime() + 60_000) {
      [order] = await sql.query(
        `UPDATE vaquinha_donation_orders SET status = 'EXPIRED'
         WHERE id = $1 AND status = 'PENDING'
         RETURNING status, transaction_id, expires_at, paid_at`,
        [orderId],
      );
      if (!order) {
        [order] = await sql.query(
          "SELECT status, transaction_id, expires_at, paid_at FROM vaquinha_donation_orders WHERE id = $1",
          [orderId],
        );
      }
      sendJson(res, 200, { status: order.status, expiresAt: order.expires_at, paidAt: order.paid_at });
      return;
    }

    if (order.status === "PENDING" && order.transaction_id) {
      const [claimed] = await sql.query(
        `UPDATE vaquinha_donation_orders SET last_checked_at = NOW()
         WHERE id = $1 AND status = 'PENDING'
           AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '3 seconds')
         RETURNING transaction_id`,
        [orderId],
      );

      if (claimed) {
        let remote;
        try {
          remote = await getTransaction(claimed.transaction_id);
        } catch (error) {
          if (error instanceof GatewayError && error.status === 404) {
            console.error("Transação não encontrada no ObyPay.", { orderId });
            throw new HttpError(502, "Não foi possível localizar a transação para consultar o pagamento.");
          }
          throw error;
        }

        const remoteStatus = String(remote?.data?.status ?? remote?.status ?? "").toUpperCase();
        if ((remote?.paid === true || remoteStatus === "PAID")
          && (Number(remote?.data?.amount) !== Number(order.amount)
            || remote?.data?.metadata?.pedido !== orderId)) {
          console.error("Resposta de pagamento ObyPay não corresponde ao pedido.", { orderId });
          throw new HttpError(502, "Não foi possível confirmar os dados desta transação.");
        }
        const nextStatus = remote?.paid === true || remoteStatus === "PAID"
          ? "PAID"
          : ["FAILED", "EXPIRED", "MED"].includes(remoteStatus) ? remoteStatus : null;

        if (nextStatus && FINAL_STATUSES.has(nextStatus)) {
          [order] = await sql.query(
            `UPDATE vaquinha_donation_orders
             SET status = $2,
                 paid_at = CASE WHEN $2 = 'PAID' THEN COALESCE($3::timestamptz, NOW()) ELSE paid_at END
             WHERE id = $1 AND status = 'PENDING'
             RETURNING status, transaction_id, expires_at, paid_at`,
            [orderId, nextStatus, remote?.data?.paidAt ?? null],
          );
          if (!order) {
            [order] = await sql.query(
              "SELECT status, transaction_id, expires_at, paid_at FROM vaquinha_donation_orders WHERE id = $1",
              [orderId],
            );
          }
        }
      }
    }

    sendJson(res, 200, {
      status: order.status,
      expiresAt: order.expires_at,
      paidAt: order.paid_at,
    });
  } catch (error) {
    if (error instanceof GatewayError) {
      console.error("Falha ao consultar transação ObyPay.", { status: error.status });
      sendJson(res, 502, { error: error.message });
      return;
    }
    handleError(res, error);
  }
}
