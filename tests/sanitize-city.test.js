// Unit tests for the city whitelist on /api/premium/weather.
// Run with `npm test`.
//
// The city box on the public demo feeds the Lightning invoice
// `description`. That memo lands in the merchant node's database, in
// wallet UIs, at the payee, and in logs. Two real probes were seen in
// the operator's Alby Hub transaction list on 2026-10-14:
//   Weather for "><script>alert(1)</script>
//   Weather for ${env:DEMO_AGENT_NWC_URL}
// Neither executed anywhere, but the memo must not be a raw write
// channel for anonymous visitors. These tests lock the whitelist down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeCity } from "../api/premium/weather.js";

test("strips a stored-XSS probe down to its letters", () => {
  assert.equal(sanitizeCity('"><script>alert(1)</script>'), "scriptalertscript");
});

test("strips a template-expansion probe", () => {
  assert.equal(sanitizeCity("${env:DEMO_AGENT_NWC_URL}"), "envDEMOAGENTNWCURL");
});

test("drops every character that can break out of a memo or markup", () => {
  const out = sanitizeCity(`<>"'&{}$()[]\/;:=%#@!?*+|~\`^` + "Miami");
  assert.equal(out, "'Miami"); // apostrophe is the only allowed one here
  for (const ch of `<>"&{}$()[]\/;:=%#@!?*+|~\`^`) {
    assert.ok(!out.includes(ch), `leaked ${ch}`);
  }
});

test("keeps ordinary city names unchanged", () => {
  for (const c of ["Miami", "New York", "St. Louis", "Winston-Salem", "Coeur d'Alene"]) {
    assert.equal(sanitizeCity(c), c);
  }
});

test("keeps non-ASCII letters and combining marks", () => {
  assert.equal(sanitizeCity("São Paulo"), "São Paulo");
  assert.equal(sanitizeCity("Zürich"), "Zürich");
  assert.equal(sanitizeCity("東京"), "東京");
  assert.equal(sanitizeCity("Москва"), "Москва");
});

test("collapses and trims whitespace", () => {
  assert.equal(sanitizeCity("  New    York \n"), "New York");
});

test("strips digits", () => {
  assert.equal(sanitizeCity("Miami 33101"), "Miami");
});

test("falls back to the default when nothing survives", () => {
  assert.equal(sanitizeCity(""), "Miami");
  assert.equal(sanitizeCity("   "), "Miami");
  assert.equal(sanitizeCity("<<<>>>"), "Miami");
  assert.equal(sanitizeCity(undefined), "Miami");
  assert.equal(sanitizeCity(null), "Miami");
});

test("caps length at 64 characters", () => {
  const out = sanitizeCity("a".repeat(200));
  assert.equal(out.length, 64);
});

test("coerces non-string query values", () => {
  assert.equal(sanitizeCity(["Paris", "x"]), "Parisx");
  assert.equal(sanitizeCity(42), "Miami");
});

test("the memo built from a sanitized city carries no markup", () => {
  const memo = `Weather for ${sanitizeCity('"><img src=x onerror=alert(1)>')}`;
  assert.equal(memo, "Weather for img srcx onerroralert");
  assert.ok(!/[<>"${}]/.test(memo));
});
