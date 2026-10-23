// tools/data-branch.test.mjs — tools/data-branch.sh init: the orphan commit
// of a new data branch, holding the data paths and the reference .gitignore,
// and nothing else (#8). It pushes nothing.
//
// Run with: node --test tools/data-branch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  A, DATA_BRANCH, DATA_GITIGNORE, DOCUMENT,
  dataTree, copyOf, makeDid, freshJwk, git, headOf, run, hasLine, lines,
} from "./fixtures/domains.mjs";

const BRANCH = `data/${A}`;

/** An empty repository standing for a maintainer's clone. */
async function clone() {
  const dir = join(await mkdtemp(join(tmpdir(), "did-clone-")), "clone");
  await mkdir(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "maintainer@example.invalid");
  git(dir, "config", "user.name", "maintainer");
  return dir;
}

/** A site as public/ held it before #8: A's data, plus files that are not data. */
async function sourceSite() {
  const a = await dataTree(A);
  await rm(join(a.tree, ".gitignore"));
  await writeFile(join(a.tree, "index.html"), "<!doctype html>\n");
  await writeFile(join(a.tree, "_headers"), "/\n  X-Robots-Tag: noindex\n");
  await writeFile(join(a.tree, "revocations", "README.txt"), "records\n");
  return a;
}

const filesOf = (dir, sha) => git(dir, "ls-tree", "-r", "--name-only", sha).split("\n").filter(Boolean).sort();
const blob = (dir, sha, path) => git(dir, "show", `${sha}:${path}`);

test("init without a source: an orphan data/<domain> holding only the reference .gitignore", async () => {
  const dir = await clone();
  const r = await run("sh", [DATA_BRANCH, "init", A, dir], {});
  assert.equal(r.status, 0, r.stderr);
  const sha = r.stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(headOf(dir, BRANCH), sha);
  assert.equal(git(dir, "rev-list", "--parents", "-n", "1", sha).trim(), sha, "an orphan commit has no parent");
  assert.deepEqual(filesOf(dir, sha), [".gitignore"]);
  assert.equal(blob(dir, sha, ".gitignore"), await readFile(DATA_GITIGNORE, "utf8"));
});

test("init from a source site: its data paths byte for byte, the reference .gitignore, and nothing else", async () => {
  const dir = await clone();
  const src = await sourceSite();
  const r = await run("sh", [DATA_BRANCH, "init", A, dir, src.tree], { DID_PREVIOUS_DIR: await copyOf(src.tree) });
  assert.equal(r.status, 0, r.stderr);
  const sha = r.stdout.trim();
  assert.deepEqual(filesOf(dir, sha), [".gitignore", ".well-known/did.json", `revocations/${src.tp1}.json`].sort());
  assert.equal(blob(dir, sha, ".well-known/did.json"), await readFile(join(src.tree, DOCUMENT), "utf8"));
  assert.equal(blob(dir, sha, `revocations/${src.tp1}.json`),
    await readFile(join(src.tree, "revocations", `${src.tp1}.json`), "utf8"));
});

test("init from a source that differs from the live state is refused, and creates nothing", async () => {
  const dir = await clone();
  const src = await sourceSite();
  const live = await copyOf(src.tree);
  makeDid(A, src.tree, ["--from-private", "-", "--append"], await freshJwk());
  const r = await run("sh", [DATA_BRANCH, "init", A, dir, src.tree], { DID_PREVIOUS_DIR: live });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(hasLine(r.stderr, /^data-branch: \.well-known\/did\.json differs from the live state$/), r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(headOf(dir, BRANCH), null);
});

// --- edge cases -------------------------------------------------------------------

test("init on a branch that exists already is refused, and leaves it as it is", async () => {
  const dir = await clone();
  const first = (await run("sh", [DATA_BRANCH, "init", A, dir], {})).stdout.trim();
  const r = await run("sh", [DATA_BRANCH, "init", A, dir], {});
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(lines(r.stderr.trimEnd()), [`data-branch: ${BRANCH} already exists in ${dir}`]);
  assert.equal(r.stdout, "");
  assert.equal(headOf(dir, BRANCH), first);
});

test("init from a source that lacks a file the live site serves is refused", async () => {
  const dir = await clone();
  const src = await sourceSite();
  const live = await copyOf(src.tree);
  await rm(join(src.tree, "revocations", `${src.tp1}.json`));
  const r = await run("sh", [DATA_BRANCH, "init", A, dir, src.tree], { DID_PREVIOUS_DIR: live });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(lines(r.stderr.trimEnd()), [`data-branch: revocations/${src.tp1}.json is live but missing from ${src.tree}`]);
  assert.equal(headOf(dir, BRANCH), null);
});

test("init from a source holding a link at a data path is refused", async () => {
  const dir = await clone();
  const src = await sourceSite();
  const live = await copyOf(src.tree);
  await rm(join(src.tree, DOCUMENT));
  await symlink(join(live, DOCUMENT), join(src.tree, DOCUMENT));
  const r = await run("sh", [DATA_BRANCH, "init", A, dir, src.tree], { DID_PREVIOUS_DIR: live });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(lines(r.stderr.trimEnd()), ["data-branch: .well-known/did.json is not a regular file"]);
  assert.equal(headOf(dir, BRANCH), null);
});

test("usage errors: an upper-case domain, a missing clone argument, an unknown command", async () => {
  const dir = await clone();
  for (const [args, first] of [
    [["init", A.toUpperCase(), dir], `data-branch: ${A.toUpperCase()} is not a lower-case host name`],
    [["init", A], "data-branch: wrong number of arguments"],
    [["push", A, dir], "data-branch: unknown command: push"],
  ]) {
    const r = await run("sh", [DATA_BRANCH, ...args], {});
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(lines(r.stderr.trimEnd()), [first, "data-branch: usage: data-branch.sh init <domain> <clone> [<source site>]"]);
    assert.equal(r.stdout, "");
  }
  assert.equal(headOf(dir, BRANCH), null);
});

test("init leaves the clone's HEAD, index and working tree as they were", async () => {
  const dir = await clone();
  await writeFile(join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "a");
  await writeFile(join(dir, "b.txt"), "b\n");
  git(dir, "add", "b.txt");
  const before = { head: git(dir, "rev-parse", "HEAD"), branch: git(dir, "symbolic-ref", "HEAD"), status: git(dir, "status", "--porcelain") };
  const r = await run("sh", [DATA_BRANCH, "init", A, dir], {});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.deepEqual({ head: git(dir, "rev-parse", "HEAD"), branch: git(dir, "symbolic-ref", "HEAD"), status: git(dir, "status", "--porcelain") }, before);
});
