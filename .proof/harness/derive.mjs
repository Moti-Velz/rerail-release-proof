// Derives a proof copy of a release workflow: every job keeps its trigger, needs, if, outputs' names, permissions,
// environment, strategy and concurrency exactly as written; only the steps of jobs that build or touch npm are
// replaced by a stub (.proof/stub.mjs) whose result and outputs the committed scenario decides. The jobs named in
// REAL keep their real steps, so they tag and make GitHub Releases for real, in the proof repository.
//
//   node derive.mjs <source.yml> <workflow key> <dest.yml>
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/Users/tim/orca/workspaces/rerail/release-process/package.json");
const { parse, stringify } = require("yaml");

// The plan job runs its real steps too, with .proof/bin (a fake npm reading .proof/registry) first on PATH, so the
// real packs-plan.mjs reads this repository's real tags and a registry the scenario decides.
const REAL = { release: ["github-release"], "release-packs": ["plan", "tag", "github-releases", "first-publish"] };
const FAKE_NPM = { name: "Fake npm (.proof/bin) first on PATH", run: 'echo "$GITHUB_WORKSPACE/.proof/bin" >> "$GITHUB_PATH"; echo "REG=$GITHUB_WORKSPACE/.proof/registry" >> "$GITHUB_ENV"; echo "LOG=/dev/null" >> "$GITHUB_ENV"' };
const checkout = { uses: "actions/checkout@v4", with: { "persist-credentials": false } };
const BEFORE = {
  "release-packs/publish": [{ uses: "actions/download-artifact@v4", with: { name: "rule-packs", path: ".proof-in/rule-packs" } }],
};
const AFTER = {
  "release-packs/pack": [{ uses: "actions/upload-artifact@v4", with: { name: "rule-packs", path: ".proof-out/rule-packs", "if-no-files-found": "error" } }],
};

const [source, key, dest] = process.argv.slice(2);
const workflow = parse(readFileSync(source, "utf8"));
const callOutputs = (uses) => Object.keys(parse(readFileSync(uses.replace(/^\.\//u, "/Users/tim/orca/workspaces/rerail/release-process/"), "utf8")).on.workflow_call.outputs ?? {});

for (const [id, job] of Object.entries(workflow.jobs)) {
  if (key === "release-packs" && id === "plan") {
    const at = job.steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/checkout"));
    job.steps.splice(at + 1, 0, FAKE_NPM);
    continue;
  }
  if (REAL[key].includes(id)) continue;
  const names = job.uses ? callOutputs(job.uses) : Object.keys(job.outputs ?? {});
  const stub = {
    name: job.name,
    needs: job.needs,
    if: job.if,
    strategy: job.strategy,
    "runs-on": "ubuntu-24.04",
    "timeout-minutes": 10,
    environment: job.environment,
    concurrency: job.concurrency,
    permissions: job.permissions,
    outputs: names.length > 0 ? Object.fromEntries(names.map((name) => [name, `\${{ steps.stub.outputs.${name} }}`])) : undefined,
    steps: [
      checkout,
      ...(BEFORE[`${key}/${id}`] ?? []),
      { id: "stub", name: "Stub", env: { NEEDS: "${{ toJSON(needs) }}" }, run: `node .proof/stub.mjs ${key} ${id}` },
      ...(AFTER[`${key}/${id}`] ?? []),
    ],
  };
  workflow.jobs[id] = Object.fromEntries(Object.entries(stub).filter(([, value]) => value !== undefined));
}
writeFileSync(dest, `# Derived from ${key}.yml by derive.mjs: real needs/if/outputs, stubbed build and npm steps.\n${stringify(workflow, { lineWidth: 0 })}`);
