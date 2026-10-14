export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) {
      throw new HttpError(413, "A solicitação excedeu o tamanho permitido.");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "O corpo da solicitação precisa ser um JSON válido.");
  }
}

export function requireMethod(req, res, method) {
  if (req.method !== method) {
    res.setHeader("Allow", method);
    sendJson(res, 405, { error: `Método não permitido. Use ${method}.` });
    return false;
  }
  return true;
}

export function handleError(res, error) {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }

  console.error("Erro interno na API da campanha.");
  sendJson(res, 500, { error: "Não foi possível concluir a solicitação. Tente novamente." });
}
