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
import { join, dirname } from "node:path";
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


// --- edge cases -------------------------------------------------------------------

test("the checker refuses a value with a blank, a control character, a quote or a backslash, and an empty value", async () => {
  // new URL() would trim the trailing space and read `\` as `/`: the line is refused before.
  for (const line of ["DID_LOG=https://log.example.test/ ", " DID_LOG=https://log.example.test/",
    "DID_LOG =https://log.example.test/", "DID_LOG= https://log.example.test/", "DID_LOG=https://log.example.test/\t",
    "DID_LOG=https://log.example.test/a b", 'DID_LOG="https://log.example.test/"', "DID_LOG='https://log.example.test/'",
    "DID_LOG=https://log.example.test\\a", "DID_LOG=https://log.example.test/`x`", "DID_LOG=https://log.example.test/\x01",
    "DID_LOG="]) {
    const path = await envFile([...GOOD, line]);
    const r = check([path]);
    assert.deepEqual(r.faults, [`FAULT ${path}:3: not KEY=VALUE`], JSON.stringify(line));
    assert.equal(r.status, 1, JSON.stringify(line));
  }
});

test("the checker reads a file without a final newline, last line included", async () => {
  const good = await envFile(GOOD.join("\n"));
  const r = check([good]);
  assert.deepEqual(r.faults, []);
  assert.equal(r.status, 0);
  const bad = await envFile([...GOOD, "GH_TOKEN=x"].join("\n"));
  assert.deepEqual(check([bad]).faults, [`FAULT ${bad}:3: GH_TOKEN is prohibited: a GitHub token`]);
  // A blank line at the end is a line: one newline too many.
  const blank = await envFile(`${GOOD.join("\n")}\n\n`);
  assert.deepEqual(check([blank]).faults, [`FAULT ${blank}:3: not KEY=VALUE`]);
});

