import QRCode from "qrcode";
import { validateDonation, getCallbackUrl, getPublicAppUrl } from "./_lib/campaign.js";
import { getDatabase } from "./_lib/db.js";
import { GatewayError, createCharge, getTransaction, safeGatewayLog } from "./_lib/obypay.js";
import { handleError, HttpError, readJson, requireMethod, sendJson } from "./_lib/http.js";

export const config = { api: { bodyParser: false } };

function paymentResponse(order, qrCode) {
  return {
    orderId: order.id,
    transactionId: order.transaction_id,
    status: order.status,
    amount: Number(order.amount),
    pixCode: order.pix_code,
    qrCode,
    expiresAt: order.expires_at,
  };
}

async function makeQrCode(pixCode, qrCodeBase64) {
  if (typeof qrCodeBase64 === "string") {
    const value = qrCodeBase64.trim();
    if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/iu.test(value)) {
      return value.replace(/\s/gu, "");
    }
    if (/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
      return `data:image/png;base64,${value}`;
    }
  }

  return QRCode.toDataURL(pixCode, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 280,
  });
}

function publicGatewayMessage(status) {
  if (status === 400) {
    return "A ObyPay não aceitou o valor ou os dados. Confira o formulário e tente uma contribuição maior, pois o valor precisa cobrir as taxas da conta.";
  }
  if (status === 401 || status === 403) {
    return "O serviço de pagamento está indisponível. Tente novamente mais tarde.";
  }
  if (status === 429) {
    return "Muitas tentativas em pouco tempo. Aguarde antes de tentar novamente.";
  }
  return "Não foi possível gerar o PIX agora. Tente novamente mais tarde.";
}

