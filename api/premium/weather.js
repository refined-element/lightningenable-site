/**
 * Merchant endpoint: GET /api/premium/weather?city=Miami
 *
 * Issues a 402 Payment Required + Lightning invoice when the request has no
 * valid L402 token. Returns 200 + weather data when a valid token is supplied.
 *
 * This is what every "monetize an API with Lightning Enable" customer does
 * in their own code: wrap a route with the L402 middleware, charge sats,
 * keep the rest of their handler unchanged.
 *
 * Upstream data: Open-Meteo (free, no auth, no per-call cost).
 *
 * ── The delivery contract (copy this part too) ──────────────────────
 *
 * An L402 route has a property an unpaid route doesn't: by the time the
 * handler reaches its upstream call, the buyer's money is already gone.
 * The invoice is settled, the preimage is spent. From that line on, the
 * only open question is whether the merchant honors the trade.
 *
 * That makes the status code stop being a formality. It is the
 * merchant's answer to "did I get what I paid for?", and it is the ONLY
 * answer an automated counterparty reads. A response like
 * `200 { error: "provider failed", temperature_f: null }` tells a
 * conforming agent the trade COMPLETED: its retry never fires, its
 * fallback provider is never tried, its alerting never opens. The buyer
 * is out a sat and — the real damage — doesn't know it. A detectable
 * failure costs one sat. A silent one corrupts every decision the agent
 * makes downstream on data it believes is good.
 *
 * The rule this file follows, and that you should keep when you copy it:
 * NEVER return 2xx for data you did not deliver.
 *   - upstream down / non-2xx / garbage → 502 + Cache-Control: no-store
 *   - request can't be satisfied at all → 404 (retrying will not help)
 *   - delivered                         → 200 + real, type-checked data
 *
 * Both failure paths echo the settled payment (`l402.paid: true`,
 * `delivered: false`) so the buyer can tie the loss to a payment hash
 * instead of just observing that something went wrong.
 *
 * This mirrors `/api/btc-price.js`, which refuses to invent a rate when
 * its sources fail and returns 503 rather than a plausible number. Same
 * principle, higher stakes: that endpoint is free; this one has already
 * been paid for.
 *
 * What this file deliberately does NOT decide for you: whether a buyer
 * who hit a 502 gets a fresh credential or a refund. Lightning Enable
 * tracks consumed preimages centrally for replay protection, so whether
 * a buyer's existing token still works on a retry is your LE-side
 * policy, not a property of this handler. Decide it on purpose and
 * publish it. "Paid, undelivered, no stated remedy" is also a policy —
 * just the one that loses you the customer.
 */

import { L402Server } from "l402-server";

const PRICE_SATS = 1;

const apiKey = process.env.LIGHTNING_ENABLE_API_KEY;
const baseUrl =
  process.env.LIGHTNING_ENABLE_API_BASE_URL ||
  "https://api.lightningenable.com";

