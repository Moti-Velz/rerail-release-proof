// The reviewer's case on GitHub Actions: a push whose npm publish fails, then "Re-run all jobs", with the real plan
// job reading this repository's real tags and a registry (.proof/registry) that never gets the version. CONTROL runs
// the PR's previous scripts and workflow (5ce0cd0f7); NEW runs the fix (b5110c150), as the next push after the
// control left both versions tagged but not on npm. Results go to .proof/harness/results-rerun.json.
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = "Moti-Velz/rerail-release-proof";
const DIR = "/tmp/proof2";
const RERAIL = "/Users/tim/orca/workspaces/rerail/release-process";
const sh = (cmd, args, cwd = DIR) => execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 }).trim();
const api = (path) => JSON.parse(sh("gh", ["api", path]));
const released = "@neralabs/rerail-pack-typescript@0.1.6:latest @neralabs/rerail-pack-vue@0.1.6:latest";

function commit(variant, rev, label) {
  rmSync(`${DIR}/scripts`, { recursive: true, force: true });
  sh("bash", ["-c", `git -C ${RERAIL} archive ${rev} scripts | tar -x -C ${DIR}`]);
  cpSync(`${DIR}/.proof/variants/${variant}/release-packs.yml`, `${DIR}/.github/workflows/release-packs.yml`);
  writeFileSync(`${DIR}/.proof/scenario.json`, JSON.stringify({ "release-packs": { publish: { failAttempts: [1], outputs: { released } } }, release: {} }, null, 2));
  sh("git", ["add", "-A"]);
  sh("git", ["commit", "-q", "-m", label]);
  sh("git", ["push", "-q", "origin", "HEAD:main"]);
  return sh("git", ["rev-parse", "HEAD"]);
}

async function findRun(sha) {
  for (let i = 0; i < 60; i += 1) {
    const run = api(`repos/${REPO}/actions/runs?head_sha=${sha}&event=push`).workflow_runs.find((r) => r.path === ".github/workflows/release-packs.yml");
    if (run !== undefined) return run.id;
    await sleep(5000);
  }
  throw new Error(`no run for ${sha}`);
}

async function attempt(id, n) {
  for (;;) {
    if (api(`repos/${REPO}/actions/runs/${id}/attempts/${n}`).status === "completed") break;
    await sleep(10000);
  }
  const run = api(`repos/${REPO}/actions/runs/${id}/attempts/${n}`);
  const jobs = api(`repos/${REPO}/actions/runs/${id}/attempts/${n}/jobs?per_page=100`).jobs;
  const pick = ["Packs to publish", "Tag each release", "GitHub Releases", "Publish to npmjs", "Published dist-tags"];
  const log = sh("gh", ["run", "view", String(id), "-R", REPO, "--attempt", String(n), "--log"]).split("\n");
  const lines = (job, re) => log.filter((l) => l.startsWith(`${job}\t`) && re.test(l)).map((l) => l.replace(/^.*?Z /u, "").trim());
  return {
    url: `https://github.com/${REPO}/actions/runs/${id}/attempts/${n}`,
    conclusion: run.conclusion,
    jobs: Object.fromEntries(pick.map((name) => [name, jobs.find((j) => j.name === name)?.conclusion ?? "absent"])),
    plan: lines("Packs to publish", /^(publish |::warning|Every pack|::error)/u),
    tag: lines("Tag each release", /^(tagged |@neralabs.*tagged already)/u),
  };
}

const results = {};
for (const [variant, rev, label] of [
  ["control", "5ce0cd0f7", "CONTROL (5ce0cd0f7): publish fails, then re-run all jobs"],
  ["new", "b5110c150", "NEW (b5110c150): next push, publish fails, then re-run all jobs"],
]) {
  const id = await findRun(commit(variant, rev, label));
  const first = await attempt(id, 1);
  sh("gh", ["run", "rerun", String(id), "-R", REPO]);
  await sleep(15000);
  const second = await attempt(id, 2);
  results[variant] = { label, attempt1: first, attempt2: second };
  writeFileSync(`${DIR}/.proof/harness/results-rerun.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results[variant], null, 2));
}
