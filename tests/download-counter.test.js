import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("download counter prefers the API's complete inclusive total", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(app, /typeof d\?\.inclusiveTotal === "number" && d\.inclusiveTotal > 0/);
  assert.match(app, /elDlCount\.textContent = d\.inclusiveTotal\.toLocaleString\("en-US"\)/);
});
