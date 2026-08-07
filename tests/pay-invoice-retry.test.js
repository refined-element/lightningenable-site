// Unit tests for the NWC pay-invoice retry wrapper in run-agent.js.
// Run with `npm test`.
//
// Why this exists (the gap these tests lock down):
//   The live "Run the agent" button fires ONE NWC pay_invoice round-trip.
//   CoinOS's NWC pay path is occasionally flaky — it accepts the request
//   at the relay and then doesn't answer within the timeout, even during
//   otherwise-healthy windows (observed 2026-08-07: get_balance instant,
//   pay_invoice hung 25s, balance never moved). The daily smoke test
//   survives these blips because it retries (2 attempts); a visitor's
//   single click did not, so the prospect saw an error on a flow that
//   would have succeeded on a second try.
//
//   `payInvoiceWithRetry` closes that gap by retrying the SAME invoice
//   on transient pay failures. Retrying the same BOLT11 is safe from
//   double-spend by construction: a payment_hash can only settle once,
//   so a re-pay of an invoice that secretly settled in-flight returns
//   the same preimage (or errors "already paid") — it never moves funds
//   twice. Deterministic wallet rejections (insufficient balance, etc.)
//   are NOT retried — a second try can't help and just delays the error.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRetryablePayError,
  payInvoiceWithRetry,
} from "../api/run-agent.js";

// A stand-in for payViaNwc's thrown Error (which carries a .trace).
function payError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

// ── isRetryablePayError: transient pay-leg failures retry ──────────

test("isRetryablePayError: NWC payment timeout is retryable", () => {
  assert.equal(
    isRetryablePayError(payError("NWC payment timed out after 20000ms. Last step before timeout: ok_received.")),
    true,
  );
});

test("isRetryablePayError: relay rejection is retryable", () => {
  assert.equal(
    isRetryablePayError(payError("Relay rejected our pay_invoice event: rate-limited")),
    true,
  );
});

test("isRetryablePayError: websocket error is retryable", () => {
  assert.equal(isRetryablePayError(payError("WebSocket error on relay.coinos.io: ECONNRESET")), true);
  assert.equal(isRetryablePayError(payError("Could not open WebSocket to relay.coinos.io: timeout")), true);
});

test("isRetryablePayError: 'no preimage' reply is retryable", () => {
  assert.equal(
    isRetryablePayError(payError("Wallet replied with no error but no preimage either.")),
    true,
  );
});

// ── isRetryablePayError: deterministic failures must NOT retry ─────

test("isRetryablePayError: explicit wallet NWC error is NOT retryable", () => {
  // A wallet-side rejection (insufficient balance, restricted, quota) is
  // deterministic — retrying just burns time before the same failure.
  assert.equal(
    isRetryablePayError(payError("Wallet returned NWC error INSUFFICIENT_BALANCE: not enough sats")),
    false,
  );
  assert.equal(
    isRetryablePayError(payError("Wallet returned NWC error RESTRICTED: spending limit reached")),
    false,
  );
});

test("isRetryablePayError: unknown/empty error is NOT retryable (fail closed)", () => {
  assert.equal(isRetryablePayError(payError("some unexpected failure")), false);
  assert.equal(isRetryablePayError(null), false);
  assert.equal(isRetryablePayError(undefined), false);
});

// ── payInvoiceWithRetry: behavior ──────────────────────────────────

const noSleep = async () => {};

test("payInvoiceWithRetry: succeeds on first attempt, no retry", async () => {
  let calls = 0;
  const payFn = async () => {
    calls++;
    return { preimage: "aa11", trace: [{ step: "ok" }] };
  };
  const out = await payInvoiceWithRetry(payFn, "lnbc-test", { sleep: noSleep });
  assert.equal(out.preimage, "aa11");
  assert.equal(out.attempts, 1);
  assert.equal(calls, 1);
});

test("payInvoiceWithRetry: retries a transient failure then succeeds", async () => {
  let calls = 0;
  const payFn = async () => {
    calls++;
    if (calls < 2) throw payError("NWC payment timed out after 20000ms.");
    return { preimage: "bb22", trace: [] };
  };
  const out = await payInvoiceWithRetry(payFn, "lnbc-test", { maxAttempts: 2, sleep: noSleep });
  assert.equal(out.preimage, "bb22");
  assert.equal(out.attempts, 2);
  assert.equal(calls, 2);
});

test("payInvoiceWithRetry: does NOT retry a deterministic wallet error", async () => {
  let calls = 0;
  const payFn = async () => {
    calls++;
    throw payError("Wallet returned NWC error INSUFFICIENT_BALANCE: not enough sats");
  };
  await assert.rejects(
    payInvoiceWithRetry(payFn, "lnbc-test", { maxAttempts: 3, sleep: noSleep }),
    /INSUFFICIENT_BALANCE/,
  );
  assert.equal(calls, 1); // one attempt only — no wasted retries
});

test("payInvoiceWithRetry: exhausts maxAttempts on persistent transient failure, throws last error with trace", async () => {
  let calls = 0;
  const payFn = async () => {
    calls++;
    throw payError("NWC payment timed out after 20000ms.", { trace: [{ step: "ok_received" }] });
  };
  await assert.rejects(
    payInvoiceWithRetry(payFn, "lnbc-test", { maxAttempts: 2, sleep: noSleep }),
    (err) => {
      assert.match(err.message, /timed out/);
      assert.deepEqual(err.trace, [{ step: "ok_received" }]); // diagnostic trace preserved
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("payInvoiceWithRetry: retries the SAME invoice and passes the timeout through", async () => {
  const seen = [];
  let calls = 0;
  const payFn = async (invoice, opts) => {
    seen.push({ invoice, timeoutMs: opts?.timeoutMs });
    calls++;
    if (calls < 2) throw payError("NWC payment timed out after 20000ms.");
    return { preimage: "cc33", trace: [] };
  };
  await payInvoiceWithRetry(payFn, "lnbc-same-invoice", {
    maxAttempts: 2,
    timeoutMs: 20_000,
    sleep: noSleep,
  });
  assert.equal(seen.length, 2);
  // Same invoice on every attempt — never a fresh mint (double-spend-safe).
  assert.equal(seen[0].invoice, "lnbc-same-invoice");
  assert.equal(seen[1].invoice, "lnbc-same-invoice");
  assert.equal(seen[1].timeoutMs, 20_000);
});

test("payInvoiceWithRetry: backs off between attempts via the injected sleep", async () => {
  const sleeps = [];
  let calls = 0;
  const payFn = async () => {
    calls++;
    if (calls < 2) throw payError("Relay rejected our pay_invoice event: transient");
    return { preimage: "dd44", trace: [] };
  };
  await payInvoiceWithRetry(payFn, "lnbc-test", {
    maxAttempts: 2,
    backoffMs: 500,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(sleeps, [500]); // exactly one backoff, between the two attempts
});
