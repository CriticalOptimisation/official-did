// tools/check-netlify-env.test.mjs — the variables of every domain, tracked in
// netlify-env-public/ (#11).
//
// Everything in netlify-env-public/ is public, so a file there may hold the
// keys of tools/netlify-env-keys.txt and nothing else. These tests check the
// tracked files, the reference list, the checker tools/check-netlify-env.mjs
// and the pre-commit hook tools/git-hooks/pre-commit.
//
// Lines are compared whole, keys as whole tokens, and URLs are parsed: there
// is no substring check.
//
// Run with: node --test tools/check-netlify-env.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, copyFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, TOOLS, BUILD_SITE, REAL_GIT, dataTree, lines } from "./fixtures/domains.mjs";

const FOLDER = "netlify-env-public";
const CHECKER = join(TOOLS, "check-netlify-env.mjs");
const KEYS = join(TOOLS, "netlify-env-keys.txt");
const HOOK = join(TOOLS, "git-hooks", "pre-commit");

/** Runs git in `cwd`; never throws. */
const gitRun = (cwd, args, env = {}) =>
  spawnSync(REAL_GIT, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });

/** The tracked files of the variables of a domain: netlify-env-public/<name>.env. */
function trackedEnvFiles() {
  const r = gitRun(REPO, ["ls-files", "--", FOLDER]);
  assert.equal(r.status, 0, r.stderr);
  return lines(r.stdout).filter(Boolean)
    .filter((f) => !f.slice(FOLDER.length + 1).includes("/") && f.endsWith(".env"));
}

