// tools/data-branch.test.mjs — tools/data-branch.sh init: the orphan commit
// of a new data branch, holding the data paths and the reference .gitignore,
// and nothing else (#8). It pushes nothing.
//
// Run with: node --test tools/data-branch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  A, DATA_BRANCH, DATA_GITIGNORE, DOCUMENT,
  dataTree, copyOf, makeDid, freshJwk, git, headOf, run, hasLine,
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
