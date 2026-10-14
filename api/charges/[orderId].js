import { getDatabase } from "../_lib/db.js";
import { HttpError, handleError, requireMethod, sendJson } from "../_lib/http.js";

export const config = { api: { bodyParser: false } };

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
      `SELECT status, expires_at, paid_at
       FROM vaquinha_donation_orders WHERE id = $1`,
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
         RETURNING status, expires_at, paid_at`,
        [orderId],
      );
      if (!order) {
        [order] = await sql.query(
          `SELECT status, expires_at, paid_at
           FROM vaquinha_donation_orders WHERE id = $1`,
          [orderId],
        );
      }
    }

    sendJson(res, 200, {
      status: order.status,
      expiresAt: order.expires_at,
      paidAt: order.paid_at,
    });
  } catch (error) {
    handleError(res, error);
  }
}
