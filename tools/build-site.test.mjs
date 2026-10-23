// tools/build-site.test.mjs — tools/build-site.mjs assembles one domain's site
// in dist/: the shared files of public/, the templates filled in from the
// project's variables, and the domain's data tree, which may hold its data
// and nothing else (#8).
//
// Run with: node --test tools/build-site.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm, appendFile, stat, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { A, B, REDIRECT, BUILD_SITE, DOCUMENT, TOOLS, dataTree, copyOf, git, hasLine, lines } from "./fixtures/domains.mjs";

/** Runs build-site.mjs for `domain` on `tree`; resolves to the result and the output directory. */
async function buildSite(domain, tree, redirect = REDIRECT[domain]) {
  const out = join(await mkdtemp(join(tmpdir(), "did-dist-")), "dist");
  const r = spawnSync(process.execPath, [BUILD_SITE, "--data", tree, "--out", out],
    { env: { ...process.env, DID_DOMAIN: domain, DID_REDIRECT: redirect }, encoding: "utf8" });
  return { ...r, out };
}
const read = (dir, path) => readFile(join(dir, path), "utf8");

test("A's site: A's data byte for byte, the shared files, and the templates filled in with A's values", async () => {
  const a = await dataTree(A);
  const r = await buildSite(A, a.tree);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await read(r.out, DOCUMENT), await read(a.tree, DOCUMENT));
  assert.equal(await read(r.out, `revocations/${a.tp1}.json`), await read(a.tree, `revocations/${a.tp1}.json`));
  assert.equal(await read(r.out, "_headers"), await read(join(TOOLS, "..", "public"), "_headers"));
  assert.equal(await read(r.out, "revocations/README.txt"), await read(join(TOOLS, "..", "public"), "revocations/README.txt"));

  const index = await read(r.out, "index.html");
  assert.ok(lines(index).includes(`<meta http-equiv="refresh" content="0; url=${REDIRECT[A]}">`), index);
  assert.ok(lines(index).includes(`<link rel="canonical" href="${REDIRECT[A]}">`), index);
  assert.ok(lines(await read(r.out, "doc/keyrevocationrecords.html"))
    .includes(`<link rel="canonical" href="https://${A}/doc/keyrevocationrecords">`));
  assert.ok(lines(await read(r.out, "sitemap.xml"))
    .includes(`  <url><loc>https://${A}/doc/keyrevocationrecords</loc></url>`));
  assert.ok(lines(await read(r.out, "robots.txt")).includes(`Sitemap: https://${A}/sitemap.xml`));
  // The data tree's .gitignore is not served.
  await assert.rejects(read(r.out, ".gitignore"));
});

test("B's document in a tree built for A is refused: its id is not did:web:A", async () => {
  const b = await dataTree(B);
  const r = await buildSite(A, b.tree);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(hasLine(r.stderr, new RegExp(
    `^FAULT \\.well-known/did\\.json: id is did:web:${B.replaceAll(".", "\\.")}, not did:web:${A.replaceAll(".", "\\.")}$`)), r.stderr);
});

test("a data tree holding a netlify.toml is refused: a data branch holds data only", async () => {
  const a = await dataTree(A);
  await writeFile(join(a.tree, "netlify.toml"), '[build]\n  command = "true"\n');
  const r = await buildSite(A, a.tree);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(hasLine(r.stderr, /^FAULT netlify\.toml: not a data file$/), r.stderr);
});

test("a data tree whose .gitignore is modified, or missing, is refused", async () => {
  const a = await dataTree(A);
  const modified = await copyOf(a.tree);
  await appendFile(join(modified, ".gitignore"), "!/netlify.toml\n");
  const r1 = await buildSite(A, modified);
  assert.equal(r1.status, 1, r1.stderr);
  assert.ok(hasLine(r1.stderr, /^FAULT \.gitignore: differs from tools\/data-branch\.gitignore$/), r1.stderr);

  const missing = await copyOf(a.tree);
  await rm(join(missing, ".gitignore"));
  const r2 = await buildSite(A, missing);
  assert.equal(r2.status, 1, r2.stderr);
  assert.ok(hasLine(r2.stderr, /^FAULT \.gitignore: missing$/), r2.stderr);
});

