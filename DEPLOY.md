# Lightning Enable Demo — Deployment

End-to-end steps to ship `demo.lightningenable.com` (later, the apex
`lightningenable.com`) on Vercel.

## Prereqs

- [Vercel CLI](https://vercel.com/docs/cli) installed (`npm i -g vercel`)
- Logged into Vercel (`vercel login`)
- A new merchant API key on api.lightningenable.com (rotation done
  2026-05-14; new key in `$env:TEMP\le-demo-key.txt`)
- An NWC URL from a funded CoinOS wallet (or any NWC-capable wallet) —
  optional for first deploy, the demo agent endpoint will return an
  error until set, which is expected

## First deploy

```powershell
cd F:\lightningenable-demo

# 1. Link to (or create) the Vercel project.
vercel link
#    Prompt: ? Set up "F:\lightningenable-demo"?           Y
#    Prompt: ? Which scope?                                <your org>
#    Prompt: ? Link to existing project?                   N
#    Prompt: ? What's your project's name?                 lightningenable-demo
#    Prompt: ? In which directory is your code located?    ./

# 2. Configure env vars without exposing the key in shell history.
.\scripts\setup-vercel-env.ps1
#    - Reads $env:TEMP\le-demo-key.txt
#    - Pipes it into `vercel env add LIGHTNING_ENABLE_API_KEY production`
#    - Adds a placeholder DEMO_AGENT_NWC_URL
#    - Deletes the temp key file when done

# 3. Push the first deploy.
vercel --prod
#    Records the production URL. Note it — the DNS step needs it.
```

## DNS at Namecheap — `demo.lightningenable.com`

After the first `vercel --prod`, Vercel will print the deployment URL
(something like `lightningenable-demo-<hash>.vercel.app`). To map
`demo.lightningenable.com` to it:

1. Log into Namecheap → **Domain List** → **Manage** on `lightningenable.com` → **Advanced DNS** tab.
2. Add a new **CNAME Record**:
   - **Host:** `demo`
   - **Value:** `cname.vercel-dns.com`
   - **TTL:** Automatic
3. Save. Propagation usually completes within ~5 min, max ~1 hour.
4. In Vercel project → **Settings → Domains** → **Add Domain** →
   `demo.lightningenable.com`. Vercel will verify the CNAME and issue
   the SSL cert automatically.

## DNS at Namecheap — apex `lightningenable.com` (Phase C, later)

When ready to promote the demo to the apex:

1. Namecheap → Advanced DNS.
2. Replace any existing apex `A` / `URL Redirect` records on `@` with:
   - **A Record** (Vercel apex):
     - **Host:** `@`
     - **Value:** `76.76.21.21`
     - **TTL:** Automatic
   - Optional `www` CNAME:
     - **Host:** `www`
     - **Value:** `cname.vercel-dns.com`
     - **TTL:** Automatic
3. In Vercel → Settings → Domains → Add `lightningenable.com` (and `www.lightningenable.com` as alias).
4. Vercel will verify and issue the cert.
5. Optional: add `<link rel="canonical" href="https://lightningenable.com/" />` on the re-xbk page to consolidate SEO authority on the new apex (see `landing-site-and-brand-direction.md` § SEO mechanics).

## Updating the NWC URL (when you have it)

```powershell
cd F:\lightningenable-demo
vercel env rm DEMO_AGENT_NWC_URL production
'<real-nwc-url>' | vercel env add DEMO_AGENT_NWC_URL production
vercel --prod
```

## Local dev

```powershell
cd F:\lightningenable-demo
# Pull env vars from Vercel into a local .env (which is gitignored):
vercel env pull .env
vercel dev
# Open http://localhost:3000
```