// Lazily construct so build-time prerender doesn't require the env var.
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

  const city = (req.query.city || "Miami").toString().slice(0, 64);
  const auth = req.headers.authorization || "";
  const parsed = parseL402(auth);

  // No credential → mint a 402 challenge.
  if (!parsed) {
    try {
      // `idempotencyKey` is unique per call here so each visitor click
      // on the public demo gets a fresh Lightning invoice. The LE
      // producer API dedupes by resource+price within a 60s window by
      // default, which is the correct behavior for real merchants
      // (prevents charging twice on a network retry) but the wrong
      // behavior for a public demo where back-to-back clicks need
      // independent invoices. A real merchant copying this file as a
      // starting point should DELETE the `idempotencyKey` line to
      // restore retry-safe defaults.
      const challenge = await l402().createChallenge({
        resource: `/api/premium/weather`,
        priceSats: PRICE_SATS,
        description: `Weather for ${city}`,
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

  // Credential present → verify with the producer API.
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

  // Token good — the sat is SPENT as of this line. Everything below is
  // the merchant's half of the trade: deliver, or say plainly that we
  // couldn't. `fetchWeather` throws rather than returning a degraded
  // object precisely so that "no data" cannot silently fall through
  // into the 200 below.
  let weather;
  try {
    weather = await fetchWeather(city);
  } catch (err) {
    return sendUndeliverable(res, err, verification);
  }

  // Paid responses must never sit in a shared cache: a cached 200 is a
  // copy of the goods served to the next caller for free, behind the
  // gate's back. `vercel.json` already sets this for `/api/premium/*`,
  // so this is a no-op here — it's repeated in-handler for the same
  // reason as on the failure path: the guarantee has to travel with the
  // code when this file gets copied somewhere without that config.
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    city,
    ...weather,
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
 * The paid-but-undelivered response. Called only after the buyer's
 * payment has been verified, so it always reports `paid: true`.
 */
function sendUndeliverable(res, err, verification) {
  const status = err?.status ?? 502;
  // `no-store` matters most on THIS path. Without it an intermediate
  // cache can memoize "undeliverable" and keep serving it after the
  // upstream recovers — converting a 30-second blip into a full TTL of
  // buyers each paying a sat to receive a cached failure. Same
  // reasoning as the 503 path in `/api/btc-price.js`.
  //
  // `vercel.json` already sets no-store for `/api/premium/*`, so this
  // line is redundant *in this repo*. It is here on purpose: this file
  // is meant to be copied into projects that have no such config, and
  // the guarantee should travel with the code that depends on it.
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({
    error: status === 404 ? "Not Found" : "Bad Gateway",
    code: err?.code ?? "upstream_failed",
    message: err?.message ?? String(err),
    // Echo the settled payment: a buyer who can't tie this failure back
    // to a payment hash can't reconcile it, can't claim a remedy, and
    // can't prove it happened.
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

/**
 * An upstream problem, carrying the HTTP status the handler should
 * surface. Defined locally rather than imported from a shared `_lib`
 * so this file stays self-contained and survives being copied out
 * whole — which is its actual job.
 */
class UpstreamError extends Error {
  constructor(message, { status = 502, code = "upstream_failed" } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
  }
}

// Per-request timeout. `vercel.json` caps this function at 10s, and we
// make two sequential upstream calls, so each gets 3s — leaving room
// for the L402 verification hop that already happened plus cold-start
// overhead. Without an explicit timeout a hung upstream burns the whole
// budget and the platform returns its own 504 with an HTML body, which
// is a worse (unparseable) failure than the JSON 502 below. Deliberate
// choice: own the failure rather than let the platform improvise it.
const UPSTREAM_TIMEOUT_MS = 3000;

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
 * Fetch current weather via Open-Meteo (free, no auth). Geocodes the city
 * name first, then queries the current-weather endpoint.
 *
 * THROWS on any failure — never returns a half-empty object. The caller
 * has already taken the buyer's sat, so "temperature_f: null" is not a
 * result we're entitled to hand back as success. Each throw carries the
 * status the buyer should see: 502 when we broke, 404 when the request
 * was never satisfiable.
 */
async function fetchWeather(city) {
  // ── Geocode ──
  let geoData;
  try {
    const geo = await fetchWithTimeout(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&format=json`,
    );
    if (!geo.ok) {
      throw new UpstreamError(`Geocoding provider returned HTTP ${geo.status}.`);
    }
    geoData = await geo.json();
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError(
      `Geocoding provider unreachable: ${err?.message ?? String(err)}`,
    );
  }

  const place = geoData?.results?.[0];
  if (!place) {
    // NOT a 502: the upstream worked fine and gave a definitive answer.
    // An agent has to be able to tell "my input was wrong, retrying is
    // pointless" apart from "the provider is down, back off and retry".
    // Collapsing both into one status destroys the only signal it has
    // to choose between those behaviors.
    throw new UpstreamError(`No location matches "${city}".`, {
      status: 404,
      code: "city_not_found",
    });
  }

  // ── Current conditions ──
  let wData;
  try {
    const w = await fetchWithTimeout(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current_weather=true&temperature_unit=fahrenheit`,
    );
    if (!w.ok) {
      throw new UpstreamError(`Weather provider returned HTTP ${w.status}.`);
    }
    wData = await w.json();
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError(
      `Weather provider unreachable: ${err?.message ?? String(err)}`,
    );
  }

  // Type-check the field the buyer actually paid for. A 200 carrying
  // `temperature: null` is the upstream's way of failing quietly; if we
  // pass it through we adopt its lie as our own. (The daily smoke
  // workflow had to grow a `final.temperature_f` numeric assertion to
  // catch exactly this — validate at the source instead.)
  const cw = wData?.current_weather;
  if (!cw || typeof cw.temperature !== "number") {
    throw new UpstreamError(
      "Weather provider response missing a numeric current_weather.temperature.",
      { code: "upstream_malformed" },
    );
  }

  return {
    temperature_f: cw.temperature,
    wind_mph: typeof cw.windspeed === "number" ? cw.windspeed : null,
    conditions: weatherCodeToText(cw.weathercode),
    country: place.country,
    lat: place.latitude,
    lon: place.longitude,
  };
}

export { fetchWeather };

function weatherCodeToText(code) {
  if (code == null) return "unknown";
  if (code === 0) return "clear sky";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "foggy";
  if (code <= 67) return "rainy";
  if (code <= 77) return "snowy";
  if (code <= 82) return "showers";
  if (code <= 99) return "thunderstorm";
  return "unknown";
}
