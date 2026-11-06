// Pushes each scenario to the proof repository, waits for GitHub to run the derived workflows, and checks each job's
// conclusion and timing against what the scenario expects. Results go to results.json.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = process.env.PROOF_REPO;
const DIR = "/tmp/release-proof/repo";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: DIR, encoding: "utf8", ...opts }).trim();
const gh = (...args) => sh("gh", args);
const ghJson = (...args) => JSON.parse(gh(...args));
const version = (id) => JSON.parse(readFileSync(`${DIR}/packs/${id}/package.json`, "utf8")).version;
const packName = (id) => `@neralabs/rerail-pack-${id}`;

function commit(variant, scenario, message) {
  mkdirSync(`${DIR}/.github/workflows`, { recursive: true });
  for (const w of ["release", "release-packs"]) cpSync(`/tmp/release-proof/out/${variant}/${w}.yml`, `${DIR}/.github/workflows/${w}.yml`);
  writeFileSync(`${DIR}/.proof/scenario.json`, JSON.stringify(scenario, null, 2));
  sh("git", ["add", "-A"]);
  sh("git", ["commit", "-q", "--allow-empty", "-m", message]);
  return sh("git", ["rev-parse", "HEAD"]);
}
async function findRun(workflow, filter) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const runs = ghJson("api", `repos/${REPO}/actions/runs?per_page=50`).workflow_runs
        .filter((r) => r.path === `.github/workflows/${workflow}`)
        .map((r) => ({ databaseId: r.id, headSha: r.head_sha, event: r.event, headBranch: r.head_branch }));
      const run = runs.find(filter);
      if (run !== undefined) return run.databaseId;
    } catch (error) {
      console.log(`listing runs failed, retrying: ${error.message.split("\n")[0]}`);
    }
    await sleep(5000);
  }
  throw new Error(`no ${workflow} run appeared`);
}

async function waitRun(id, attempt = 1) {
  for (;;) {
    const run = ghJson("api", `repos/${REPO}/actions/runs/${id}/attempts/${attempt}`);
    if (run.status === "completed") break;
    await sleep(10000);
  }
  return ghJson("api", `repos/${REPO}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`).jobs.map((j) => ({
    name: j.name,
    conclusion: j.conclusion,
    started: j.started_at,
    completed: j.completed_at,
  }));
}

const results = [];
function check(label, url, jobs, expect, order = []) {
  const byName = Object.fromEntries(jobs.map((j) => [j.name, j]));
  const failures = [];
  for (const [name, want] of Object.entries(expect)) {
    const got = byName[name]?.conclusion ?? "absent";
    if (got !== want) failures.push(`${name}: ${got}, expected ${want}`);
  }
  for (const [first, then, how] of order) {
    const a = Date.parse(byName[first]?.completed);
    const b = Date.parse(how === "starts" ? byName[then]?.started : byName[then]?.completed);
    if (!(a <= b)) failures.push(`${first} must complete before ${then} ${how === "starts" ? "starts" : "completes"}`);
  }
  const row = { label, url, pass: failures.length === 0, failures, jobs: Object.fromEntries(Object.keys(expect).map((n) => [n, byName[n]?.conclusion])), timing: order.map(([a, b, how]) => ({ first: a, firstCompleted: byName[a]?.completed, then: b, how, thenAt: how === "starts" ? byName[b]?.started : byName[b]?.completed })) };
  results.push(row);
  writeFileSync("/tmp/release-proof/results.json", JSON.stringify(results, null, 2));
  console.log(`${row.pass ? "PASS" : "FAIL"} ${label} ${url}${failures.length ? `\n  ${failures.join("\n  ")}` : ""}`);
}

const url = (id, attempt) => `https://github.com/${REPO}/actions/runs/${id}${attempt ? `/attempts/${attempt}` : ""}`;
const plan = (id) => ({ plan: { outputs: { publish: id, first: "", held: "" } } });
const released = (id) => `${packName(id)}@${version(id)}:latest`;
const P = { tag: "Tag each release", rel: "GitHub Releases", pub: "Publish to npmjs", dt: "Published dist-tags", pack: "Validate and pack" };
const C = { rel: "GitHub Release", pub: "Publish to npmjs", dt: "Published dist-tags", win: "Windows x64 managed install" };

async function packScenario(label, variant, scenario, expect, order) {
  const sha = commit(variant, { "release-packs": scenario, release: {} }, label);
  sh("git", ["push", "-q", "origin", "HEAD:main"]);
  const id = await findRun("release-packs.yml", (r) => r.headSha === sha && r.event === "push");
  check(label, url(id), await waitRun(id), expect, order);
  return id;
}

async function coreTag(label, variant, tag, scenario, expect, order) {
  const base = sh("git", ["rev-parse", "HEAD"]);
  const sha = commit(variant, { release: scenario, "release-packs": {} }, label);
  sh("git", ["tag", tag, sha]);
  sh("git", ["reset", "-q", "--hard", base]);
  sh("git", ["push", "-q", "origin", `refs/tags/${tag}`]);
  const id = await findRun("release.yml", (r) => r.headSha === sha && r.headBranch === tag);
  check(label, url(id), await waitRun(id), expect, order);
}

