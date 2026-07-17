// Unit tests for the paid endpoints' upstream-failure contract.
// Run with `npm test`.
//
// Why this matters (the bug these tests lock down):
// `/api/premium/weather` and `/api/premium/btc-price` are L402-gated.
// By the time the upstream fetch runs, the buyer's sat is ALREADY
// spent — the invoice is paid and the preimage verified. The previous
// implementation swallowed every upstream failure and returned a
// sentinel object (`{ error: "...", price: null }`) which the handler
// then wrapped in `res.status(200)`. The buyer paid, received null,
// and the status line said it worked.
//
// That is the worst possible shape for an agent counterparty: a
// conforming client checks `res.ok`, sees 200, and never fires its
// retry / fallback / alerting path. The failure is invisible to
// exactly the layer that could react to it.
//
// The contract these tests enforce:
//   - upstream unreachable / non-2xx / malformed  → throw, status 502
//   - the requested thing genuinely doesn't exist → throw, status 404
//   - success                                     → real, typed data
// The handler maps `err.status` onto the response. Nothing returns a
// degraded 200. See the header comment in each endpoint for the
// reasoning a merchant copying these files should absorb.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchWeather } from "../api/premium/weather.js";
import { fetchBtcPrice } from "../api/premium/btc-price.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Build a Response-ish stub. */
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

/** Route mock responses by URL substring. */
function routeFetch(routes) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [needle, responder] of routes) {
      if (u.includes(needle)) {
        return typeof responder === "function" ? responder(u) : responder;
      }
    }
    throw new Error(`unrouted fetch in test: ${u}`);
  };
}

const GEO = "geocoding-api.open-meteo.com";
const FORECAST = "api.open-meteo.com/v1/forecast";
const COINGECKO = "api.coingecko.com";

const MIAMI = {
  results: [{ latitude: 25.77, longitude: -80.19, country: "United States" }],
};

// ── weather: upstream failures must throw 502, never resolve ──────

test("weather: geocoding network failure throws 502 (not a null-temperature 200)", async () => {
  routeFetch([[GEO, () => { throw new Error("ECONNRESET"); }]]);
  await assert.rejects(fetchWeather("Miami"), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, "upstream_failed");
    return true;
  });
});

test("weather: geocoding non-2xx throws 502", async () => {
  routeFetch([[GEO, jsonResponse({}, { ok: false, status: 429 })]]);
  await assert.rejects(fetchWeather("Miami"), (err) => {
    assert.equal(err.status, 502);
    return true;
  });
});

test("weather: forecast network failure throws 502", async () => {
  routeFetch([
    [GEO, jsonResponse(MIAMI)],
    [FORECAST, () => { throw new Error("socket hang up"); }],
  ]);
  await assert.rejects(fetchWeather("Miami"), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, "upstream_failed");
    return true;
  });
});

test("weather: forecast non-2xx throws 502", async () => {
  routeFetch([
    [GEO, jsonResponse(MIAMI)],
    [FORECAST, jsonResponse({}, { ok: false, status: 503 })],
  ]);
  await assert.rejects(fetchWeather("Miami"), (err) => {
    assert.equal(err.status, 502);
    return true;
  });
});

test("weather: forecast missing current_weather throws 502 (degraded payload)", async () => {
  // The daily smoke workflow had to add a `final.temperature_f`
  // numeric assertion precisely because this case used to surface
  // as a 200 with temperature_f:null. Validate at the source.
  routeFetch([
    [GEO, jsonResponse(MIAMI)],
    [FORECAST, jsonResponse({ current_weather: null })],
  ]);
  await assert.rejects(fetchWeather("Miami"), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, "upstream_malformed");
    return true;
  });
});

test("weather: non-numeric temperature throws 502", async () => {
  routeFetch([
    [GEO, jsonResponse(MIAMI)],
    [FORECAST, jsonResponse({ current_weather: { temperature: "warm" } })],
  ]);
  await assert.rejects(fetchWeather("Miami"), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, "upstream_malformed");
    return true;
  });
});

// ── weather: unsatisfiable request is 404, distinct from 502 ──────

