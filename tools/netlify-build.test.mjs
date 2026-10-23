// tools/netlify-build.test.mjs — the deploy-time check: nothing goes live that
// does not extend the state that is live now, and each domain's build uses
// that domain's own data and live state, never another's (#8).
//
// The data tree comes from DID_DATA_DIR, or from the branch data/$DID_DOMAIN
// of $REPOSITORY_URL (a local bare repository here). The "live" state is
// DID_PREVIOUS_DIR, or is served by a local HTTP server standing for $URL;
// the domain of such a server is its host name, `localhost`. The live site
// has no directory listing: the check finds the records through the revoked
// entries of the live document, at $URL + the path of its `service` endpoint.
//
// Run with: node --test tools/netlify-build.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  A, B, LOCAL, REDIRECT, NETLIFY_BUILD, DOCUMENT,
  dataTree, copyOf, makeDid, freshJwk, twoDomainOrigin, serve, run, git, hasLine, lines,
} from "./fixtures/domains.mjs";

/** Runs the build for `domain`, with its own output directory; resolves to { status, stderr, dist }. */
async function build(domain, env) {
  const dist = join(await mkdtemp(join(tmpdir(), "did-dist-")), "dist");
  const vars = { DID_DIST: dist, ...(domain ? { DID_DOMAIN: domain } : {}),
    DID_REDIRECT: REDIRECT[domain] ?? "https://www.owner.example.test/", ...env };
  return { ...await run("sh", [NETLIFY_BUILD], vars), dist };
}
const builtDoc = (r) => readFile(join(r.dist, DOCUMENT), "utf8");
const docOf = (tree) => readFile(join(tree, DOCUMENT), "utf8");

test("an extension of the live state passes, and the built site carries the data tree's document", async () => {
  const a = await dataTree(A);
  const live = await copyOf(a.tree);
  makeDid(A, a.tree, ["--from-private", "-", "--append"], await freshJwk());
  const r = await build(A, { DID_DATA_DIR: a.tree, DID_PREVIOUS_DIR: live, URL: `https://${A}` });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(hasLine(r.stderr, /^netlify-build: OK$/), r.stderr);
  assert.equal(await builtDoc(r), await docOf(a.tree));
});

test("a build that removes an entry of the live state fails", async () => {
  const a = await dataTree(A);
  const live = await copyOf(a.tree);
  // The control: the same build, before the removal, passes.
  const control = await build(A, { DID_DATA_DIR: a.tree, DID_PREVIOUS_DIR: live, URL: `https://${A}` });
  assert.equal(control.status, 0, control.stderr);
  const doc = JSON.parse(await docOf(a.tree));
  doc.verificationMethod = doc.verificationMethod.filter((m) => !m.id.endsWith(a.tp2));
  doc.assertionMethod = doc.verificationMethod.map((m) => m.id);
  await writeFile(join(a.tree, DOCUMENT), JSON.stringify(doc, null, 2) + "\n");
  const r = await build(A, { DID_DATA_DIR: a.tree, DID_PREVIOUS_DIR: live, URL: `https://${A}` });
  assert.notEqual(r.status, 0);
  assert.ok(hasLine(r.stderr, /^FAULT .+: removed since the previous state$/), r.stderr);
});

test("the live state is fetched from $URL, records included, through the live document", async () => {
  const t = await dataTree(LOCAL);
  const live = await copyOf(t.tree);
  const server = await serve(live);
  try {
    // The build moves compromisedAfter later in the record: only the fetched
    // live record can reveal it.
    const path = join(t.tree, "revocations", `${t.tp1}.json`);
    const rec = JSON.parse(await readFile(path, "utf8"));
    rec.compromisedAfter = "2026-02-01T00:00:00Z";
    await writeFile(path, JSON.stringify(rec, null, 2) + "\n");
    const r = await build(LOCAL, { DID_DATA_DIR: t.tree, URL: server.url });
    assert.notEqual(r.status, 0);
    assert.ok(hasLine(r.stderr, /^FAULT .+: compromisedAfter moved later .+$/), r.stderr);
  } finally { server.close(); }
});

