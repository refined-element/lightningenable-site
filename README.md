# Lightning Enable — Demo

Live agentic L402 demo for [Lightning Enable](https://lightningenable.com). Deployed at `demo.lightningenable.com`. A visitor clicks one button, an autonomous agent on our server runs the full L402 buy flow against our own paid API (`402 → pay invoice → retry with credential → 200`), and the visitor watches the timeline in real time. Real Lightning, real Bitcoin, ≈ $0.0008 per call.

## Structure

```
lightningenable-demo/
├── public/
│   ├── index.html       Landing page (hero, try-it widget, why, code tabs, dashboard, pricing)
│   ├── styles.css       a-commerce-aligned dark theme
│   ├── app.js           Widget JS — calls /api/run-agent, animates trace
│   └── favicon.svg
├── api/
│   ├── premium/
│   │   ├── weather.js   Merchant endpoint — L402-gated weather (Open-Meteo upstream, free)
│   │   └── btc-price.js Merchant endpoint — L402-gated BTC price (CoinGecko upstream, free)
│   └── run-agent.js     Agent — autonomously buys from the merchant endpoints
├── vercel.json          Function durations + caching headers
└── package.json
```

## How the demo flow works

1. Visitor lands on `demo.lightningenable.com`, picks an endpoint (weather or btc-price), enters a param (city / currency), clicks **Run the agent**.
2. Browser → `POST /api/run-agent { endpoint, city|currency }`.
3. `run-agent.js` fetches the target merchant endpoint with no auth → receives 402 + invoice + macaroon.
4. `run-agent.js` pays the invoice via NWC (`DEMO_AGENT_NWC_URL` — a small CoinOS wallet I keep funded).
5. Wallet returns the preimage.
6. `run-agent.js` retries with `Authorization: L402 macaroon:preimage` → receives 200 + the actual data.
7. Trace (timings per step, amounts, preimage preview) + final response is returned to the browser.
8. Browser animates the trace and renders the final response.

The merchant endpoints use the `l402-server` npm package (LE's official Node SDK). The agent function uses the `l402-requests` npm package (`NwcWallet` for payment).

## Local dev

```bash
npm install
# Fill .env from .env.example — needs a real LE merchant API key + NWC URL
vercel dev
```

Open <http://localhost:3000>.

## Environment variables

| Name | What | Where to get |
|---|---|---|
| `LIGHTNING_ENABLE_API_KEY` | Merchant API key for the dedicated demo merchant. Must be on an Agentic Commerce plan with Strike or OpenNode configured. | <https://api.lightningenable.com/dashboard/settings> |
| `DEMO_AGENT_NWC_URL` | NWC connection string for the agent's spending wallet. Fund with ~5,000 sats. | <https://coinos.io> (create account → wallet → NWC) |

Set these in the Vercel project settings before deploying. Never commit them.

## Deploy

```bash
vercel --prod
```

Then DNS `demo.lightningenable.com` → the Vercel project. Vercel will tell you which CNAME / A record to add at Namecheap.

## Dashboard screenshots

The `Dashboard` section in `index.html` has three placeholder tiles. Once the dashboard simplification work lands, drop the real screenshots at `public/dashboard/pricing.png`, `public/dashboard/feed.png`, `public/dashboard/revenue.png` and swap the `<div class="dashboard-img dashboard-img-placeholder">` blocks for `<img>` tags. No CSS changes required — the wrapper already constrains aspect ratio.

## Visual reference

The aesthetic mirrors [a-commerce.lightningenable.com](https://a-commerce.lightningenable.com) — same near-black base (`#0a0a0a`), Lightning-orange accent (`#f7931a`), Inter for prose, JetBrains Mono for code. Single-page, no framework, no build step. Total page weight under ~30 KB before fonts.
