// Pricing-copy guard tests (R1B-c — repricing to $49).
//
// These are content tests, not code tests: they read the shipped files
// under `public/` and assert that the public price story matches the
// one the API actually charges. A marketing surface that advertises a
// price the billing system will not charge is worse than a missing
// price, so these assertions are deliberately blunt — an exact-string
// blocklist over every text file we ship.
//
// Locked pricing decisions (owner, 2026-08-31) encoded here:
//   1. One public paid tier: "Agentic Commerce" at $49/mo. No
//      "Individual" suffix anywhere on the surface.
//   2. No annual price anywhere (no "/yr", no "annual option").
//   3. Business is "Contact us" — priced per deal, no number shown.
//   4. The old Business differentiator "Strike OR OpenNode as
//      settlement provider" is NOT enforced anywhere in the product.
//      It must never come back.
//   5. Free Producer Sandbox caps stay exactly: 3 endpoints,
//      200 challenges/month, 1,000 sats max per challenge.
//   6. The "Pay with Bitcoin — 10% off" promo CTA is demoted: the
//      discount claim is gone; a plain /BitcoinCheckout link stays.
//
// Run with `node --test tests/` (or `npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

// Text formats we ship and can meaningfully scan. Binary assets
// (images, fonts) are excluded — a stale price baked into a
// screenshot cannot be caught here.
const TEXT_EXTENSIONS = new Set([
  ".html",
  ".txt",
  ".css",
  ".js",
  ".xml",
  ".json",
  ".svg",
  ".md",
]);

