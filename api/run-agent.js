/**
 * Agent function: POST /api/run-agent
 *
 * The visitor presses "Run the agent" on the landing page. This function acts
 * as an autonomous L402 buyer:
 *
 *   1. Calls our own merchant endpoint (/api/premium/weather or /btc-price)
 *   2. Receives 402 + Lightning invoice + macaroon
 *   3. Pays the invoice from the demo's funded NWC wallet
 *   4. Extracts the preimage from the wallet response
 *   5. Retries the same endpoint with Authorization: L402 macaroon:preimage
 *   6. Returns the full trace (timings per step, amounts, final data) to
 *      the frontend so the visitor sees an agentic Lightning payment happen
 *      end-to-end in ~1-2 seconds.
 *
 * This is the production-shape pattern an AI agent uses to buy from any
 * L402-enabled API on the open web.
 *
 * Body shape:
 *   { endpoint: "weather", city: "Miami" }
 *   { endpoint: "btc-price", currency: "USD" }
 *
 * Response shape:
 *   {
 *     ok: true,
 *     trace: [
 *       { step, label, durationMs, ... extra }
 *     ],
 *     final: { ... the 200 response body from the merchant endpoint }
 *   }
 *
 * The frontend renders `trace` as the timeline animation and `final` as the
 * "the agent bought this" result card.
 */

import { findL402Challenge } from "l402-requests";
import { payViaNwc } from "./_lib/nwc.js";

const SUPPORTED_ENDPOINTS = new Set(["weather", "btc-price"]);
const MAX_SATS_PER_REQUEST = 25; // sanity ceiling — way above 1-sat demo prices

// NWC pay-invoice resilience. CoinOS's NWC pay path is occasionally flaky:
// it accepts the request at the relay and then doesn't answer within the
// timeout, even during otherwise-healthy windows (observed 2026-08-07 —
// get_balance instant, pay_invoice hung, balance never moved). The daily
// smoke test rides through these blips because it retries; a visitor's
// single click did not, so a prospect saw an error on a flow that would
// have succeeded on a second try. Retry the SAME invoice on transient
// failures — double-spend-safe because a BOLT11 payment_hash settles at
// most once (a re-pay returns the same preimage or a benign "already
// paid", never a second HTLC).
//
// Budget: PAY_MAX_ATTEMPTS × PAY_ATTEMPT_TIMEOUT_MS plus the two HTTP
// hops and backoff MUST stay under the 60s Vercel maxDuration in
// vercel.json. The challenge + verify hops each call /api/premium/*,
// which has its own 10s maxDuration, so budget them at ~10s apiece:
// 10 + (2 × 15s + 0.75s) + 10 ≈ 51s worst case, safely under 60. (An
// earlier 2 × 20s could reach ~61s when both hops ran slow → an HTML
// 504 instead of clean JSON.)
// Note: retry only helps single-call blips; a sustained multi-minute
// wallet/relay outage still fails (both attempts time out) — that case
// is on the wallet, not this code.
const PAY_MAX_ATTEMPTS = 2;
const PAY_ATTEMPT_TIMEOUT_MS = 15_000;
const PAY_RETRY_BACKOFF_MS = 750;

// Lightweight abuse defense. Real damage from a drain attack is small
// (sats go to LE merchant 5 = the operator's own account; cost is the
// refill, not theft), but we don't want a `while true; do curl ...`
// loop draining the CoinOS wallet faster than a daily refill replenishes.
//
// COOLDOWN_MS:  per-IP minimum gap between accepted clicks. Vercel
//   serverless instances are warm-reused for many invocations from the
//   same region, so a single in-memory Map catches the dumbest case
//   (one IP spamming). Sophisticated attackers rotate IPs — but the
//   real cap is the wallet-side CoinOS NWC spend limit; this is just
//   speed-bump #1.
//
// ALLOWED_ORIGINS: only allow POST when the Referer is the demo site
//   itself, OR is absent (curl/Postman/legitimate API testing). Bots
//   that copy-paste the endpoint into a script usually include a
//   bogus or missing Referer; bots driving a real browser context
//   match. This is speed-bump #2.
const COOLDOWN_MS = 30_000;
const ALLOWED_ORIGINS = new Set([
  "https://demo.lightningenable.com",
  "https://lightningenable.com",
  "https://www.lightningenable.com",
  // Local dev: `vercel dev` runs on http://localhost:3000 — without
  // this entry the Referer check would reject every dev request.
  "http://localhost:3000",
  // Vercel previews — wildcards aren't trivially supported in a Set,
  // so the check below also accepts *.vercel.app for the preview flow
]);
const ipLastSeen = new Map();

