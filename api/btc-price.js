/**
 * Public BTC/USD spot price for the demo's trace footer dollar conversion.
 *
 * Mirrors the multi-source / fail-loud pattern of the LE backend's
 * BitcoinPriceService (CoinGecko, Coinbase, Kraken in parallel,
 * first-success wins, NO hardcoded fallback). The demo refuses to display
 * a fake rate — if every source fails, the client gets a 503 and the
 * trace footer renders "$— (price unavailable)" instead of a stale
 * hardcoded number.
 *
 * Cached at the edge for 60 seconds (`Cache-Control: s-maxage=60`) plus
 * a brief stale-while-revalidate window so a momentary upstream failure
 * doesn't immediately stop returning a rate.
 *
 * Separate from `/api/premium/btc-price.js` — that endpoint is
 * L402-gated by design (it's part of the L402 demo). This one is
 * unpaywalled so the front-end can populate the trace-footer USD
 * estimate without paying a sat per page view.
 */

const PER_SOURCE_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = PER_SOURCE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...opts,
            signal: controller.signal,
            headers: {
                "User-Agent": "LightningEnable-Demo/1.0",
                "Accept": "application/json",
                ...(opts.headers || {}),
            },
        });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchCoinGecko() {
    const res = await fetchWithTimeout(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    );
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const j = await res.json();
    const rate = j?.bitcoin?.usd;
    if (typeof rate !== "number" || rate <= 0) {
        throw new Error("CoinGecko response missing bitcoin.usd");
    }
    return rate;
}

async function fetchCoinbase() {
    const res = await fetchWithTimeout(
        "https://api.coinbase.com/v2/prices/BTC-USD/spot"
    );
    if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
    const j = await res.json();
    const raw = j?.data?.amount;
    const rate = raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error("Coinbase response missing data.amount");
    }
    return rate;
}

async function fetchKraken() {
    const res = await fetchWithTimeout(
        "https://api.kraken.com/0/public/Ticker?pair=XBTUSD"
    );
    if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
    const j = await res.json();
    if (Array.isArray(j?.error) && j.error.length > 0) {
        throw new Error(`Kraken error: ${j.error[0]}`);
    }
    const result = j?.result;
    if (!result) throw new Error("Kraken response missing result");
    // Pair key is "XXBTZUSD" or "XBTUSD" depending on Kraken's mood.
    for (const key of Object.keys(result)) {
        const close = result[key]?.c;
        if (Array.isArray(close) && close[0]) {
            const rate = Number(close[0]);
            if (Number.isFinite(rate) && rate > 0) return rate;
        }
    }
    throw new Error("Kraken response missing close price");
}

async function firstSuccessful() {
    // Race all three. Promise.any resolves with the first fulfillment;
    // if every promise rejects, it rejects with AggregateError carrying
    // the per-source reasons — useful for the 503 response body.
    const sources = [
        ["CoinGecko", fetchCoinGecko()],
        ["Coinbase", fetchCoinbase()],
        ["Kraken", fetchKraken()],
    ];
    const labelled = sources.map(([name, p]) =>
        p.then((rate) => ({ rate, source: name }))
            .catch((err) => Promise.reject({ source: name, message: err?.message || String(err) }))
    );
    try {
        return await Promise.any(labelled);
    } catch (agg) {
        const failures = (agg?.errors || []).map(
            (e) => `${e?.source || "?"}: ${e?.message || "unknown"}`
        );
        const err = new Error(failures.join("; ") || "all sources failed");
        err.failures = failures;
        throw err;
    }
}

export default async function handler(req, res) {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { rate, source } = await firstSuccessful();
        // 60s edge cache + 5 min stale-while-revalidate: a brief upstream
        // outage won't pop "price unavailable" if a fresh-ish cached value
        // is still on disk somewhere.
        res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
        return res.status(200).json({
            rate,
            source,
            timestamp: new Date().toISOString(),
        });
    } catch (err) {
        // No hardcoded fallback. Mirrors BitcoinPriceService behavior:
        // refuse to mis-price; the client renders "unavailable" instead.
        return res.status(503).json({
            error: "BTC price unavailable",
            details: err?.failures || [err?.message || "unknown"],
        });
    }
}
