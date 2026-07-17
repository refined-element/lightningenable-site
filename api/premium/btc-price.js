/**
 * Merchant endpoint: GET /api/premium/btc-price?currency=USD
 *
 * Same L402 shape as /api/premium/weather. Returns the current BTC price plus
 * 24-hour change for the requested fiat currency. Demonstrates a second
 * paid endpoint living next to the weather one, with a different upstream
 * data source — illustrating that L402 is endpoint-agnostic.
 *
 * Upstream data: CoinGecko's public price API (free, no auth, lenient rate
 * limit).
 *
 * Follows the same delivery contract as `weather.js` — read the header
 * comment there for the full reasoning. In short: past the L402 gate the
 * buyer's sat is already spent, so the status code is the merchant's
 * answer to "did I get what I paid for?" and the only answer an agent
 * reads. Upstream failure → 502 + no-store, never a 200 carrying
 * `price: null`.
 *
 * Prices make the stakes concrete. A silent `price: null` is bad; a
 * plausible-but-wrong number would be worse, because a buyer can detect
 * the first and cannot detect the second. So there is NO fallback rate
 * here, matching the unpaid `/api/btc-price.js` which races three
 * sources and still returns 503 rather than invent one. An endpoint that
 * charges for a number has a stronger obligation to be right about it,
 * not a weaker one.
 */

import { L402Server } from "l402-server";

const PRICE_SATS = 1;
const SUPPORTED_CURRENCIES = new Set([
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CAD",
  "AUD",
  "CHF",
  "CNY",
]);

const apiKey = process.env.LIGHTNING_ENABLE_API_KEY;
const baseUrl =
  process.env.LIGHTNING_ENABLE_API_BASE_URL ||
  "https://api.lightningenable.com";

let _l402 = null;
function l402() {
  if (_l402) return _l402;
  if (!apiKey) {
    throw new Error(
      "LIGHTNING_ENABLE_API_KEY is not set. Configure it in Vercel project settings.",
    );
  }
  _l402 = new L402Server({ apiKey, baseUrl });
  return _l402;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const requestedCurrency = (req.query.currency || "USD")
    .toString()
    .toUpperCase()
    .slice(0, 8);
  const currency = SUPPORTED_CURRENCIES.has(requestedCurrency)
    ? requestedCurrency
    : "USD";

  const auth = req.headers.authorization || "";
  const parsed = parseL402(auth);

  if (!parsed) {
    try {
      // `idempotencyKey` is unique per call so each visitor click on
      // the public demo gets a fresh Lightning invoice. See the same
      // comment in `weather.js` for why this is a demo-specific
      // override; real merchants should drop the field to restore
      // retry-safe deduplication.
      const challenge = await l402().createChallenge({
        resource: `/api/premium/btc-price`,
        priceSats: PRICE_SATS,
        description: `BTC price in ${currency}`,
        idempotencyKey: crypto.randomUUID(),
      });
      res.setHeader(
        "WWW-Authenticate",
        `L402 macaroon="${challenge.macaroon}", invoice="${challenge.invoice}"`,
      );
      return res.status(402).json({
        error: "Payment Required",
        l402: {
          macaroon: challenge.macaroon,
          invoice: challenge.invoice,
          amount_sats: challenge.priceSats,
          payment_hash: challenge.paymentHash,
          expires_at: challenge.expiresAt,
          resource: challenge.resource,
        },
      });
    } catch (err) {
      return res
        .status(502)
        .json({ error: "Bad Gateway", message: err?.message ?? String(err) });
    }
  }

  let verification;
  try {
    verification = await l402().verifyToken({
      macaroon: parsed.macaroon,
      preimage: parsed.preimage,
    });
  } catch (err) {
    return res
      .status(502)
      .json({ error: "Bad Gateway", message: err?.message ?? String(err) });
  }

  if (!verification.valid) {
    return res.status(401).json({
      error: "Unauthorized",
      message: verification.error || "Invalid L402 credential.",
    });
  }

  // Token good — the sat is SPENT as of this line. `fetchBtcPrice`
  // throws rather than returning `{ price: null }` so that "no price"
  // cannot silently fall through into the 200 below.
  let price;
  try {
    price = await fetchBtcPrice(currency);
  } catch (err) {
    return sendUndeliverable(res, err, verification);
  }

  // No shared caching of paid responses — see `weather.js`. Already
  // covered by `vercel.json` here; repeated so a copied file keeps the
  // guarantee.
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    currency,
    ...price,
    timestamp: new Date().toISOString(),
    l402: {
      valid: true,
      paid: true,
      delivered: true,
      resource: verification.resource,
      merchantId: verification.merchantId,
      amountSats: verification.amountSats,
      paymentHash: verification.paymentHash,
    },
  });
}