/** Recursively collect every scannable text file under public/. */
function collectTextFiles(dir = PUBLIC_DIR, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTextFiles(full, out);
    } else if (TEXT_EXTENSIONS.has(extname(entry).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

const TEXT_FILES = collectTextFiles();

/** public/-relative path, forward slashes, for readable failures. */
const rel = (p) => relative(PUBLIC_DIR, p).split("\\").join("/");

const read = (p) => readFileSync(p, "utf8");

/**
 * Crude tag stripper. HTML lets a claim hide behind markup —
 * `Strike <em>or</em> OpenNode</strong> as settlement provider`
 * does not contain the literal blocked phrase, but a human reads it
 * as exactly that phrase. Stripping tags (and collapsing the
 * whitespace HTML authors use for wrapping) makes the blocklist see
 * what the reader sees.
 */
function visibleText(source) {
  return source
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
}

/** Both the raw bytes and the reader-visible rendering of a file. */
function surfaces(file) {
  const raw = read(file);
  return [
    { label: rel(file), text: raw },
    { label: `${rel(file)} (tags stripped)`, text: visibleText(raw) },
  ];
}

const p = (...parts) => join(PUBLIC_DIR, ...parts);

// The four surfaces that carry the price story: two human pages and
// the two agent-readable briefs.
const PRICING_SURFACES = [
  p("index.html"),
  p("pricing", "index.html"),
  p("llms.txt"),
  p("llms-full.txt"),
];

// The two pages that render a Business card / row.
const BUSINESS_SURFACES = [p("index.html"), p("pricing", "index.html")];

// ── 1. Retired prices must be gone everywhere ─────────────────────

const FORBIDDEN_PRICE_STRINGS = [
  "$99",
  "$299",
  "$490",
  "$990",
  "$2,990",
  "2,990",
  "99/mo",
  "299/mo",
  "99/month",
  "299/month",
];

for (const needle of FORBIDDEN_PRICE_STRINGS) {
  test(`retired price string "${needle}" appears nowhere under public/`, () => {
    const hits = [];
    for (const file of TEXT_FILES) {
      for (const { label, text } of surfaces(file)) {
        if (text.includes(needle)) hits.push(label);
      }
    }
    assert.deepEqual(
      hits,
      [],
      `"${needle}" is a retired price and must not ship. Found in: ${hits.join(", ")}`,
    );
  });
}

// ── 2. Annual pricing is retired entirely ─────────────────────────

test("no annual price is advertised anywhere under public/", () => {
  const hits = [];
  for (const file of TEXT_FILES) {
    const text = read(file);
    if (/\/yr\b/.test(text)) hits.push(`${rel(file)} (matched "/yr")`);
    if (/annual option/i.test(text)) hits.push(`${rel(file)} (matched "annual option")`);
    if (/annual pricing/i.test(text)) hits.push(`${rel(file)} (matched "annual pricing")`);
    if (/save 2 months/i.test(text)) hits.push(`${rel(file)} (matched "save 2 months")`);
  }
  assert.deepEqual(hits, [], `Annual pricing was retired. Found in: ${hits.join(", ")}`);
});

// ── 3. $49 is the one public paid price ───────────────────────────

for (const file of PRICING_SURFACES) {
  test(`${rel(file)} states the $49 price`, () => {
    assert.match(read(file), /\$49\b/, `${rel(file)} must state the $49/mo price`);
  });
}

test("JSON-LD offers price the paid tier at 49 USD", () => {
  for (const file of [p("index.html"), p("pricing", "index.html")]) {
    const text = read(file);
    assert.match(
      text,
      /"price":\s*"49"/,
      `${rel(file)} JSON-LD must offer the paid tier at "49"`,
    );
  }
});

// ── 4. The tier is "Agentic Commerce" — no "Individual" suffix ────

test('the retired "Individual" tier name appears nowhere under public/', () => {
  // Lowercase `individual` inside checkout URLs (`?plan=individual`)
  // is a tier ID the API still uses — unchanged by design. Only the
  // capitalised display name is retired.
  const hits = [];
  for (const file of TEXT_FILES) {
    for (const { label, text } of surfaces(file)) {
      if (/\bIndividual\b/.test(text)) hits.push(label);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `The paid tier is now just "Agentic Commerce". Found "Individual" in: ${hits.join(", ")}`,
  );
});

test("the tier ID in checkout links is unchanged", () => {
  // Repricing changes copy and numbers only. If these IDs move, the
  // checkout links break silently.
  for (const file of BUSINESS_SURFACES) {
    assert.match(read(file), /plan=individual/, `${rel(file)} lost ?plan=individual`);
  }
});

// ── 5. Business is "Contact us", with no number and no fake perk ──

for (const file of BUSINESS_SURFACES) {
  test(`${rel(file)} presents Business as "Contact us"`, () => {
    const text = visibleText(read(file));
    const at = text.indexOf("Business");
    assert.notEqual(at, -1, `${rel(file)} should still present a Business option`);
    // The Business card is a short block; the contact CTA has to sit
    // inside it, not somewhere else on the page.
    const block = text.slice(at, at + 1500);
    assert.match(
      block,
      /Contact us/,
      `${rel(file)} must offer "Contact us" where Business is presented`,
    );
  });
}

test('the false "OpenNode as settlement provider" differentiator is gone', () => {
  // Provider choice is not gated by plan tier anywhere in the
  // product. Advertising it as a Business perk was false.
  const hits = [];
  for (const file of TEXT_FILES) {
    for (const { label, text } of surfaces(file)) {
      if (/OpenNode as settlement provider/i.test(text)) hits.push(label);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `Plan tier does not gate the settlement provider. Found in: ${hits.join(", ")}`,
  );
});

// ── 6. Free Producer Sandbox caps stay exact and consistent ───────

const SANDBOX_CAPS = [
  { label: "3 endpoints", pattern: /3 endpoints/ },
  { label: "200 challenges", pattern: /200 challenges/ },
  { label: "1,000 sats max per challenge", pattern: /1,000 sats/ },
];

for (const file of PRICING_SURFACES) {
  for (const cap of SANDBOX_CAPS) {
    test(`${rel(file)} states the Free Sandbox cap: ${cap.label}`, () => {
      assert.match(
        visibleText(read(file)),
        cap.pattern,
        `${rel(file)} must state the Free Producer Sandbox cap "${cap.label}"`,
      );
    });
  }
}

test('the Free Sandbox is described as free with "no card"', () => {
  for (const file of PRICING_SURFACES) {
    assert.match(
      visibleText(read(file)).toLowerCase(),
      /no card/,
      `${rel(file)} must say the Free Producer Sandbox needs no card`,
    );
  }
});

// ── 7. Bitcoin checkout: demoted, not retired ─────────────────────

test('the "10% off" Bitcoin discount claim appears nowhere under public/', () => {
  const hits = [];
  for (const file of TEXT_FILES) {
    for (const { label, text } of surfaces(file)) {
      if (/10%\s*off/i.test(text) || /save 10%/i.test(text)) hits.push(label);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `The Bitcoin subscription discount is not advertised at the new price. Found in: ${hits.join(", ")}`,
  );
});

test("the /BitcoinCheckout link target survives on the pricing page", () => {
  // Demoted, not retired: the discount promo is gone but paying the
  // subscription in Bitcoin is still offered at the point of payment.
  assert.match(
    read(p("pricing", "index.html")),
    /BitcoinCheckout/,
    "pricing/index.html must keep a plain link to /BitcoinCheckout",
  );
});

// ── 8. Custody language ───────────────────────────────────────────

test("no banned custody language ships under public/", () => {
  // Payment providers ARE custodians; the correct claim is that
  // Lightning Enable does not hold funds.
  const banned = [/non-custodial/i, /self-custody/i, /trustless/i, /decentrali[sz]ed/i];
  const hits = [];
  for (const file of TEXT_FILES) {
    const text = read(file);
    for (const pattern of banned) {
      if (pattern.test(text)) hits.push(`${rel(file)} (matched ${pattern})`);
    }
  }
  assert.deepEqual(hits, [], `Banned custody language found in: ${hits.join(", ")}`);
});
