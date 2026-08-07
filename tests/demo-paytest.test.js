// Unit tests for the pay-path self-test endpoint (api/demo-paytest.js).
// Run with `npm test`.
//
// Why this exists:
//   /api/demo-health checks the wallet BALANCE (a get_balance NWC round-
//   trip). That proves the wallet is reachable and funded, but NOT that
//   it can actually PAY — the exact gap that bit us 2026-08-07, when
//   get_balance was instant while pay_invoice hung. This endpoint closes
//   that gap by periodically running a REAL end-to-end L402 buy down the
//   same path a visitor's click takes (mint a 1-sat challenge → pay it →
//   verify the token), and reporting payOk so the frontend can gate the
//   "Run the agent" button when the pay path is actually broken.
//
//   It can't run a real payment on every page load (cost + NWC load), so
//   the throttle is the EDGE CACHE: a long s-maxage + stale-while-
//   revalidate means the origin (the real payment) runs ~once per
//   interval during background revalidation, while visitors always get an
//   instant cached answer. summarizeProbe() owns that cache decision;
//   runPayProbe() owns the buy. Both are unit-tested here with injected
//   deps so no real sats or network are involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SELF_TEST_INTERVAL_SECONDS,
  summarizeProbe,
  runPayProbe,
} from "../api/demo-paytest.js";

// ── summarizeProbe: response body + cache directive ────────────────

test("summarizeProbe: success caches for the full self-test interval", () => {
  const out = summarizeProbe({ ok: true, detail: null, checkedAt: "2026-08-07T19:00:00Z" });
  assert.equal(out.body.payOk, true);
  assert.equal(out.body.detail, null);
  assert.equal(out.body.checkedAt, "2026-08-07T19:00:00Z");
  // The edge cache is the throttle — success must cache for the interval.
  assert.match(out.cacheControl, new RegExp(`s-maxage=${SELF_TEST_INTERVAL_SECONDS}\\b`));
  assert.match(out.cacheControl, /stale-while-revalidate=/);
});

test("summarizeProbe: failure caches only briefly so the banner clears fast on recovery", () => {
  const out = summarizeProbe({ ok: false, detail: "NWC payment timed out", checkedAt: "2026-08-07T19:00:00Z" });
  assert.equal(out.body.payOk, false);
  assert.equal(out.body.detail, "NWC payment timed out");
  // A failure must NOT be pinned for the full interval — re-probe soon.
  const m = out.cacheControl.match(/s-maxage=(\d+)/);
  assert.ok(m, "cacheControl has s-maxage");
  assert.ok(Number(m[1]) < SELF_TEST_INTERVAL_SECONDS, "failure s-maxage is shorter than the interval");
});

test("summarizeProbe: failure with no detail still yields a non-empty reason", () => {
  const out = summarizeProbe({ ok: false, detail: null, checkedAt: "2026-08-07T19:00:00Z" });
  assert.equal(out.body.payOk, false);
  assert.ok(typeof out.body.detail === "string" && out.body.detail.length > 0);
});

// ── runPayProbe: the real end-to-end buy (deps injected) ───────────

/** A 402 challenge response stub carrying the macaroon+invoice in the body. */
function challenge402(invoice = "lnbc-probe", macaroon = "mac-probe") {
  return {
    status: 402,
    headers: { get: () => null },
    json: async () => ({ l402: { macaroon, invoice, amount_sats: 1 } }),
  };
}
/** A settled 200 response stub. */
function settled200() {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => ({ price: 64000, l402: { valid: true } }),
  };
}

test("runPayProbe: happy path returns ok:true", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), auth: opts?.headers?.Authorization });
    return calls.length === 1 ? challenge402() : settled200();
  };
  const pay = async () => ({ preimage: "pre1", trace: [] });
  const out = await runPayProbe({ origin: "https://demo.example", nwcUrl: "nostr+walletconnect://x", deps: { fetchImpl, pay } });
  assert.equal(out.ok, true);
  assert.equal(out.detail, null);
  // Second hop must carry the L402 credential.
  assert.match(calls[1].auth, /^L402 mac-probe:pre1$/);
});

test("runPayProbe: pay failure returns ok:false with the pay error surfaced", async () => {
  const fetchImpl = async () => challenge402();
  const pay = async () => { throw new Error("NWC payment timed out after 15000ms."); };
  const out = await runPayProbe({ origin: "https://demo.example", nwcUrl: "nostr+walletconnect://x", deps: { fetchImpl, pay } });
  assert.equal(out.ok, false);
  assert.match(out.detail, /timed out/);
});

test("runPayProbe: a non-402 challenge response returns ok:false (never pays)", async () => {
  let paid = false;
  const fetchImpl = async () => ({ status: 500, headers: { get: () => null }, json: async () => ({}) });
  const pay = async () => { paid = true; return { preimage: "x", trace: [] }; };
  const out = await runPayProbe({ origin: "https://demo.example", nwcUrl: "nostr+walletconnect://x", deps: { fetchImpl, pay } });
  assert.equal(out.ok, false);
  assert.equal(paid, false); // no invoice, so no payment attempted
});

test("runPayProbe: a paid-but-unverified retry (non-200) returns ok:false", async () => {
  const fetchImpl = async (url, opts) =>
    opts?.headers?.Authorization
      ? { status: 401, ok: false, headers: { get: () => null }, json: async () => ({ error: "Unauthorized" }) }
      : challenge402();
  const pay = async () => ({ preimage: "pre1", trace: [] });
  const out = await runPayProbe({ origin: "https://demo.example", nwcUrl: "nostr+walletconnect://x", deps: { fetchImpl, pay } });
  assert.equal(out.ok, false);
});