async function recoverPixData(sql, order) {
  let transaction;
  try {
    transaction = await getTransaction(order.transaction_id);
  } catch (error) {
    if (error instanceof GatewayError) {
      console.error("Falha ao recuperar os dados PIX da ObyPay.", {
        ...safeGatewayLog(error),
        orderId: order.id,
      });
      throw new HttpError(502, "Não foi possível recuperar os dados PIX desta contribuição. Entre em contato com o suporte antes de tentar novamente.");
    }
    throw error;
  }

  if ((transaction.externalId && transaction.externalId !== order.id)
    || (transaction.amount !== null && transaction.amount !== Number(order.amount) * 100)
    || !transaction.pixCode) {
    console.error("Os dados recuperados da ObyPay não correspondem à contribuição.", {
      orderId: order.id,
      transactionId: order.transaction_id,
    });
    throw new HttpError(502, "Não foi possível confirmar os dados desta contribuição. Entre em contato com o suporte.");
  }

  const [updated] = await sql.query(
    `UPDATE vaquinha_donation_orders
     SET pix_code = $3, expires_at = COALESCE($4::timestamptz, expires_at)
     WHERE id = $1 AND transaction_id = $2
     RETURNING id, amount, status, transaction_id, pix_code, expires_at`,
    [order.id, order.transaction_id, transaction.pixCode, transaction.expiresAt],
  );
  if (!updated) {
    throw new HttpError(503, "Não foi possível salvar os dados PIX recuperados. Tente novamente.");
  }

  return { order: updated, qrCodeBase64: transaction.qrCodeBase64 };
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  let orderId;
  let customer;
  let sql;
  let chargeClaimed = false;
  try {
    const donation = validateDonation(await readJson(req));
    orderId = donation.orderId;
    customer = donation.customer;
    const callbackUrl = getCallbackUrl();
    const storeUrl = getPublicAppUrl();
    sql = await getDatabase();

    await sql.query(
      `INSERT INTO vaquinha_donation_orders (id, amount, tracking)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [donation.orderId, donation.amount, JSON.stringify(donation.tracking)],
    );

    let [order] = await sql.query(
      `SELECT id, amount, status, transaction_id, pix_code, expires_at
       FROM vaquinha_donation_orders WHERE id = $1`,
      [donation.orderId],
    );
    if (!order || Number(order.amount) !== donation.amount) {
      throw new HttpError(409, "Esta tentativa de contribuição não pôde ser reutilizada.");
    }

    if (order.transaction_id) {
      let qrCodeBase64;
      if (!order.pix_code) {
        ({ order, qrCodeBase64 } = await recoverPixData(sql, order));
      }
      sendJson(res, 200, {
        ...paymentResponse(order, await makeQrCode(order.pix_code, qrCodeBase64)),
        orderId: order.id,
      });
      return;
    }

    if (order.status !== "PENDING") {
      throw new HttpError(409, "Esta contribuição já foi finalizada.");
    }

    const [claimed] = await sql.query(
      `UPDATE vaquinha_donation_orders
       SET charge_creation_started_at = NOW()
       WHERE id = $1 AND status = 'PENDING'
         AND transaction_id IS NULL AND charge_creation_started_at IS NULL
       RETURNING id`,
      [donation.orderId],
    );
    if (!claimed) {
      throw new HttpError(409, "Esta cobrança já está sendo processada. Aguarde alguns instantes antes de tentar novamente.");
    }
    chargeClaimed = true;

    let charge;
    try {
      charge = await createCharge({
        id: donation.orderId,
        amount: donation.amount,
        customer: donation.customer,
        callbackUrl,
        storeUrl,
      });
    } catch (error) {
      if (error instanceof HttpError
        || (error instanceof GatewayError && error.status < 500 && error.status !== 409)) {
        await sql.query(
          `UPDATE vaquinha_donation_orders
           SET charge_creation_started_at = NULL
           WHERE id = $1 AND transaction_id IS NULL AND status = 'PENDING'`,
          [donation.orderId],
        );
        chargeClaimed = false;
      }
      throw error;
    }

    let savedOrder;
    try {
      [savedOrder] = await sql.query(
        `UPDATE vaquinha_donation_orders
         SET transaction_id = $2, pix_code = $3, expires_at = $4,
             charge_creation_started_at = NULL
         WHERE id = $1 AND (transaction_id IS NULL OR transaction_id = $2)
           AND status IN ('PENDING', 'PAID')
         RETURNING id, amount, status, transaction_id, pix_code, expires_at`,
        [donation.orderId, charge.transactionId, charge.pixCode, charge.expiresAt],
      );
      if (!savedOrder) {
        [savedOrder] = await sql.query(
          `SELECT id, amount, status, transaction_id, pix_code, expires_at
           FROM vaquinha_donation_orders WHERE id = $1`,
          [donation.orderId],
        );
        if (savedOrder?.transaction_id !== charge.transactionId || !savedOrder.pix_code) {
          throw new Error("The charge was not associated with its local order.");
        }
      }
      chargeClaimed = false;
    } catch {
      console.error("Cobrança ObyPay criada, mas não foi possível confirmar seu registro local.", {
        orderId: donation.orderId,
        transactionId: charge.transactionId,
      });
      throw new HttpError(503, "A cobrança pode ter sido criada, mas não foi possível confirmá-la. Não tente pagar novamente; entre em contato com o suporte.");
    }

    const qrCode = await makeQrCode(savedOrder.pix_code, charge.qrCodeBase64);
    sendJson(res, 200, paymentResponse(savedOrder, qrCode));
  } catch (error) {
    if (error instanceof GatewayError) {
      console.error("Falha na solicitação de cobrança ObyPay.", {
        ...safeGatewayLog(error, customer),
        ...(orderId ? { orderId } : {}),
      });
      if (error.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      const clientStatus = [400, 401, 403, 429].includes(error.status)
        ? error.status
        : 502;
      sendJson(res, clientStatus, {
        error: publicGatewayMessage(error.status),
      });
      return;
    }

    if (chargeClaimed && sql && orderId) {
      console.error("A criação da cobrança terminou sem confirmação do provedor; a reserva foi mantida para impedir duplicatas.", {
        orderId,
        errorType: error?.name || "Error",
      });
    }
    handleError(res, error);
  }
}