test("weather: unknown city throws 404 city_not_found (distinct from upstream failure)", async () => {
  // Deliberately NOT 502: the upstream worked perfectly and gave a
  // definitive answer. An agent must be able to tell "retrying won't
  // help, my input was wrong" from "provider is down, back off and
  // retry" — collapsing both into one status destroys that signal.
  routeFetch([[GEO, jsonResponse({ results: [] })]]);
  await assert.rejects(fetchWeather("Xyzzyville"), (err) => {
    assert.equal(err.status, 404);
    assert.equal(err.code, "city_not_found");
    return true;
  });
});

// ── weather: success still works ──────────────────────────────────

test("weather: success returns typed data", async () => {
  routeFetch([
    [GEO, jsonResponse(MIAMI)],
    [
      FORECAST,
      jsonResponse({ current_weather: { temperature: 81.2, windspeed: 7, weathercode: 0 } }),
    ],
  ]);
  const out = await fetchWeather("Miami");
  assert.equal(out.temperature_f, 81.2);
  assert.equal(out.wind_mph, 7);
  assert.equal(out.conditions, "clear sky");
  assert.equal(out.country, "United States");
});

// ── btc-price: upstream failures must throw 502 ───────────────────

test("btc-price: non-2xx throws 502 (not a null-price 200)", async () => {
  routeFetch([[COINGECKO, jsonResponse({}, { ok: false, status: 429 })]]);
  await assert.rejects(fetchBtcPrice("USD"), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, "upstream_failed");
    return true;
  });
});

test("btc-price: network failure throws 502", async () => {
  routeFetch([[COINGECKO, () => { throw new Error("ETIMEDOUT"); }]]);
  await assert.rejects(fetchBtcPrice("USD"), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, "upstream_failed");
    return true;
  });
});

test("btc-price: missing bitcoin bucket throws 502", async () => {
  routeFetch([[COINGECKO, jsonResponse({ ethereum: { usd: 1 } })]]);
  await assert.rejects(fetchBtcPrice("USD"), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, "upstream_malformed");
    return true;
  });
});

test("btc-price: missing requested currency throws 502", async () => {
  // Asked for EUR, upstream only returned USD.
  routeFetch([[COINGECKO, jsonResponse({ bitcoin: { usd: 100000 } })]]);
  await assert.rejects(fetchBtcPrice("EUR"), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, "upstream_malformed");
    return true;
  });
});

test("btc-price: non-numeric / non-positive price throws 502", async () => {
  // Mirrors api/btc-price.js's `typeof rate !== "number" || rate <= 0`
  // guard — a zero or string rate is a broken feed, not a price.
  routeFetch([[COINGECKO, jsonResponse({ bitcoin: { usd: 0 } })]]);
  await assert.rejects(fetchBtcPrice("USD"), (err) => {
    assert.equal(err.status, 502);
    return true;
  });

  routeFetch([[COINGECKO, jsonResponse({ bitcoin: { usd: "lots" } })]]);
  await assert.rejects(fetchBtcPrice("USD"), (err) => {
    assert.equal(err.status, 502);
    return true;
  });
});

test("btc-price: success returns typed data", async () => {
  routeFetch([
    [
      COINGECKO,
      jsonResponse({
        bitcoin: { usd: 101_234.5, usd_24h_change: 2.5, last_updated_at: 1_700_000_000 },
      }),
    ],
  ]);
  const out = await fetchBtcPrice("USD");
  assert.equal(out.price, 101_234.5);
  assert.equal(out.change_24h_percent, 2.5);
  assert.equal(out.source, "coingecko.com");
});

// ── the no-hardcoded-rate invariant ───────────────────────────────

test("btc-price: never substitutes a fallback rate when upstream fails", async () => {
  // Guards the repo-wide rule that /api/btc-price.js documents:
  // "No hardcoded fallback. Refuse to mis-price." A paid endpoint
  // inventing a plausible-looking number is strictly worse than a
  // paid endpoint admitting failure — the buyer can detect the
  // latter and cannot detect the former.
  routeFetch([[COINGECKO, () => { throw new Error("upstream down"); }]]);
  await assert.rejects(fetchBtcPrice("USD"), (err) => {
    assert.equal(typeof err.price, "undefined");
    assert.equal(err.status, 502);
    return true;
  });
});
