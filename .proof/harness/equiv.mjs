// Fails unless each derived workflow keeps its source's control flow exactly: triggers, top-level permissions and
// concurrency, and per job needs, if, environment, permissions, strategy, concurrency and output names.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
const { parse } = createRequire("/Users/tim/orca/workspaces/rerail/release-process/package.json")("yaml");
let bad = 0;
for (const v of ["pr", "main"]) for (const w of ["release", "release-packs"]) {
  const [a, b] = [`src/${v}/${w}.yml`, `out/${v}/${w}.yml`].map((f) => parse(readFileSync(f, "utf8")));
  for (const k of ["on", "permissions", "concurrency"]) if (!isDeepStrictEqual(a[k], b[k])) (bad++, console.log(`${v}/${w}: ${k} differs`));
  if (!isDeepStrictEqual(Object.keys(a.jobs), Object.keys(b.jobs))) (bad++, console.log(`${v}/${w}: job set differs`));
  for (const [id, j] of Object.entries(a.jobs)) {
    const d = b.jobs[id];
    for (const k of ["needs", "if", "environment", "permissions", "strategy", "concurrency", "name"]) if (!isDeepStrictEqual(j[k], d[k])) (bad++, console.log(`${v}/${w}/${id}: ${k} differs`));
    if (!j.uses && !isDeepStrictEqual(Object.keys(j.outputs ?? {}), Object.keys(d.outputs ?? {}))) (bad++, console.log(`${v}/${w}/${id}: outputs differ`));
  }
  console.log(`${v}/${w}.yml: ${Object.keys(a.jobs).length} jobs, control flow identical to source`);
}
process.exit(bad ? 1 : 0);