function isAllowedOrigin(req) {
  // Referer is the page from which the click came. For same-origin
  // POSTs the browser sends it; curl/scripts often omit it. Empty
  // Referer is allowed (the agent endpoint is intentionally
  // CLI-callable for documentation purposes), but a Referer pointing
  // at someone else's domain is suspicious.
  const referer = req.headers["referer"] || req.headers["referrer"] || "";
  if (!referer) return true;
  try {
    const origin = new URL(referer).origin;
    if (ALLOWED_ORIGINS.has(origin)) return true;
    // Vercel preview deploys live under *.vercel.app; allow them so
    // PR previews can exercise the flow.
    if (origin.endsWith(".vercel.app")) return true;
    return false;
  } catch {
    // Malformed Referer — reject.
    return false;
  }
}

function clientIp(req) {
  // Vercel surfaces the original visitor IP in x-forwarded-for. Trust
  // the first comma-separated value; subsequent entries are upstream
  // proxies.
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Abuse defense — speed-bump #2 (Referer) before any work.
  if (!isAllowedOrigin(req)) {
    return res.status(403).json({
      ok: false,
      error: "Request origin not allowed for the live agent flow. " +
             "If you're testing programmatically, send the request from " +
             "the demo's domain or with no Referer header.",
    });
  }

  // Abuse defense — speed-bump #1 (per-IP cooldown). Best-effort:
  // Vercel warm-instance reuse means most spam from one IP hits the
  // same function instance, so the Map sees it. Cold starts reset the
  // map (acceptable — a determined attacker rotating IPs or waiting
  // for cold instances is bounded by the CoinOS wallet's own
  // daily-spend cap, which is the real defense).
  //
  // CHECK the cooldown here, but only RECORD it AFTER request
  // validation succeeds. Otherwise malformed/unsupported requests
  // (400/500) would burn the cooldown without doing any work — an
  // attacker hammering with invalid bodies could force a long stretch
  // of 429s on legitimate visitors sharing their IP (NAT, corporate
  // gateways, mobile carrier IPs).
  const ip = clientIp(req);
  const now = Date.now();
  const last = ipLastSeen.get(ip);
  if (last && now - last < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
    res.setHeader("Retry-After", String(wait));
    return res.status(429).json({
      ok: false,
      error: `Demo cooldown active — please wait ${wait}s before running the agent again. ` +
             "This is a per-visitor rate limit on the demo only; your real production " +
             "L402 endpoints have no such limit.",
    });
  }

  // Parse body. Vercel auto-parses application/json into req.body.
  const body = req.body || {};
  const endpoint = String(body.endpoint || "").trim();
  if (!SUPPORTED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({
      ok: false,
      error: `Unknown endpoint "${endpoint}". Expected one of: ${[...SUPPORTED_ENDPOINTS].join(", ")}`,
    });
  }

  const nwcUrl = process.env.DEMO_AGENT_NWC_URL;
  if (!nwcUrl) {
    return res.status(500).json({
      ok: false,
      error:
        "Demo agent wallet is not configured. Set DEMO_AGENT_NWC_URL in Vercel project settings to a funded NWC connection (e.g. coinos.io).",
    });
  }

  // Validation passed AND environment configured — record the cooldown
  // timestamp now so only legitimate work-doing requests consume it.
  // Doing this AFTER the env-var check too means a misconfigured server
  // (500-returning) doesn't burn the cooldown for visitors — they can
  // retry as soon as the env var is fixed.
  ipLastSeen.set(ip, now);
  // Light prune so the Map doesn't grow unbounded over a long-warm
  // instance lifetime. Only sweeps when the Map gets larger than 1k
  // entries; sweep removes anything older than 10× the cooldown.
  if (ipLastSeen.size > 1000) {
    const cutoff = now - COOLDOWN_MS * 10;
    for (const [k, v] of ipLastSeen) {
      if (v < cutoff) ipLastSeen.delete(k);
    }
  }

  // Build the target URL. Same host as ourselves so /api/premium/* resolves
  // to the merchant function next door.
  const origin = inferOriginFromRequest(req);
  const targetUrl = buildTargetUrl(origin, endpoint, body);

  const trace = [];
  const startedAt = Date.now();

  // ── Step 1: hit the endpoint with no credential, expect 402 ──────────────
  const stepOneStart = Date.now();
  let challengeResponse;
  try {
    challengeResponse = await fetch(targetUrl, { method: "GET" });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `Agent failed to reach merchant endpoint: ${err?.message ?? err}`,
      trace,
    });
  }

  if (challengeResponse.status !== 402) {
    // Either the endpoint returned 200 already (no auth required — unexpected
    // for a /premium/ route) or it returned an error.
    const bodyText = await safeText(challengeResponse);
    return res.status(502).json({
      ok: false,
      error: `Agent expected 402 but got ${challengeResponse.status} from ${targetUrl}`,
      details: bodyText.slice(0, 500),
      trace,
    });
  }

  // Prefer the WWW-Authenticate header (RFC-compliant); fall back to JSON body.
  const wwwAuth = challengeResponse.headers.get("www-authenticate") || "";
  let macaroon, invoice, paymentHash, amountSats;
  const parsedHeader = findL402Challenge(wwwAuth);
  if (parsedHeader) {
    macaroon = parsedHeader.macaroon;
    invoice = parsedHeader.invoice;
  }
  // Pull supplementary fields from the JSON body too (LE returns both).
  let challengeJson = null;
  try {
    challengeJson = await challengeResponse.json();
    macaroon ??= challengeJson?.l402?.macaroon;
    invoice ??= challengeJson?.l402?.invoice;
    paymentHash = challengeJson?.l402?.payment_hash;
    amountSats = challengeJson?.l402?.amount_sats;
  } catch {
    // body wasn't json; we have the header parse, that's enough.
  }

  if (!macaroon || !invoice) {
    return res.status(502).json({
      ok: false,
      error: "Agent could not parse macaroon or invoice from 402 response.",
      trace,
    });
  }

  trace.push({
    step: 1,
    label: "Requested resource — got 402",
    durationMs: Date.now() - stepOneStart,
    amountSats: amountSats ?? null,
    paymentHash: paymentHash ?? null,
  });

  if (amountSats && amountSats > MAX_SATS_PER_REQUEST) {
    return res.status(400).json({
      ok: false,
      error: `Invoice asks for ${amountSats} sats, demo cap is ${MAX_SATS_PER_REQUEST}. Refusing to pay.`,
      trace,
    });
  }

  // ── Step 2: pay the invoice via inline NWC ─────────────────────────────
  // Inline implementation (api/_lib/nwc.js) replaces l402-requests'
  // NwcWallet because that wallet silently drops relay "OK" messages —
  // which is how the relay tells us our event was rejected (bad sig,
  // rate-limit, etc.). Without surfacing those, a hung payment looks
  // identical to a sig-rejected one, and "fix it without my help" is
  // impossible. The inline version captures every relay message into a
  // diagnostic trace, which is returned in the response body on failure.
  //
  // Each attempt uses a timeout < the 60s Vercel maxDuration, and the
  // whole retry budget stays under it too (see the PAY_* constants), so a
  // hung wallet throws inside the catch and returns clean JSON rather than
  // being killed by the platform as an HTML 504. `payInvoiceWithRetry`
  // retries the SAME invoice on transient failures (relay/timeout/ws) and
  // gives up immediately on deterministic wallet errors.
  const stepTwoStart = Date.now();
  let preimage;
  let nwcTrace;
  let payAttempts = 1;
  try {
    const result = await payInvoiceWithRetry(
      (inv, opts) => payViaNwc(nwcUrl, inv, opts),
      invoice,
      {
        maxAttempts: PAY_MAX_ATTEMPTS,
        timeoutMs: PAY_ATTEMPT_TIMEOUT_MS,
        backoffMs: PAY_RETRY_BACKOFF_MS,
      },
    );
    preimage = result.preimage;
    nwcTrace = result.trace;
    payAttempts = result.attempts;
  } catch (err) {
    const elapsedMs = Date.now() - stepTwoStart;
    return res.status(502).json({
      ok: false,
      error: `Agent wallet failed to pay invoice (after ${elapsedMs}ms): ${err?.message ?? err}`,
      trace,
      nwcTrace: err?.trace ?? null,
    });
  }

  trace.push({
    step: 2,
    label: "Paid invoice over Lightning",
    durationMs: Date.now() - stepTwoStart,
    preimagePreview: preimage.slice(0, 16) + "…",
    nwcSteps: nwcTrace?.length ?? 0,
    // 1 on the happy path; 2 when a transient NWC blip forced a retry.
    // Surfaced for the smoke test / observability; the frontend ignores it.
    attempts: payAttempts,
  });

  // ── Step 3: retry with L402 token ───────────────────────────────────────
  const stepThreeStart = Date.now();
  let finalResponse;
  try {
    finalResponse = await fetch(targetUrl, {
      method: "GET",
      headers: { Authorization: `L402 ${macaroon}:${preimage}` },
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `Agent retry failed: ${err?.message ?? err}`,
      trace,
    });
  }

  if (!finalResponse.ok) {
    const bodyText = await safeText(finalResponse);
    return res.status(502).json({
      ok: false,
      error: `Agent retry returned ${finalResponse.status} from ${targetUrl}`,
      details: bodyText.slice(0, 500),
      trace,
    });
  }

  const finalBody = await finalResponse.json();

  trace.push({
    step: 3,
    label: "Got the data",
    durationMs: Date.now() - stepThreeStart,
    httpStatus: finalResponse.status,
  });

  return res.status(200).json({
    ok: true,
    totalMs: Date.now() - startedAt,
    totalSats: amountSats ?? null,
    trace,
    final: finalBody,
  });
}