test("no reachable live state: the build fails, unless DID_ALLOW_NO_PREVIOUS=1", async () => {
  const t = await dataTree(LOCAL);
  const unreachable = `http://${LOCAL}:9`;
  const r = await build(LOCAL, { DID_DATA_DIR: t.tree, URL: unreachable });
  assert.notEqual(r.status, 0);
  assert.ok(hasLine(r.stderr,
    /^netlify-build: cannot fetch the live state from http:\/\/localhost:9; set DID_ALLOW_NO_PREVIOUS=1 for a first deploy$/), r.stderr);

  const ok = await build(LOCAL, { DID_DATA_DIR: t.tree, URL: unreachable, DID_ALLOW_NO_PREVIOUS: "1" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(hasLine(ok.stderr, /^netlify-build: no previous state \(DID_ALLOW_NO_PREVIOUS=1\)$/), ok.stderr);
  assert.equal(await builtDoc(ok), await docOf(t.tree));
});

// --- several domains (#8) -------------------------------------------------------

test("the data tree is the branch data/$DID_DOMAIN of $REPOSITORY_URL, and the build logs its commit", async () => {
  const o = await twoDomainOrigin();
  const live = await copyOf(o.trees[A].tree);
  const r = await build(A, { REPOSITORY_URL: o.origin, DID_PREVIOUS_DIR: live, URL: `https://${A}` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await builtDoc(r), await docOf(o.trees[A].tree));
  assert.ok(hasLine(r.stderr, new RegExp(`^netlify-build: data/${A.replaceAll(".", "\\.")} at ${o.trees[A].commit}$`)), r.stderr);
});

test("A's data checked against B's live state fails", async () => {
  const a = await dataTree(A), b = await dataTree(B);
  // The control: against A's own live state, the same build passes.
  const control = await build(A, { DID_DATA_DIR: a.tree, DID_PREVIOUS_DIR: await copyOf(a.tree), URL: `https://${A}` });
  assert.equal(control.status, 0, control.stderr);
  const r = await build(A, { DID_DATA_DIR: a.tree, DID_PREVIOUS_DIR: b.tree, URL: `https://${A}` });
  assert.notEqual(r.status, 0);
  assert.ok(!hasLine(r.stderr, /^netlify-build: OK$/), r.stderr);
});

test("a build whose $URL is not on DID_DOMAIN is refused before anything is compared", async () => {
  const a = await dataTree(A);
  const r = await build(A, { DID_DATA_DIR: a.tree, DID_PREVIOUS_DIR: await copyOf(a.tree), URL: `https://${B}` });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(hasLine(r.stderr, new RegExp(
    `^netlify-build: URL host ${B.replaceAll(".", "\\.")} is not DID_DOMAIN ${A.replaceAll(".", "\\.")}$`)), r.stderr);
});

test("a build without DID_DOMAIN is refused", async () => {
  const a = await dataTree(A);
  const r = await build(null, { DID_DATA_DIR: a.tree, DID_PREVIOUS_DIR: await copyOf(a.tree), URL: `https://${A}` });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(hasLine(r.stderr, /^netlify-build: DID_DOMAIN is not set$/), r.stderr);
});

// --- edge cases -------------------------------------------------------------------

test("a domain without a data branch is refused, and names the repository", async () => {
  const o = await twoDomainOrigin();
  const C = "c.example.test";
  const r = await build(C, { REPOSITORY_URL: o.origin, DID_PREVIOUS_DIR: await copyOf(o.trees[A].tree), URL: `https://${C}` });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(lines(r.stderr.trimEnd()), [`netlify-build: no branch data/${C} in ${o.origin}`]);
});

test("the refusals before the check: DID_REDIRECT, URL, an upper-case DID_DOMAIN", async () => {
  const a = await dataTree(A);
  const base = { DID_DATA_DIR: a.tree, DID_PREVIOUS_DIR: await copyOf(a.tree), URL: `https://${A}` };
  for (const [domain, env, message] of [
    [A, { DID_REDIRECT: "" }, "netlify-build: DID_REDIRECT is not set"],
    [A, { URL: "" }, "netlify-build: URL is not set"],
    [A, { URL: "not a url" }, "netlify-build: URL not a url is not a URL"],
    [A.toUpperCase(), { URL: `https://${A.toUpperCase()}` }, `netlify-build: DID_DOMAIN ${A.toUpperCase()} is not a lower-case host name`],
    [`${A}..`, { URL: `https://${A}` }, `netlify-build: DID_DOMAIN ${A}.. is not a lower-case host name`],
  ]) {
    const r = await build(domain, { ...base, ...env });
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(lines(r.stderr.trimEnd()), [message]);
    await assert.rejects(stat(r.dist), "nothing is built");
  }
});

test("a port in $URL is not compared: the host name is", async () => {
  const a = await dataTree(A);
  const r = await build(A, { DID_DATA_DIR: a.tree, DID_PREVIOUS_DIR: await copyOf(a.tree), URL: `https://${A}:8443/` });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(hasLine(r.stderr, /^netlify-build: OK$/), r.stderr);
});

test("a data branch's .gitattributes cannot hide a file from the build", async () => {
  const o = await twoDomainOrigin();
  // A commit on data/A that adds a netlify.toml and hides it, and itself, from `git archive`.
  const work = join(o.root, "hide");
  git(o.root, "clone", "-q", "--single-branch", "-b", `data/${A}`, o.origin, work);
  git(work, "config", "user.email", "test@example.invalid");
  git(work, "config", "user.name", "test");
  await writeFile(join(work, ".gitattributes"), "netlify.toml export-ignore\n.gitattributes export-ignore\n");
  await writeFile(join(work, "netlify.toml"), '[build]\n  command = "true"\n');
  git(work, "add", "-f", ".gitattributes", "netlify.toml");
  git(work, "commit", "-qm", "hide");
  git(work, "push", "-q", "origin", `data/${A}`);
  const r = await build(A, { REPOSITORY_URL: o.origin, DID_PREVIOUS_DIR: await copyOf(o.trees[A].tree), URL: `https://${A}` });
  assert.equal(r.status, 1, r.stderr);
  const faults = lines(r.stderr).filter((l) => l.startsWith("FAULT ")).sort();
  assert.deepEqual(faults, ["FAULT .gitattributes: not a data file", "FAULT netlify.toml: not a data file"]);
});

test("a stale output directory is replaced, not merged into", async () => {
  const a = await dataTree(A);
  const dist = join(await mkdtemp(join(tmpdir(), "did-dist-")), "dist");
  await mkdir(dist);
  await writeFile(join(dist, "stale.html"), "stale\n");
  const r = await build(A, { DID_DATA_DIR: a.tree, DID_PREVIOUS_DIR: await copyOf(a.tree), URL: `https://${A}`, DID_DIST: dist });
  assert.equal(r.status, 0, r.stderr);
  await assert.rejects(stat(join(dist, "stale.html")));
  assert.equal(await readFile(join(dist, DOCUMENT), "utf8"), await docOf(a.tree));
});

// --- Change History -------------------------------------------------------
// | PR     | Summary                                                       |
// |--------|---------------------------------------------------------------|
// | #10    | the build fetches and checks data/$DID_DOMAIN (#8)            |