/** A file's KEY=VALUE lines as an object, each line split at its first `=`. */
const parseEnv = (text) => Object.fromEntries(lines(text).filter((l) => l.includes("="))
  .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

/** The reference list: [{ key, status, reason }], comments and blank lines left out. */
async function referenceList() {
  return lines(await readFile(KEYS, "utf8"))
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .map((l) => {
      const [key, status, ...reason] = l.trim().split(/ +/);
      return { key, status, reason: reason.join(" ") };
    });
}

/** Runs the checker with `args`; resolves to { status, stdout, stderr, faults }. */
function check(args, cwd = REPO) {
  const r = spawnSync(process.execPath, [CHECKER, ...args], { cwd, encoding: "utf8" });
  return { ...r, faults: lines(r.stderr).filter(Boolean) };
}

// A fixture domain, never a real one, and a valid file for it. The redirect
// has a query string holding `=`, as a real redirect may.
const DOMAIN = "a.example.test";
const GOOD = [`DID_DOMAIN=${DOMAIN}`, "DID_REDIRECT=https://www.a-owner.example.test/profile?id=1=2"];

/** Writes `body` (an array of lines, or a string) as <dir>/<name>; resolves to its path. */
async function envFile(body, name = `${DOMAIN}.env`) {
  const dir = await mkdtemp(join(tmpdir(), "did-env-"));
  const path = join(dir, name);
  await writeFile(path, Array.isArray(body) ? `${body.join("\n")}\n` : body);
  return path;
}

// --- the folder and the tracked files --------------------------------------------

test("netlify-env-public/ admits only *.env files", () => {
  // --no-index: what the rules say, whether or not such a file is tracked.
  const ignored = (path) => gitRun(REPO, ["check-ignore", "-q", "--no-index", path]).status === 0;
  assert.equal(ignored(`${FOLDER}/x.example.test.env`), false, "a .env file can be tracked");
  assert.equal(ignored(`${FOLDER}/notes.txt`), true, "any other file is ignored");
  assert.equal(ignored(`${FOLDER}/.env`), true, "a file named .env is ignored");
  assert.equal(ignored(`${FOLDER}/sub/x.example.test.env`), true, "a subfolder is ignored");
});

test("every tracked file of netlify-env-public/ passes the checker", () => {
  const files = trackedEnvFiles();
  assert.ok(files.length > 0, "netlify-env-public/ holds the variables of the served domains");
  const r = check(files);
  assert.deepEqual(r.faults, []);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("every tracked file of netlify-env-public/ builds its domain's site", async () => {
  const files = trackedEnvFiles();
  assert.ok(files.length > 0, "netlify-env-public/ holds the variables of the served domains");
  for (const f of files) {
    const env = parseEnv(await readFile(join(REPO, f), "utf8"));
    // Any consistent document will do: the values are what is checked.
    const tree = (await dataTree(env.DID_DOMAIN)).tree;
    const out = join(await mkdtemp(join(tmpdir(), "did-dist-")), "dist");
    const r = spawnSync(process.execPath, [BUILD_SITE, "--data", tree, "--out", out],
      { env: { ...process.env, ...env }, encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

// --- the reference list ---------------------------------------------------------

test("the reference list of keys is well formed", async () => {
  const list = await referenceList();
  for (const { key, status, reason } of list) {
    assert.match(key, /^[A-Z][A-Z0-9_]*$/, key);
    assert.ok(["required", "optional", "prohibited"].includes(status), `${key}: ${status}`);
    if (status === "prohibited") assert.notEqual(reason, "", `${key} is prohibited without a reason`);
  }
  const keys = list.map((e) => e.key);
  assert.deepEqual(keys, [...new Set(keys)], "each key once");
  const statusOf = Object.fromEntries(list.map((e) => [e.key, e.status]));
  assert.equal(statusOf.DID_DOMAIN, "required");
  assert.equal(statusOf.DID_REDIRECT, "required");
  assert.equal(statusOf.DID_LOG, "optional");
  assert.equal(statusOf.DID_ALLOW_NO_PREVIOUS, "prohibited");
  assert.equal(statusOf.DID_PUBLISH_BUILD_HOOK, "prohibited");
});

// --- the checker ----------------------------------------------------------------

test("the checker passes a valid file, and a value that holds `=`", async () => {
  const path = await envFile(GOOD);
  const r = check([path]);
  assert.deepEqual(r.faults, []);
  assert.equal(r.status, 0);
});

test("the checker refuses each prohibited key of the reference list, with its reason", async () => {
  const prohibited = (await referenceList()).filter((e) => e.status === "prohibited");
  assert.ok(prohibited.length > 0);
  for (const { key, reason } of prohibited) {
    const path = await envFile([...GOOD, `${key}=x`]);
    const r = check([path]);
    assert.deepEqual(r.faults, [`FAULT ${path}:3: ${key} is prohibited: ${reason}`], key);
    assert.equal(r.status, 1, key);
  }
});

test("the checker refuses a key the reference list does not allow", async () => {
  for (const key of ["DID_DOMAINX", "did_domain", "NETLIFY_SITE_ID"]) {
    const path = await envFile([...GOOD, `${key}=x`]);
    const r = check([path]);
    assert.deepEqual(r.faults, [`FAULT ${path}:3: ${key} is not an allowed key`], key);
    assert.equal(r.status, 1, key);
  }
});

test("the checker refuses every line that is not KEY=VALUE: comment, blank, export, carriage return", async () => {
  for (const line of ["# a comment", "", "export DID_LOG=https://log.example.test/",
    "DID_LOG=https://log.example.test/\r", "DID_LOG"]) {
    const path = await envFile([...GOOD, line]);
    const r = check([path]);
    assert.deepEqual(r.faults, [`FAULT ${path}:3: not KEY=VALUE`], JSON.stringify(line));
    assert.equal(r.status, 1, JSON.stringify(line));
  }
});

test("the checker refuses a key given twice, and a required key missing", async () => {
  const twice = await envFile([...GOOD, "DID_REDIRECT=https://www.a-owner.example.test/"]);
  assert.deepEqual(check([twice]).faults, [`FAULT ${twice}:3: DID_REDIRECT given twice`]);
  const missing = await envFile([GOOD[0]]);
  const r = check([missing]);
  assert.deepEqual(r.faults, [`FAULT ${missing}: DID_REDIRECT missing`]);
  assert.equal(r.status, 1);
});

test("the checker refuses a file not named after its DID_DOMAIN", async () => {
  for (const name of ["b.example.test.env", `${DOMAIN}.txt`, `${DOMAIN}`]) {
    const path = await envFile(GOOD, name);
    const r = check([path]);
    assert.deepEqual(r.faults, [`FAULT ${path}: not named ${DOMAIN}.env`], name);
    assert.equal(r.status, 1, name);
  }
});

test("the checker refuses a domain that is not a lower-case host name, and a URL that is not http(s) or holds user information", async () => {
  const upper = await envFile([`DID_DOMAIN=A.example.test`, GOOD[1]], "A.example.test.env");
  assert.deepEqual(check([upper]).faults, [`FAULT ${upper}: DID_DOMAIN A.example.test is not a lower-case host name`]);
  const ftp = await envFile([...GOOD, "DID_LOG=ftp://log.example.test/"]);
  assert.deepEqual(check([ftp]).faults, [`FAULT ${ftp}: DID_LOG ftp://log.example.test/ is not an http(s) URL`]);
  const user = await envFile([GOOD[0], "DID_REDIRECT=https://u:p@www.a-owner.example.test/"]);
  assert.deepEqual(check([user]).faults, [`FAULT ${user}: DID_REDIRECT holds user information`]);
});

test("the checker without a file is a usage error", () => {
  const r = check([]);
  assert.equal(r.status, 2);
});

// --- the pre-commit hook --------------------------------------------------------

/** A repository with the hook, the checker and the reference list, and core.hooksPath set. */
async function hookedRepo() {
  const repo = join(await mkdtemp(join(tmpdir(), "did-hook-")), "repo");
  await mkdir(join(repo, "tools", "git-hooks"), { recursive: true });
  await mkdir(join(repo, FOLDER));
  await copyFile(HOOK, join(repo, "tools", "git-hooks", "pre-commit"));
  await chmod(join(repo, "tools", "git-hooks", "pre-commit"), 0o755);
  await copyFile(CHECKER, join(repo, "tools", "check-netlify-env.mjs"));
  await copyFile(KEYS, join(repo, "tools", "netlify-env-keys.txt"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "test"], ["config", "core.hooksPath", "tools/git-hooks"],
    ["add", "-A"], ["commit", "-qm", "tools"]]) {
    const r = gitRun(repo, args, { NODE: process.execPath });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  }
  return repo;
}
const head = (repo) => gitRun(repo, ["rev-parse", "HEAD"]).stdout.trim();
const commit = (repo) => gitRun(repo, ["commit", "-qm", "variables"], { NODE: process.execPath });

test("the pre-commit hook lets a valid file through", async () => {
  const repo = await hookedRepo();
  await writeFile(join(repo, FOLDER, `${DOMAIN}.env`), `${GOOD.join("\n")}\n`);
  gitRun(repo, ["add", "-A"]);
  const before = head(repo);
  const r = commit(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(head(repo), before);
});

test("the pre-commit hook refuses a prohibited key, and nothing is committed", async () => {
  const repo = await hookedRepo();
  const path = `${FOLDER}/${DOMAIN}.env`;
  await writeFile(join(repo, path), `${[...GOOD, "DID_ALLOW_NO_PREVIOUS=1"].join("\n")}\n`);
  gitRun(repo, ["add", "-A"]);
  const before = head(repo);
  const r = commit(repo);
  assert.notEqual(r.status, 0);
  assert.ok(lines(r.stderr).some((l) => l.startsWith(`FAULT ${path}:3: DID_ALLOW_NO_PREVIOUS is prohibited: `)), r.stderr);
  assert.equal(head(repo), before);
});

test("the pre-commit hook checks what is staged, not the working copy", async () => {
  const repo = await hookedRepo();
  const path = `${FOLDER}/${DOMAIN}.env`;
  await writeFile(join(repo, path), `${[...GOOD, "NETLIFY_AUTH_TOKEN=x"].join("\n")}\n`);
  gitRun(repo, ["add", "-A"]);
  await writeFile(join(repo, path), `${GOOD.join("\n")}\n`); // fixed, but not staged
  const before = head(repo);
  assert.notEqual(commit(repo).status, 0);
  assert.equal(head(repo), before);
});

test("the pre-commit hook refuses a file of netlify-env-public/ forced past .gitignore", async () => {
  const repo = await hookedRepo();
  const path = `${FOLDER}/notes.txt`;
  await writeFile(join(repo, path), "anything\n");
  gitRun(repo, ["add", "-f", path]);
  const before = head(repo);
  const r = commit(repo);
  assert.notEqual(r.status, 0);
  assert.ok(lines(r.stderr).some((l) => l.startsWith(`FAULT ${path}: not named `)), r.stderr);
  assert.equal(head(repo), before);
});

