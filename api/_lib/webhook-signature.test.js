import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { isValidWebhookSignature } from "./webhook-signature.js";

test("accepts an HMAC-SHA256 signature for the exact raw request body", () => {
  const body = Buffer.from('{"event":"payment.approved","data":{"amount":5000}}');
  const signature = createHmac("sha256", "unit-test-secret").update(body).digest("hex");

  assert.equal(isValidWebhookSignature(body, signature, "unit-test-secret"), true);
  assert.equal(isValidWebhookSignature(Buffer.from(body.toString() + " "), signature, "unit-test-secret"), false);
});

test("rejects malformed signatures and missing webhook secrets", () => {
  const body = Buffer.from("{}");

  assert.equal(isValidWebhookSignature(body, "not-a-signature", "unit-test-secret"), false);
  assert.equal(isValidWebhookSignature(body, "a".repeat(64), ""), false);
});