/**
 * The paid-but-undelivered response. Called only after payment has been
 * verified, so it always reports `paid: true`. See `weather.js` for why
 * `no-store` is set here explicitly even though `vercel.json` already
 * covers `/api/premium/*`.
 */
function sendUndeliverable(res, err, verification) {
  const status = err?.status ?? 502;
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({
    error: status === 404 ? "Not Found" : "Bad Gateway",
    code: err?.code ?? "upstream_failed",
    message: err?.message ?? String(err),
    // Echo the settled payment so the buyer can tie this failure to the
    // sat it cost them.
    l402: {
      valid: true,
      paid: true,
      delivered: false,
      resource: verification.resource,
      merchantId: verification.merchantId,
      amountSats: verification.amountSats,
      paymentHash: verification.paymentHash,
    },
  });
}

function parseL402(authHeader) {
  if (!authHeader || !authHeader.startsWith("L402 ")) return null;
  const rest = authHeader.slice("L402 ".length);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  return {
    macaroon: rest.slice(0, idx).trim(),
    preimage: rest.slice(idx + 1).trim(),
  };
}

export { fetchBtcPrice };

/**
 * An upstream problem, carrying the HTTP status the handler should
 * surface. Defined locally rather than imported from a shared `_lib` so
 * this file stays self-contained when copied out.
 */
class UpstreamError extends Error {
  constructor(message, { status = 502, code = "upstream_failed" } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
  }
}

// One upstream call, 5s of the function's 10s `vercel.json` budget —
// same reasoning as `weather.js`: own the timeout so the failure is our
// JSON 502 rather than the platform's HTML 504.
const UPSTREAM_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "LightningEnable-Demo/1.0",
        Accept: "application/json",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the BTC price from CoinGecko.
 *
 * THROWS on any failure — never returns `{ price: null }`, and never
 * substitutes a fallback rate. The caller has already taken the buyer's
 * sat; the only honest outcomes are a real price or an admitted failure.
 */
async function fetchBtcPrice(currency) {
  const k = currency.toLowerCase();

  let data;
  try {
    const r = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${k}&include_24hr_change=true&include_last_updated_at=true`,
    );
    if (!r.ok) {
      // 429 lands here a lot — CoinGecko's free tier rate-limits. That
      // is precisely a "come back later" the buyer needs to hear, not
      // something to paper over with a null.
      throw new UpstreamError(`Price provider returned HTTP ${r.status}.`);
    }
    data = await r.json();
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError(
      `Price provider unreachable: ${err?.message ?? String(err)}`,
    );
  }

  const bucket = data?.bitcoin;
  if (!bucket) {
    throw new UpstreamError("Price provider response missing the bitcoin key.", {
      code: "upstream_malformed",
    });
  }

  // Type-check the number the buyer paid for, mirroring the guard in
  // `/api/btc-price.js` (`typeof rate !== "number" || rate <= 0`). A
  // zero, a string, or a missing currency key is a broken feed — not a
  // price — and shipping it as one would make us the source of the bad
  // data rather than a victim of it.
  const price = bucket[k];
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new UpstreamError(
      `Price provider returned no usable ${currency} rate.`,
      { code: "upstream_malformed" },
    );
  }

  const change = bucket[`${k}_24h_change`];
  return {
    price,
    // The 24h change is genuinely optional metadata, not the thing being
    // sold — null here is honest reporting, not a swallowed failure.
    change_24h_percent: typeof change === "number" ? change : null,
    source: "coingecko.com",
    source_updated_at: bucket.last_updated_at
      ? new Date(bucket.last_updated_at * 1000).toISOString()
      : null,
  };
}
