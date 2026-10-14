import { HttpError } from "./http.js";

export const TRACKING_KEYS = [
  "utm_source",
  "utm_campaign",
  "utm_medium",
  "utm_content",
  "utm_term",
  "src",
  "sck",
];

export const DONATION_AMOUNTS = [2, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 100];

export function normalizeTracking(input) {
  return Object.fromEntries(TRACKING_KEYS.map((key) => {
    const value = input?.[key];
    return [key, typeof value === "string" && value.trim() ? value : null];
  }));
}

function isValidCpf(cpf) {
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digits = [...cpf].map(Number);
  const first = (digits.slice(0, 9).reduce((sum, digit, index) => sum + digit * (10 - index), 0) * 10) % 11;
  if (digits[9] !== (first === 10 ? 0 : first)) return false;
  const second = (digits.slice(0, 10).reduce((sum, digit, index) => sum + digit * (11 - index), 0) * 10) % 11;
  return digits[10] === (second === 10 ? 0 : second);
}

export function validateDonation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "Confira os dados da contribuição.");
  }

  const { orderId, amount, customer } = input;
  if (typeof orderId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
    throw new HttpError(400, "Não foi possível identificar esta tentativa de contribuição.");
  }

  if (!DONATION_AMOUNTS.includes(Number(amount))) {
    throw new HttpError(400, "Escolha um dos valores de contribuição disponíveis.");
  }

  const name = typeof customer?.name === "string" ? customer.name.trim() : "";
  const email = typeof customer?.email === "string" ? customer.email.trim() : "";
  const doc = typeof customer?.doc === "string" ? customer.doc.replace(/\D/g, "") : "";
  const phone = typeof customer?.phone === "string" ? customer.phone.replace(/\D/g, "") : "";

  if (name.length < 2 || name.length > 120) {
    throw new HttpError(400, "Informe seu nome completo.");
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Informe um e-mail válido.");
  }
  if (!isValidCpf(doc)) {
    throw new HttpError(400, "Informe um CPF válido, com 11 números.");
  }
  if (phone.length < 10 || phone.length > 13) {
    throw new HttpError(400, "Informe um telefone com DDD.");
  }

  return {
    orderId,
    amount: Number(amount),
    customer: { name, email, doc, docType: "cpf", phone },
    tracking: normalizeTracking(input.tracking),
  };
}

export function getCallbackUrl() {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    throw new HttpError(503, "Configure a URL HTTPS pública do site para ativar os pagamentos.");
  }

  let url;
  try {
    url = new URL(appUrl);
  } catch {
    throw new HttpError(503, "A URL pública configurada para o site é inválida.");
  }

  const hostname = url.hostname.toLowerCase();
  const privateIpv4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
  if (url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || ["localhost", "::1"].includes(hostname)
    || hostname.endsWith(".local")
    || privateIpv4) {
    throw new HttpError(503, "Configure APP_URL com a origem HTTPS pública do site, sem caminhos extras.");
  }

  return `${url.origin}/api/webhook`;
}