test("the checker reports every fault of a file, lines first, in order", async () => {
  const path = await envFile(["# header", "DID_DOMAIN=B.example.test", "DID_PUBLISH_WORKDIR=/srv",
    "DID_DOMAIN=a.example.test", "DID_LOG=mailto:x@log.example.test"]);
  const r = check([path]);
  assert.deepEqual(r.faults, [
    `FAULT ${path}:1: not KEY=VALUE`,
    `FAULT ${path}:3: DID_PUBLISH_WORKDIR is prohibited: a setting of the publishing server, not of the Netlify project`,
    `FAULT ${path}:4: DID_DOMAIN given twice`,
    `FAULT ${path}: not named B.example.test.env`,
    `FAULT ${path}: DID_REDIRECT missing`,
    `FAULT ${path}: DID_DOMAIN B.example.test is not a lower-case host name`,
    `FAULT ${path}: DID_LOG mailto:x@log.example.test is not an http(s) URL`,
  ]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
});

test("the checker checks several files at once, in the order given", async () => {
  const good = await envFile(GOOD);
  const bad1 = await envFile([GOOD[0]]);
  const bad2 = await envFile([...GOOD, "TOKEN=x"]);
  const r = check([bad2, good, bad1]);
  assert.deepEqual(r.faults, [`FAULT ${bad2}:3: TOKEN is not an allowed key`, `FAULT ${bad1}: DID_REDIRECT missing`]);
  assert.equal(r.status, 1);
  const ok = check([good, await envFile(GOOD)]);
  assert.deepEqual(ok.faults, []);
  assert.equal(ok.status, 0);
});

test("a file without DID_DOMAIN gets no name fault when it is named *.env, and one when it is not", async () => {
  const env = await envFile([GOOD[1]]);
  assert.deepEqual(check([env]).faults, [`FAULT ${env}: DID_DOMAIN missing`]);
  const txt = await envFile([GOOD[1]], "notes.txt");
  assert.deepEqual(check([txt]).faults, [`FAULT ${txt}: not named <DID_DOMAIN>.env`, `FAULT ${txt}: DID_DOMAIN missing`]);
});

test("the checker's usage errors: --staged with a file, an unreadable file, an unreadable or malformed reference list", async () => {
  const empty = check([]);
  assert.deepEqual(empty.faults, ["check-netlify-env: usage: check-netlify-env.mjs <file>... | --staged"]);
  const both = check(["--staged", await envFile(GOOD)]);
  assert.equal(both.status, 2);
  assert.deepEqual(both.faults, ["check-netlify-env: usage: check-netlify-env.mjs <file>... | --staged"]);
  const missing = join(await mkdtemp(join(tmpdir(), "did-env-")), `${DOMAIN}.env`);
  const r = check([missing]);
  assert.equal(r.status, 2);
  assert.deepEqual(r.faults, [`check-netlify-env: cannot read ${missing}: ENOENT`]);

  // A copy of the checker beside a broken list.
  const dir = await mkdtemp(join(tmpdir(), "did-keys-"));
  await copyFile(CHECKER, join(dir, "check-netlify-env.mjs"));
  const run = () => spawnSync(process.execPath, [join(dir, "check-netlify-env.mjs"), missing], { encoding: "utf8" });
  const none = run();
  assert.equal(none.status, 2);
  assert.deepEqual(lines(none.stderr).filter(Boolean), [`check-netlify-env: cannot read ${join(dir, "netlify-env-keys.txt")}: ENOENT`]);
  for (const bad of ["DID_DOMAIN required\nDID_DOMAIN optional\n", "DID_DOMAIN mandatory\n", "GH_TOKEN prohibited\n",
    "DID_DOMAIN required because\n", "did_domain required\n"]) {
    await writeFile(join(dir, "netlify-env-keys.txt"), `# comment\n\n${bad}`);
    const b = run();
    assert.equal(b.status, 2, bad);
    assert.equal(lines(b.stderr).filter(Boolean).length, 1, b.stderr);
    assert.match(b.stderr, /^check-netlify-env: .*netlify-env-keys\.txt:[34]: not <KEY> required\|optional\|prohibited <reason>\n$/, bad);
  }
});

test("netlify-env-public/ ignores a directory named like a .env file, and what it holds", () => {
  const ignored = (path) => gitRun(REPO, ["check-ignore", "-q", "--no-index", path]).status === 0;
  assert.equal(ignored(`${FOLDER}/x.example.test.env/notes.txt`), true);
  assert.equal(ignored(`${FOLDER}/x.example.test.env/y.example.test.env`), true);
});

test("the pre-commit hook does not check a deleted file", async () => {
  const repo = await hookedRepo();
  const path = `${FOLDER}/${DOMAIN}.env`;
  await writeFile(join(repo, path), `${[...GOOD, "GH_TOKEN=x"].join("\n")}\n`);
  gitRun(repo, ["add", "-A"]);
  assert.equal(gitRun(repo, ["commit", "-qm", "bad", "--no-verify"]).status, 0);
  gitRun(repo, ["rm", "-q", path]);
  const before = head(repo);
  const r = commit(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.notEqual(head(repo), before);
});

test("the pre-commit hook refuses a file in a subfolder of netlify-env-public/, even named after its domain", async () => {
  const repo = await hookedRepo();
  const path = `${FOLDER}/sub/${DOMAIN}.env`;
  await mkdir(join(repo, FOLDER, "sub"));
  await writeFile(join(repo, path), `${GOOD.join("\n")}\n`);
  gitRun(repo, ["add", "-f", path]);
  const before = head(repo);
  const r = commit(repo);
  assert.notEqual(r.status, 0);
  assert.deepEqual(lines(r.stderr).filter(Boolean), [`FAULT ${path}: not named ${DOMAIN}.env`]);
  assert.equal(head(repo), before);
  // Without DID_DOMAIN, a *.env name in a subfolder is refused too.
  gitRun(repo, ["rm", "-q", "--cached", path]);
  const other = `${FOLDER}/sub/x.env`;
  await writeFile(join(repo, other), `${GOOD[1]}\n`);
  gitRun(repo, ["add", "-f", other]);
  const r2 = commit(repo);
  assert.notEqual(r2.status, 0);
  assert.deepEqual(lines(r2.stderr).filter(Boolean),
    [`FAULT ${other}: not named <DID_DOMAIN>.env`, `FAULT ${other}: DID_DOMAIN missing`]);
  assert.equal(head(repo), before);
});

test("--staged checks every staged file of the folder, from any directory of the work tree, and nothing outside it", async () => {
  const repo = await hookedRepo();
  await writeFile(join(repo, FOLDER, `${DOMAIN}.env`), `${[...GOOD, "TOKEN=x"].join("\n")}\n`);
  await writeFile(join(repo, FOLDER, "b.example.test.env"), "DID_DOMAIN=b.example.test\n");
  await writeFile(join(repo, `${DOMAIN}.env`), "anything\n"); // outside the folder
  gitRun(repo, ["add", "-A"]);
  const r = check(["--staged"], join(repo, "tools"));
  assert.deepEqual(r.faults.sort(), [`FAULT ${FOLDER}/${DOMAIN}.env:3: TOKEN is not an allowed key`,
    `FAULT ${FOLDER}/b.example.test.env: DID_REDIRECT missing`].sort());
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
});

test("--staged outside a git work tree is a usage error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "did-nogit-"));
  const r = spawnSync(process.execPath, [CHECKER, "--staged"], { cwd: dir, encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) } });
  assert.equal(r.status, 2);
  assert.deepEqual(lines(r.stderr).filter(Boolean).map((l) => l.split(":").slice(0, 2).join(":")), ["check-netlify-env: git rev-parse"]);
});
