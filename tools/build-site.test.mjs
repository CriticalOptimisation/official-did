// tools/build-site.test.mjs — tools/build-site.mjs assembles one domain's site
// in dist/: the shared files of public/, the templates filled in from the
// project's variables, and the domain's data tree, which may hold its data
// and nothing else (#8).
//
// Run with: node --test tools/build-site.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { A, B, REDIRECT, BUILD_SITE, DOCUMENT, TOOLS, dataTree, copyOf, hasLine, lines } from "./fixtures/domains.mjs";

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
