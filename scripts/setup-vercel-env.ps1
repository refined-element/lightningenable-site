# Lightning Enable Demo — Vercel env setup
# ---------------------------------------------------------------------------
# Run AFTER `vercel link` has been run in this project directory.
#
# Reads the new merchant API key from a local temp file (see
# rotate-le-demo-key.ps1, which writes to $env:TEMP\le-demo-key.txt with
# user-only perms) and pipes it into `vercel env add` without ever
# echoing the value to stdout.
#
# DEMO_AGENT_NWC_URL is set to a placeholder until a real funded CoinOS
# NWC URL is in hand; the demo's agent-run endpoint will fail until then,
# which is expected.
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"

# Sanity checks
if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
    Write-Host "FAIL: vercel CLI not installed. Run 'npm i -g vercel' first."
    exit 1
}
if (-not (Test-Path ".vercel/project.json")) {
    Write-Host "FAIL: project not linked. Run 'vercel link' first."
    exit 1
}

$keyFile = Join-Path $env:TEMP "le-demo-key.txt"
if (-not (Test-Path $keyFile)) {
    Write-Host "FAIL: $keyFile not found. Run rotate-le-demo-key.ps1 first."
    exit 1
}

Write-Host "[1/3] Adding LIGHTNING_ENABLE_API_KEY to Vercel production..."
# Pipe key contents to `vercel env add` so the value never lands in
# argv, environment, or stdout history.
Get-Content $keyFile -Raw | vercel env add LIGHTNING_ENABLE_API_KEY production
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: vercel env add LIGHTNING_ENABLE_API_KEY returned $LASTEXITCODE"
    exit 1
}

Write-Host "[2/3] Adding DEMO_AGENT_NWC_URL placeholder to Vercel production..."
# Placeholder until a real funded NWC URL is in hand. The /api/run-agent
# endpoint will return an error until this is replaced; that's expected.
"nostr+walletconnect://placeholder-replace-me" | vercel env add DEMO_AGENT_NWC_URL production
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: vercel env add DEMO_AGENT_NWC_URL returned $LASTEXITCODE"
    exit 1
}

Write-Host "[3/3] Cleaning up local temp key file..."
Remove-Item $keyFile -Force
Write-Host "Done. Temp key file removed."
Write-Host ""
Write-Host "Reminder: when you have a real NWC URL, run:"
Write-Host "  vercel env rm DEMO_AGENT_NWC_URL production"
Write-Host "  '<real-nwc-url>' | vercel env add DEMO_AGENT_NWC_URL production"
