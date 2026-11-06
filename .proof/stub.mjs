// A stubbed job's one step: its result and outputs are the committed scenario's (.proof/scenario.json).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const [workflow, job] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(".proof/scenario.json", "utf8"))[workflow]?.[job] ?? {};
const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
const needs = JSON.parse(process.env.NEEDS ?? "{}");

if (workflow === "release-packs" && job === "pack") {
  const ids = (needs.plan?.outputs?.publish ?? "").split(" ").filter(Boolean);
  const manifest = ids.map((id) => {
    const { name, version } = JSON.parse(readFileSync(`packs/${id}/package.json`, "utf8"));
    return { name, version, file: `${id}-${version}.tgz` };
  });
  mkdirSync(".proof-out/rule-packs", { recursive: true });
  writeFileSync(".proof-out/rule-packs/manifest.json", JSON.stringify(manifest));
  console.log(`packed (stub): ${JSON.stringify(manifest)}`);
}
if (existsSync(".proof-in/rule-packs/manifest.json")) {
  console.log(`would publish, on attempt ${attempt}, the tarballs packed on attempt 1: ${readFileSync(".proof-in/rule-packs/manifest.json", "utf8")}`);
}
for (const [name, value] of Object.entries(spec.outputs ?? {})) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
if (spec.sleep) {
  console.log(`simulating a slow npm: sleeping ${spec.sleep}s`);
  await sleep(spec.sleep * 1000);
}
const fails = spec.result === "failure" || (spec.failAttempts ?? []).includes(attempt);
console.log(`stub ${workflow}/${job}, attempt ${attempt}: ${fails ? "failure" : "success"}`);
process.exit(fails ? 1 : 0);