// The first push puts both workflows on the default branch before any tag is pushed.
await packScenario("packs: nothing to release (first push)", "pr", { plan: { outputs: { publish: "", first: "", held: "" } } },
  { [P.tag]: "skipped", [P.rel]: "skipped", [P.pub]: "skipped" });

// Core tag pushes run on their own tags, beside the pack scenarios on main.
const core = (async () => {
  await coreTag("core: npm slow (150s) and dist-tag read-back fails", "pr", "v0.1.2",
    { metadata: { outputs: { channel: "latest", version: "0.1.2" } }, publish: { sleep: 150 }, "dist-tags": { result: "failure" } },
    { [C.rel]: "success", [C.pub]: "success", [C.dt]: "failure" }, [[C.rel, C.pub, "completes"]]);
  await coreTag("core: npm publish fails", "pr", "v0.1.2-next.1",
    { metadata: { outputs: { channel: "next", version: "0.1.2-next.1" } }, publish: { result: "failure" } },
    { [C.rel]: "success", [C.pub]: "failure", [C.dt]: "skipped" });
  await coreTag("core: Windows install fails", "pr", "v0.1.2-next.2",
    { metadata: { outputs: { channel: "next", version: "0.1.2-next.2" } }, "windows-install": { result: "failure" } },
    { [C.rel]: "skipped", [C.pub]: "skipped", [C.dt]: "skipped" });
  await coreTag("core CONTROL (main's release.yml): dist-tag read-back fails", "main", "v0.1.2-next.3",
    { metadata: { outputs: { channel: "next", version: "0.1.2-next.3" } }, "dist-tags": { result: "failure" } },
    { [C.rel]: "skipped", [C.pub]: "success", [C.dt]: "failure" });
})();

await packScenario("packs: npm slow (150s)", "pr", { ...plan("python"), publish: { sleep: 150, outputs: { released: released("python") } } },
  { [P.tag]: "success", [P.rel]: "success", [P.pub]: "success", [P.dt]: "success" },
  [[P.tag, P.pub, "starts"], [P.rel, P.pub, "completes"]]);
const failing = await packScenario("packs: npm publish fails (attempt 1)", "pr", { ...plan("javascript"), publish: { failAttempts: [1], outputs: { released: released("javascript") } } },
  { [P.tag]: "success", [P.rel]: "success", [P.pub]: "failure", [P.dt]: "skipped" });
gh("run", "rerun", String(failing), "--failed", "-R", REPO);
await sleep(10000);
check("packs: re-run failed jobs republishes the same tagged version (attempt 2)", url(failing, 2), await waitRun(failing, 2),
  { [P.pub]: "success", [P.dt]: "success", [P.tag]: "success", [P.rel]: "success" });
await packScenario("packs: dist-tag read-back fails", "pr", { ...plan("node"), publish: { outputs: { released: released("node") } }, "dist-tags": { result: "failure" } },
  { [P.tag]: "success", [P.rel]: "success", [P.pub]: "success", [P.dt]: "failure" });
await packScenario("packs: validation fails", "pr", { ...plan("php"), pack: { result: "failure" } },
  { [P.pack]: "failure", [P.tag]: "skipped", [P.rel]: "skipped", [P.pub]: "skipped" });
await packScenario("packs CONTROL (main's release-packs.yml): dist-tag read-back fails", "main",
  { ...plan("react"), publish: { outputs: { released: released("react") } }, "dist-tags": { result: "failure" } },
  { [P.rel]: "skipped", [P.pub]: "success", [P.dt]: "failure" });
await packScenario("packs CONTROL (main's release-packs.yml): npm publish fails", "main", { ...plan("rust"), publish: { result: "failure" } },
  { [P.rel]: "skipped", [P.pub]: "failure" });
await packScenario("packs: nothing to release", "pr", { plan: { outputs: { publish: "", first: "", held: "" } } },
  { [P.tag]: "skipped", [P.rel]: "skipped", [P.pub]: "skipped" });

await core;
// Dispatches run main's release.yml, the PR's since the last pack scenario.
const lastDispatch = () => Math.max(0, ...ghJson("run", "list", "-R", REPO, "--workflow", "release.yml", "--event", "workflow_dispatch", "--json", "databaseId").map((r) => r.databaseId));
const seen = lastDispatch();
gh("workflow", "run", "release.yml", "-R", REPO, "--ref", "main", "-f", "latest=0.1.2");
const putBack = await findRun("release.yml", (r) => r.event === "workflow_dispatch" && r.databaseId > seen);
check("core: put-back to 0.1.2", url(putBack), await waitRun(putBack), { "Point latest at 0.1.2": "success", [C.rel]: "success", [C.pub]: "skipped" });
gh("workflow", "run", "release.yml", "-R", REPO, "--ref", "main");
const build = await findRun("release.yml", (r) => r.event === "workflow_dispatch" && r.databaseId > putBack);
check("core: build only (no inputs)", url(build), await waitRun(build), { [C.rel]: "skipped", [C.pub]: "skipped", Package: "success" });

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} scenarios pass`);
