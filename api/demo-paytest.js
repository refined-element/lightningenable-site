/**
 * GET /api/demo-paytest
 *
 * Pay-path self-test. Unlike /api/demo-health (which only checks the
 * wallet BALANCE via a get_balance NWC round-trip), this runs a REAL
 * end-to-end L402 buy down the same path a visitor's "Run the agent"
 * click takes: mint a 1-sat challenge from our own premium endpoint, pay
 * it over NWC, and verify the token. It reports { payOk } so the frontend
 * can gate the button when the pay path is actually broken — the exact
 * failure get_balance can't see (observed 2026-08-07: get_balance
 * instant, pay_invoice hung 25s, balance never moved).
 *
 * Throttle = the edge cache. A real payment can't run on every page load
 * (cost + NWC load), so success is cached for SELF_TEST_INTERVAL_SECONDS
 * behind a long stale-while-revalidate: visitors always get an instant
 * cached answer, and the origin (the real payment) runs ~once per
 * interval during background revalidation. This is cold-start-proof — the
 * throttle lives in the shared edge cache, not per-instance memory (which
 * resets on every cold start and, under sparse traffic, would pay on
 * nearly every load). A short in-memory guard adds a second layer so a
 * cache-busting caller can't force a payment on every direct hit.
 *
 * Cost: ~1 self-payment per interval per edge region, all to the demo's
 * OWN merchant 5 (a self-transfer, refilled by the daily cron).
 */

import { payViaNwc } from "./_lib/nwc.js";

// User-chosen cadence: "hourly or every 2-4 hours." 2h is the middle;
// retune by editing this one constant. Seconds, so it drops straight into
// the Cache-Control s-maxage.
export const SELF_TEST_INTERVAL_SECONDS = 7_200; // 2 hours

// One real payment attempt for the probe, bounded so a hung wallet can't
// run past the function's 60s maxDuration (vercel.json).
const PROBE_TIMEOUT_MS = 20_000;

// Second-layer guard: even if the edge cache is bypassed (a direct hit
// with a cache-buster), one warm instance won't run the real payment more
// than once per this window. The edge cache is the primary throttle; this
// just caps direct-call abuse.
const MIN_REPROBE_MS = 5 * 60 * 1000; // 5 minutes

// Per-instance memory of the last real probe (backs the MIN_REPROBE guard).
let lastProbe = { at: 0, ok: null, detail: null, checkedAt: null };

/**
 * Turn a probe outcome into the response body + Cache-Control. The cache
 * directive IS the throttle: success is pinned for the full interval;
 * failure is pinned only briefly so the button-gating banner clears
 * within minutes of the wallet recovering rather than staying stuck for
 * hours on a cached failure.
 *
 * Exported for unit testing (tests/demo-paytest.test.js).
 */
export function summarizeProbe({ ok, detail, checkedAt }) {
  if (ok) {
    return {
      body: { payOk: true, checkedAt, detail: null },
      cacheControl: `public, s-maxage=${SELF_TEST_INTERVAL_SECONDS}, stale-while-revalidate=${SELF_TEST_INTERVAL_SECONDS * 12}`,
    };
  }
  return {
    body: { payOk: false, checkedAt, detail: detail || "Pay-path self-test failed." },
    cacheControl: "public, s-maxage=300, stale-while-revalidate=600",
  };
}

/**
 * Run one real end-to-end L402 buy against our own premium endpoint.
 * Returns { ok, detail } — ok:true only when the payment settled AND the
 * merchant returned 200 for the retried request. Deps (fetchImpl, pay)
 * are injected for testing so unit tests move no real sats.
 *
 * A single payment attempt on purpose: the probe measures "would one
 * click work right now"; the visitor path (run-agent) layers its own
 * retry on top, and a failed probe self-clears fast via the short
 * failure cache above.
 *
 * Exported for unit testing (tests/demo-paytest.test.js).
 */
export async function runPayProbe({ origin, nwcUrl, deps = {} }) {
  const { fetchImpl = fetch, pay = payViaNwc } = deps;
  const target = `${origin}/api/premium/btc-price`;

  // 1. Challenge — expect 402 + macaroon + invoice.
  let challengeRes;
  try {
    challengeRes = await fetchImpl(target, { method: "GET" });
  } catch (err) {
    return { ok: false, detail: `Could not reach merchant endpoint: ${short(err)}` };
  }
  if (challengeRes.status !== 402) {
    return { ok: false, detail: `Expected 402 from ${target}, got ${challengeRes.status}.` };
  }
  let macaroon, invoice;
  try {
    const body = await challengeRes.json();
    macaroon = body?.l402?.macaroon;
    invoice = body?.l402?.invoice;
  } catch {
    /* fall through to the missing-fields guard */
  }
  if (!macaroon || !invoice) {
    return { ok: false, detail: "402 response missing macaroon or invoice." };
  }

  // 2. Pay — one real attempt.
  let preimage;
  try {
    const result = await pay(nwcUrl, invoice, { timeoutMs: PROBE_TIMEOUT_MS });
    preimage = result.preimage;
  } catch (err) {
    return { ok: false, detail: short(err) };
  }
  if (!preimage) {
    return { ok: false, detail: "Wallet paid but returned no preimage." };
  }

  // 3. Verify — retry with the L402 credential, expect 200.
  let verifyRes;
  try {
    verifyRes = await fetchImpl(target, {
      method: "GET",
      headers: { Authorization: `L402 ${macaroon}:${preimage}` },
    });
  } catch (err) {
    return { ok: false, detail: `Verify hop failed: ${short(err)}` };
  }
  if (verifyRes.status !== 200) {
    return { ok: false, detail: `Paid, but the retried request returned ${verifyRes.status}.` };
  }
  return { ok: true, detail: null };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const nwcUrl = process.env.DEMO_AGENT_NWC_URL;
  if (!nwcUrl) {
    // Not configured — report a failed pay path so the button gates.
    const { body } = summarizeProbe({
      ok: false,
      detail: "Demo agent wallet is not configured.",
      checkedAt: new Date().toISOString(),
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(body);
  }

  // Second-layer throttle: within MIN_REPROBE_MS on a warm instance,
  // reuse the last real result instead of paying again (defends the
  // direct/cache-busted-hit path; the edge cache is the primary throttle).
  const now = Date.now();
  if (lastProbe.ok !== null && now - lastProbe.at < MIN_REPROBE_MS) {
    const { body, cacheControl } = summarizeProbe(lastProbe);
    res.setHeader("Cache-Control", cacheControl);
    return res.status(200).json(body);
  }

  const origin = inferOrigin(req);
  const outcome = await runPayProbe({ origin, nwcUrl, deps: {} });
  const checkedAt = new Date().toISOString();
  lastProbe = { at: now, ok: outcome.ok, detail: outcome.detail, checkedAt };

  const { body, cacheControl } = summarizeProbe({ ...outcome, checkedAt });
  res.setHeader("Cache-Control", cacheControl);
  return res.status(200).json(body);
}

function inferOrigin(req) {
  const host =
    req.headers["x-forwarded-host"] || req.headers.host || "demo.lightningenable.com";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

function short(err) {
  return String(err?.message ?? err).slice(0, 200);
}
