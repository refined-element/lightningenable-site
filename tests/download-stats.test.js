// Download-count presentation guard.
//
// The public aggregate deliberately excludes PyPI's rolling-window values,
// so it can temporarily be lower than the approved lifetime floor used by
// the marketing site. Do not let a lower live response overwrite that floor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const index = fileURLToPath(new URL("../public/index.html", import.meta.url));
const app = fileURLToPath(new URL("../public/app.js", import.meta.url));

test("homepage ships the approved 88,000+ download floor", () => {
  const html = readFileSync(index, "utf8");
  assert.match(
    html,
    /id="dl-count"[^>]*data-download-floor="88000"[^>]*>88,000\+<\/span>/,
    "the homepage fallback must show the approved 88,000+ lifetime floor",
  );
});

test("a live aggregate may only raise the homepage download count", () => {
  const js = readFileSync(app, "utf8");
  assert.match(
    js,
    /const floor = Number\.parseInt\(elDlCount\.dataset\.downloadFloor, 10\);/,
    "the client must read the markup's approved floor",
  );
  assert.match(
    js,
    /d\.total >= floor/,
    "a lower API aggregate must not overwrite the approved lifetime floor",
  );
});
