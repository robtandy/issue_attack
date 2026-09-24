// Smoke test: every compiled module must parse and load. A mangled merge (missing
// brace, broken template literal, …) otherwise ships to main unnoticed when
// no test happens to import that module — exactly how PR #22's conflicted
// merge broke lib/runner.js while `npm test` stayed green. The modules under
// test are the tsc-compiled output in dist/ (the sources live in src/).

import test from "node:test";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const libDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "lib");

test("all lib modules load", async () => {
  const files = readdirSync(libDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(libDir, f));
  if (files.length < 10) throw new Error(`expected >=10 modules, found ${files.length}`);
  await Promise.all(files.map((f) => import(`${f}?smoke=${process.pid}`)));
});