function inferOriginFromRequest(req) {
  // Vercel exposes the deployment URL via headers. Prefer x-forwarded-host
  // (the real public host), fall back to host header. Always use https.
  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "demo.lightningenable.com";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

function buildTargetUrl(origin, endpoint, body) {
  const url = new URL(`${origin}/api/premium/${endpoint}`);
  if (endpoint === "weather") {
    if (body.city) url.searchParams.set("city", String(body.city).slice(0, 64));
  } else if (endpoint === "btc-price") {
    if (body.currency)
      url.searchParams.set(
        "currency",
        String(body.currency).slice(0, 8).toUpperCase(),
      );
  }
  return url.toString();
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Classify a payViaNwc failure as transient (worth retrying) vs
 * deterministic (a retry can't help). Transient failures are ones a
 * second attempt could clear: an NWC round-trip timeout, a relay
 * rejection/connection blip, or a malformed "no preimage" reply.
 * An explicit wallet-side NWC error (insufficient balance, restricted,
 * quota) is deterministic — retrying just delays the same outcome.
 * Unknown/empty errors fail closed (treated as non-retryable).
 *
 * Exported for unit testing (tests/pay-invoice-retry.test.js).
 */
export function isRetryablePayError(err) {
  const s = String(err?.message ?? err ?? "");
  if (!s) return false;
  // An explicit wallet-side NWC error is deterministic — never retry.
  if (/Wallet returned NWC error/i.test(s)) return false;
  return (
    /NWC payment timed out/i.test(s) ||
    /Relay rejected/i.test(s) ||
    /WebSocket error/i.test(s) ||
    /Could not open WebSocket/i.test(s) ||
    /no error but no preimage/i.test(s)
  );
}

/**
 * Pay a BOLT11 invoice with bounded retries on transient failures.
 *
 * Retries the SAME invoice (never a fresh mint): a BOLT11 payment_hash
 * settles at most once, so re-paying an invoice whose first attempt
 * secretly settled in-flight returns the same preimage (or a benign
 * "already paid") rather than moving funds twice — double-spend-safe by
 * construction.
 *
 * @param {(invoice: string, opts: {timeoutMs: number}) => Promise<{preimage: string, trace: object[]}>} payFn
 *   the injected pay call (payViaNwc in production, a fake in tests)
 * @param {string} invoice  BOLT11 to pay
 * @param {{maxAttempts?: number, timeoutMs?: number, backoffMs?: number,
 *          isRetryable?: (err: unknown) => boolean,
 *          sleep?: (ms: number) => Promise<void>}} [opts]
 * @returns {Promise<{preimage: string, trace: object[], attempts: number}>}
 *   the payFn result plus `attempts` = the 1-based attempt that succeeded.
 *   Throws the last error (with its diagnostic `.trace` intact) when all
 *   attempts fail or the failure is deterministic.
 *
 * Exported for unit testing (tests/pay-invoice-retry.test.js).
 */
export async function payInvoiceWithRetry(payFn, invoice, opts = {}) {
  const {
    maxAttempts = PAY_MAX_ATTEMPTS,
    timeoutMs = PAY_ATTEMPT_TIMEOUT_MS,
    backoffMs = PAY_RETRY_BACKOFF_MS,
    isRetryable = isRetryablePayError,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await payFn(invoice, { timeoutMs });
      return { ...result, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      await sleep(backoffMs);
    }
  }
  // Unreachable — the loop returns on success or throws on the final
  // attempt — but keep readers honest and fail loud if that ever breaks.
  throw lastErr;
}