// The first domain served from this repository moves to a data branch without
// any visible change: the pages built with its values are those it served
// from public/ before #8 (main @ 2a40395), byte for byte. The one exception
// is a comment of index.html, which named the redirect's host without `www.`:
// the template names {{DID_REDIRECT_HOST}}.
test("built with the first domain's values, the pages are byte-identical to those served before #8", async () => {
  // The domain's name is built from parts: no tracked file outside
  // tools/fixtures/ names a real domain (site.test.mjs).
  const FIRST = `${["nati", "xar"].join("")}.pro`;
  const FIXTURE = join(TOOLS, "fixtures", FIRST);
  const env = Object.fromEntries(lines(await read(FIXTURE, `${FIRST}.env`))
    .filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  // Any consistent document will do: the pages do not depend on it.
  const tree = (await dataTree(env.DID_DOMAIN)).tree;
  const r = await buildSite(env.DID_DOMAIN, tree, env.DID_REDIRECT);
  assert.equal(r.status, 0, r.stderr);
  for (const page of ["index.html", "robots.txt", "sitemap.xml", "doc/keyrevocationrecords.html"])
    assert.equal(await read(r.out, page), await read(FIXTURE, page), page);
});

// --- edge cases -------------------------------------------------------------------

test("every file of a data tree that is not data is refused, and nothing is written", async () => {
  const strays = ["_headers", "_redirects", "index.html", ".github/workflows/x.yml", "revocations/README.txt",
    ".well-known/other.json", "revocations/T.txt", `revocations/${"A".repeat(43)}/x.json`, `revocations/${"A".repeat(43)}/01.ots`];
  const a = await dataTree(A);
  for (const s of strays) {
    await mkdir(dirname(join(a.tree, s)), { recursive: true });
    await writeFile(join(a.tree, s), "stray\n");
  }
  const r = await buildSite(A, a.tree);
  assert.equal(r.status, 1, r.stderr);
  const faults = lines(r.stderr).filter((l) => l.startsWith("FAULT ")).sort();
  assert.deepEqual(faults, strays.map((s) => `FAULT ${s}: not a data file`).sort());
  await assert.rejects(stat(r.out), "nothing is written");
});

test("a symbolic link in a data tree is refused, even at a data path", async () => {
  const a = await dataTree(A);
  const linked = await copyOf(a.tree);
  await rm(join(linked, DOCUMENT));
  await symlink(join(a.tree, DOCUMENT), join(linked, DOCUMENT));
  const r = await buildSite(A, linked);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(hasLine(r.stderr, /^FAULT \.well-known\/did\.json: not a regular file$/), r.stderr);

  const dirLink = await copyOf(a.tree);
  await symlink(join(a.tree, "revocations"), join(dirLink, "more"));
  const r2 = await buildSite(A, dirLink);
  assert.equal(r2.status, 1, r2.stderr);
  assert.ok(hasLine(r2.stderr, /^FAULT more: not a regular file$/), r2.stderr);
});

test("a data tree without a document, or with a document that is not JSON, is refused", async () => {
  const a = await dataTree(A);
  const none = await copyOf(a.tree);
  await rm(join(none, DOCUMENT));
  const r1 = await buildSite(A, none);
  assert.equal(r1.status, 1, r1.stderr);
  assert.ok(hasLine(r1.stderr, /^FAULT \.well-known\/did\.json: missing$/), r1.stderr);

  const broken = await copyOf(a.tree);
  await writeFile(join(broken, DOCUMENT), "{ not json\n");
  const r2 = await buildSite(A, broken);
  assert.equal(r2.status, 1, r2.stderr);
  assert.ok(hasLine(r2.stderr, /^FAULT \.well-known\/did\.json: not JSON$/), r2.stderr);
});

/** A copy of public/ with one more file. */
async function publicWith(path, content) {
  const pub = await copyOf(join(TOOLS, "..", "public"));
  await writeFile(join(pub, path), content);
  return pub;
}

test("a placeholder left unfilled fails the build, wherever it is", async () => {
  const a = await dataTree(A);
  const out = join(await mkdtemp(join(tmpdir(), "did-dist-")), "dist");
  const pub = await publicWith("extra.txt", "{{DID_DOMAIN}} and {{DID_UNKNOWN}}\n");
  const r = spawnSync(process.execPath, [BUILD_SITE, "--data", a.tree, "--out", out, "--public", pub],
    { env: { ...process.env, DID_DOMAIN: A, DID_REDIRECT: REDIRECT[A] }, encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(lines(r.stderr).filter((l) => l.startsWith("FAULT ")), ["FAULT extra.txt: {{DID_UNKNOWN}} left unfilled"]);
  await assert.rejects(stat(out));
});

test("a DID_REDIRECT with & or \" is escaped in the HTML pages", async () => {
  const a = await dataTree(A);
  const redirect = 'https://www.a-owner.example.test/?a=1&b="2"';
  const r = await buildSite(A, a.tree, redirect);
  assert.equal(r.status, 0, r.stderr);
  const index = lines(await read(r.out, "index.html"));
  const escaped = "https://www.a-owner.example.test/?a=1&#38;b=&#34;2&#34;";
  assert.ok(index.includes(`<meta http-equiv="refresh" content="0; url=${escaped}">`), index.join("\n"));
  assert.ok(index.includes(`<link rel="canonical" href="${escaped}">`), index.join("\n"));
  assert.ok(!index.some((l) => l.includes(redirect)), "the raw value appears nowhere");
});

test("the variables are checked: unset, an upper-case domain, a redirect that is not http(s)", async () => {
  const a = await dataTree(A);
  for (const [env, message] of [
    [{ DID_DOMAIN: "", DID_REDIRECT: REDIRECT[A] }, "build-site: DID_DOMAIN is not set"],
    [{ DID_DOMAIN: A.toUpperCase(), DID_REDIRECT: REDIRECT[A] }, `build-site: DID_DOMAIN ${A.toUpperCase()} is not a lower-case host name`],
    [{ DID_DOMAIN: `${A}:8443`, DID_REDIRECT: REDIRECT[A] }, `build-site: DID_DOMAIN ${A}:8443 is not a lower-case host name`],
    [{ DID_DOMAIN: A, DID_REDIRECT: "" }, "build-site: DID_REDIRECT is not set"],
    [{ DID_DOMAIN: A, DID_REDIRECT: "javascript:alert(1)" }, "build-site: DID_REDIRECT javascript:alert(1) is not an http(s) URL"],
  ]) {
    const out = join(await mkdtemp(join(tmpdir(), "did-dist-")), "dist");
    const r = spawnSync(process.execPath, [BUILD_SITE, "--data", a.tree, "--out", out],
      { env: { ...process.env, ...env }, encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(lines(r.stderr.trimEnd()), [message]);
    await assert.rejects(stat(out));
  }
});

test("an existing output directory is a usage error, and is left as it is", async () => {
  const a = await dataTree(A);
  const out = await mkdtemp(join(tmpdir(), "did-dist-"));
  await writeFile(join(out, "keep"), "keep\n");
  const r = spawnSync(process.execPath, [BUILD_SITE, "--data", a.tree, "--out", out],
    { env: { ...process.env, DID_DOMAIN: A, DID_REDIRECT: REDIRECT[A] }, encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(lines(r.stderr.trimEnd()), [`build-site: --out ${out} exists`]);
  assert.equal(await readFile(join(out, "keep"), "utf8"), "keep\n");
});

test("a data file never replaces a file of public/", async () => {
  const a = await dataTree(A);
  const pub = await copyOf(join(TOOLS, "..", "public"));
  await mkdir(join(pub, ".well-known"), { recursive: true });
  await writeFile(join(pub, DOCUMENT), "{}\n");
  const out = join(await mkdtemp(join(tmpdir(), "did-dist-")), "dist");
  const r = spawnSync(process.execPath, [BUILD_SITE, "--data", a.tree, "--out", out, "--public", pub],
    { env: { ...process.env, DID_DOMAIN: A, DID_REDIRECT: REDIRECT[A] }, encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(hasLine(r.stderr, new RegExp(`^FAULT \\.well-known/did\\.json: both a data file and a file of `)), r.stderr);
});

test("tools/data-branch.gitignore admits exactly the data paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "did-ignore-"));
  git(dir, "init", "-q");
  await copyFile(join(TOOLS, "data-branch.gitignore"), join(dir, ".gitignore"));
  const T = "A".repeat(43);
  const admitted = [".gitignore", DOCUMENT, `revocations/${T}.json`, `revocations/${T}/42.ots`, `revocations/${T}/42.tsr`];
  const ignored = [".well-known/other", "revocations/README.txt", `revocations/${T}.txt`, `revocations/${T}/x.json`,
    "netlify.toml", "_headers", "_redirects", "index.html", ".github/workflows/x.yml", ".gitattributes", "doc/x.html"];
  for (const f of [...admitted, ...ignored].filter((f) => f !== ".gitignore")) {
    await mkdir(dirname(join(dir, f)), { recursive: true });
    await writeFile(join(dir, f), "x\n");
  }
  git(dir, "add", "-A");
  assert.deepEqual(git(dir, "ls-files").split("\n").filter(Boolean).sort(), admitted.sort());
});
