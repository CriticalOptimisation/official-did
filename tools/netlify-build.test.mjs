// tools/netlify-build.test.mjs — the deploy-time check: nothing goes live that
// does not extend the state that is live now.
//
// The "live" state is served by a local HTTP server, standing for $URL. The
// live site has no directory listing: the check finds the records through the
// revoked entries of the live document, at $URL + the path of its `service`
// endpoint.
//
// Run with: node --test tools/netlify-build.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir, cp } from "node:fs/promises";
import { createServer } from "node:http";
import { webcrypto as crypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, "netlify-build.sh");
const MAKE_DID = join(HERE, "make-did.mjs");
const DID = "did:web:example.test";

const lines = (text) => text.split("\n");
const hasLine = (text, re) => lines(text).some((l) => re.test(l));

async function freshJwk() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", pair.privateKey);
}
async function thumbprintOf(jwk) {
  const m = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return Buffer.from(await crypto.subtle.digest("SHA-256",
    Buffer.from(JSON.stringify(m, Object.keys(m).sort())))).toString("base64url");
}

/** A site with two keys, the first revoked; plus its config. */
async function siteWithRevocation() {
  const root = await mkdtemp(join(tmpdir(), "did-build-"));
  const config = join(root, "did.config.json");
  await writeFile(config, JSON.stringify({ did: DID }) + "\n");
  const site = join(root, "public");
  await mkdir(join(site, ".well-known"), { recursive: true });
  const run = (args, jwk) => {
    const r = spawnSync(process.execPath, [MAKE_DID, "--config", config, "--site", site,
      "--out", join(site, ".well-known", "did.json"), ...args],
    { input: jwk ? JSON.stringify(jwk) : "", encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  const a = await freshJwk(), b = await freshJwk();
  run(["--from-private", "-"], a);
  run(["--from-private", "-", "--append"], b);
  run(["--revoke", await thumbprintOf(a), "--compromised-after", "2026-01-01T00:00:00Z"]);
  return { root, config, site, run, tpA: await thumbprintOf(a), tpB: await thumbprintOf(b) };
}

async function copyOf(site) {
  const copy = join(await mkdtemp(join(tmpdir(), "did-copy-")), "public");
  await cp(site, copy, { recursive: true });
  return copy;
}

/** Serves `dir` as a static site on 127.0.0.1; resolves to { url, close }. */
function serve(dir) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    try {
      const body = await readFile(join(dir, path));
      res.writeHead(200).end(body);
    } catch { res.writeHead(404).end("not found"); }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

/**
 * Runs the check asynchronously: the local server lives in this process, so a
 * synchronous spawn would block it.
 */
function build(env) {
  return new Promise((resolve) => {
    const child = spawn("sh", [BUILD], {
      env: { ...process.env, NODE: process.execPath, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("an extension of the live state passes", async () => {
  const s = await siteWithRevocation();
  const live = await copyOf(s.site);
  s.run(["--from-private", "-", "--append"], await freshJwk());
  const r = await build({ DID_SITE: s.site, DID_CONFIG: s.config, DID_PREVIOUS_DIR: live });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(hasLine(r.stderr, /^netlify-build: OK$/), r.stderr);
});

test("a build that removes an entry of the live state fails", async () => {
  const s = await siteWithRevocation();
  const live = await copyOf(s.site);
  const doc = JSON.parse(await readFile(join(s.site, ".well-known", "did.json"), "utf8"));
  doc.verificationMethod = doc.verificationMethod.filter((m) => !m.id.endsWith(s.tpB));
  doc.assertionMethod = doc.verificationMethod.map((m) => m.id);
  await writeFile(join(s.site, ".well-known", "did.json"), JSON.stringify(doc, null, 2) + "\n");
  const r = await build({ DID_SITE: s.site, DID_CONFIG: s.config, DID_PREVIOUS_DIR: live });
  assert.notEqual(r.status, 0);
  assert.ok(hasLine(r.stderr, /^FAULT .+: removed since the previous state$/), r.stderr);
});

test("the live state is fetched from $URL, records included, through the live document", async () => {
  const s = await siteWithRevocation();
  const live = await copyOf(s.site);
  const server = await serve(live);
  try {
    // The build moves compromisedAfter later in the record: only the fetched
    // live record can reveal it.
    const path = join(s.site, "revocations", `${s.tpA}.json`);
    const rec = JSON.parse(await readFile(path, "utf8"));
    rec.compromisedAfter = "2026-02-01T00:00:00Z";
    await writeFile(path, JSON.stringify(rec, null, 2) + "\n");
    const r = await build({ DID_SITE: s.site, DID_CONFIG: s.config, URL: server.url });
    assert.notEqual(r.status, 0);
    assert.ok(hasLine(r.stderr, /^FAULT .+: compromisedAfter moved later .+$/), r.stderr);
  } finally { server.close(); }
});

test("no reachable live state: the build fails, unless DID_ALLOW_NO_PREVIOUS=1", async () => {
  const s = await siteWithRevocation();
  const unreachable = "http://127.0.0.1:9";
  const r = await build({ DID_SITE: s.site, DID_CONFIG: s.config, URL: unreachable });
  assert.notEqual(r.status, 0);
  assert.ok(hasLine(r.stderr,
    /^netlify-build: cannot fetch the live state from http:\/\/127\.0\.0\.1:9; set DID_ALLOW_NO_PREVIOUS=1 for a first deploy$/), r.stderr);

  const ok = await build({ DID_SITE: s.site, DID_CONFIG: s.config, URL: unreachable, DID_ALLOW_NO_PREVIOUS: "1" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(hasLine(ok.stderr, /^netlify-build: no previous state \(DID_ALLOW_NO_PREVIOUS=1\)$/), ok.stderr);
});
