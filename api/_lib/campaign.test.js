import assert from "node:assert/strict";
import test from "node:test";
import { getCallbackUrl, validateDonation } from "./campaign.js";

const orderId = "550e8400-e29b-41d4-a716-446655440000";
const customer = {
  name: "Maria da Silva",
  email: "maria@example.com",
  doc: "529.982.247-25",
  phone: "(11) 99999-9999",
};

test("validates a donation and preserves UTM values in the tracking object", () => {
  const minimumDonation = validateDonation({
    orderId,
    amount: 2,
    customer,
  });
  const donation = validateDonation({
    orderId,
    amount: 50,
    customer,
    tracking: { utm_campaign: "CAMPANHA|123", utm_source: "FACEBOOK" },
  });

  assert.equal(minimumDonation.amount, 2);
  assert.equal(donation.customer.doc, "52998224725");
  assert.equal(donation.customer.docType, "cpf");
  assert.equal(donation.tracking.utm_campaign, "CAMPANHA|123");
  assert.equal(donation.tracking.utm_source, "FACEBOOK");
  assert.equal(donation.tracking.src, null);
});

test("rejects unsupported amounts and invalid CPF numbers", () => {
  assert.throws(
    () => validateDonation({ orderId, amount: 500, customer }),
    { status: 400 },
  );
  assert.throws(
    () => validateDonation({
      orderId,
      amount: 50,
      customer: { ...customer, doc: "11111111111" },
    }),
    { status: 400 },
  );
});

test("builds the public HTTPS webhook URL and rejects a local callback", () => {
  const original = process.env.APP_URL;
  try {
    process.env.APP_URL = "https://vaquinha.example.com";
    assert.equal(getCallbackUrl(), "https://vaquinha.example.com/api/webhook");
    process.env.APP_URL = "http://localhost:3000";
    assert.throws(() => getCallbackUrl(), { status: 503 });
  } finally {
    if (original === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = original;
  }
});
