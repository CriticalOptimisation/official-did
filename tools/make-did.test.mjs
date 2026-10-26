// tools/make-did.test.mjs — the cases make-did.mjs must decide: consistency,
// append, revoke, anchors, and what may change from one published state to the
// next.
//
// Without them, the consistency check that continuous integration runs would
// pass just as well if it checked nothing.
//
// THE PRIVATE KEY GOES THROUGH STDIN, NEVER THROUGH A FILE, here too: the rule
// admits no "it's only a test" exception. Key pairs are generated on the fly
// and die with the process.
//
// Run with: node --test tools/make-did.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir, cp, rm } from "node:fs/promises";
import { webcrypto as crypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const SCRIPT = join(HERE, "make-did.mjs");

// A neutral DID: tests name no real site.
const DID = "did:web:example.test";
const DOMAIN = "example.test";

async function freshKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { pair, jwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

const scratch = async () => join(await mkdtemp(join(tmpdir(), "did-")), "did.json");

/** Generates a document, the private key going through stdin. */
function make(jwk, out, extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, "--did", DID, "--from-private", "-", "--out", out, ...extra],
    { input: JSON.stringify(jwk), encoding: "utf8", cwd: REPO });
  assert.equal(r.status, 0, `generation failed: ${r.stderr}`);
  return r;
}

/** The internal consistency check, as continuous integration runs it. */
function verify(path) {
  return spawnSync(process.execPath, [SCRIPT, "--did", DID, "--verify-file", path], { encoding: "utf8", cwd: REPO });
}

test("sound document, fragment = thumbprint: accepted", async () => {
  const { jwk } = await freshKey();
  const out = await scratch();
  make(jwk, out);
  assert.equal(verify(out).status, 0);
});

test("--also-key-name variant, two entries: accepted, with the note", async () => {
  const { jwk } = await freshKey();
  const out = await scratch();
  make(jwk, out, ["--also-key-name", "key-1"]);

  const doc = JSON.parse(await readFile(out, "utf8"));
  assert.equal(doc.verificationMethod.length, 2);
  assert.ok(doc.verificationMethod.some((m) => m.id === `${DID}#key-1`));

  const r = verify(out);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /named fragment/);
});

test("publicKeyJwk edited, fragment unchanged: refused", async () => {
  const { jwk } = await freshKey();
  const other = await freshKey();
  const out = await scratch();
  make(jwk, out);

  // The exact edit a hand would make: replace the key, keep the fragment. The
  // document remains perfectly well formed.
  const doc = JSON.parse(await readFile(out, "utf8"));
  doc.verificationMethod[0].publicKeyJwk =
    { crv: "P-256", kty: "EC", x: other.jwk.x, y: other.jwk.y };
  await writeFile(out, JSON.stringify(doc, null, 2) + "\n");

  const r = verify(out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /thumbprint-shaped fragment, but the key gives/);
});

test("member \"d\" present — private key published: refused", async () => {
  const { jwk } = await freshKey();
  const out = await scratch();
  make(jwk, out);

  const doc = JSON.parse(await readFile(out, "utf8"));
  doc.verificationMethod[0].publicKeyJwk.d = jwk.d;
  await writeFile(out, JSON.stringify(doc, null, 2) + "\n");

  const r = verify(out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PRIVATE KEY PUBLISHED/);
});

test("named fragment only, no thumbprint: refused", async () => {
  const { jwk } = await freshKey();
  const out = await scratch();
  make(jwk, out, ["--also-key-name", "key-1"]);

  // Remove the thumbprint entry: only `#key-1` remains.
  const doc = JSON.parse(await readFile(out, "utf8"));
  doc.verificationMethod = doc.verificationMethod.filter((m) => m.id.endsWith("#key-1"));
  doc.assertionMethod = doc.verificationMethod.map((m) => m.id);
  await writeFile(out, JSON.stringify(doc, null, 2) + "\n");

  const r = verify(out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no key published under its RFC 7638 thumbprint/);
});

test("--check: the document rebuilt from the same key matches; another key does not", async () => {
  const { jwk } = await freshKey();
  const other = await freshKey();
  const out = await scratch();
  make(jwk, out);
  const run = (k) => spawnSync(process.execPath, [SCRIPT, "--did", DID, "--from-private", "-", "--out", out, "--check"],
    { input: JSON.stringify(k), encoding: "utf8", cwd: REPO });
  assert.equal(run(jwk).status, 0);
  assert.equal(run(other.jwk).status, 1);
});

// --- sites: a document, its records, and what may change between two states --
//
// A site is a directory laid out as Netlify publishes it: .well-known/did.json,
// and the revocation records wherever the document's `service` entry points.

const lines = (text) => text.split("\n");
/** True if one whole line of `text` matches `re` (anchored by the caller). */
const hasLine = (text, re) => lines(text).some((l) => re.test(l));

async function newSite() {
  const site = join(await mkdtemp(join(tmpdir(), "did-site-")), "public");
  await mkdir(join(site, ".well-known"), { recursive: true });
  return site;
}
const docPath = (site) => join(site, ".well-known", "did.json");
const readDoc = async (site) => JSON.parse(await readFile(docPath(site), "utf8"));
const recordPath = (site, tp) => join(site, "revocations", `${tp}.json`);

/** Runs make-did.mjs on a site, with an optional private key on stdin. */
function onSite(site, args, jwk = null) {
  return spawnSync(process.execPath,
    [SCRIPT, "--did", DID, "--site", site, "--out", docPath(site), ...args],
    { input: jwk ? JSON.stringify(jwk) : "", encoding: "utf8", cwd: REPO });
}
function ok(r, what) { assert.equal(r.status, 0, `${what} failed: ${r.stderr}`); return r; }

async function thumbprintOf(jwk) {
  const m = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  const canonical = JSON.stringify(m, Object.keys(m).sort());
  return Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(canonical))).toString("base64url");
}

async function copySite(site) {
  const copy = join(await mkdtemp(join(tmpdir(), "did-copy-")), "public");
  await cp(site, copy, { recursive: true });
  return copy;
}

function verifyPrevious(site, previous) {
  return spawnSync(process.execPath,
    [SCRIPT, "--did", DID, "--site", site, "--verify-file", docPath(site), "--previous", previous],
    { encoding: "utf8", cwd: REPO });
}

/**
 * A minimal OpenTimestamps proof header committing to `digest` (32 bytes):
 * magic, version 1, file-hash operation SHA-256, the digest. A real proof
 * continues with its attestations; make-did.mjs reads the header only.
 */
function otsHeader(digest) {
  const magic = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");
  return Buffer.concat([magic, Buffer.from([0x01, 0x08]), digest]);
}

// Converted in #8: the DID came from did.config.json; it now comes from the
// Netlify project's variable DID_DOMAIN, and there is no default.
test("DID_DOMAIN: the DID is did:web:$DID_DOMAIN when --did is absent; without either, a usage error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "did-domain-"));
  const out = join(dir, "did.json");
  const { jwk } = await freshKey();
  const gen = (env) => spawnSync(process.execPath, [SCRIPT, "--from-private", "-", "--out", out],
    { input: JSON.stringify(jwk), encoding: "utf8", cwd: REPO, env: { ...process.env, ...env } });
  ok(gen({ DID_DOMAIN: "domain.test" }), "generation");
  assert.equal(JSON.parse(await readFile(out, "utf8")).id, "did:web:domain.test");

  const env = { ...process.env };
  delete env.DID_DOMAIN;
  const none = spawnSync(process.execPath, [SCRIPT, "--from-private", "-", "--out", join(dir, "none.json")],
    { input: JSON.stringify(jwk), encoding: "utf8", cwd: REPO, env });
  assert.equal(none.status, 2, none.stderr);
  assert.ok(hasLine(none.stderr, /^no DID: give --did, or set DID_DOMAIN$/), none.stderr);
});

test("DID_LOG: a new revocation record carries it as its `log`", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-"], a.jwk), "first key");
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "second key");
  const tp = await thumbprintOf(a.jwk);
  const r = spawnSync(process.execPath,
    [SCRIPT, "--did", DID, "--site", site, "--out", docPath(site), "--emergency", "--revoke", tp, "--compromised-after", "2026-01-01T00:00:00Z"],
    { encoding: "utf8", cwd: REPO, env: { ...process.env, DID_LOG: "https://log.example.test/" } });
  ok(r, "revoke");
  assert.equal(JSON.parse(await readFile(recordPath(site, tp), "utf8")).log, "https://log.example.test/");
});

test("--did and --log take precedence over DID_DOMAIN and DID_LOG", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  const env = { ...process.env, DID_DOMAIN: "other.test", DID_LOG: "https://log.other.test/" };
  const gen = (args, jwk) => spawnSync(process.execPath, [SCRIPT, "--did", DID, "--site", site, "--out", docPath(site), ...args],
    { input: jwk ? JSON.stringify(jwk) : "", encoding: "utf8", cwd: REPO, env });
  ok(gen(["--from-private", "-"], a.jwk), "first key");
  ok(gen(["--from-private", "-", "--append"], b.jwk), "second key");
  assert.equal(JSON.parse(await readFile(docPath(site), "utf8")).id, DID);
  const tp = await thumbprintOf(a.jwk);
  ok(gen(["--emergency", "--revoke", tp, "--compromised-after", "2026-01-01T00:00:00Z", "--log", "https://log.example.test/"]), "revoke");
  assert.equal(JSON.parse(await readFile(recordPath(site, tp), "utf8")).log, "https://log.example.test/");
});

test("--append: a second key goes after the first, whose entries stay byte-identical", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-", "--also-key-name", "key-1"], a.jwk), "first key");
  const before = await readDoc(site);
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "append");
  const after = await readDoc(site);
  const tpB = await thumbprintOf(b.jwk);
  assert.deepEqual(after.verificationMethod.slice(0, 2), before.verificationMethod);
  assert.equal(after.verificationMethod.length, 3);
  assert.equal(after.verificationMethod[2].id, `${DID}#${tpB}`);
  assert.deepEqual(after.assertionMethod, after.verificationMethod.map((m) => m.id));
});

test("rebuilding from another key over an existing document is refused, and nothing is written", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-"], a.jwk), "first key");
  const before = await readFile(docPath(site), "utf8");
  const r = onSite(site, ["--from-private", "-"], b.jwk);
  assert.notEqual(r.status, 0);
  assert.ok(hasLine(r.stderr, /^FAULT .+: would be removed; use --append to add a key$/), r.stderr);
  assert.equal(await readFile(docPath(site), "utf8"), before);
});

test("--revoke: placeholder key, `revoked`, a self-certifying record; the old signature fails here and verifies there", async () => {
  const { revokedPlaceholder } = await import("./hash-to-curve.mjs");
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-", "--also-key-name", "key-1"], a.jwk), "first key");
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "second key");
  const tpA = await thumbprintOf(a.jwk);

  const data = Buffer.from("a credential signed before the compromise");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, a.pair.privateKey, data);

  ok(onSite(site, ["--emergency", "--revoke", tpA, "--compromised-after", "2026-01-01T00:00:00Z"]), "revoke");
  const doc = await readDoc(site);

  // Every entry of the key is revoked, with the placeholder; the other key is untouched.
  const ofA = doc.verificationMethod.filter((m) => m.id === `${DID}#${tpA}` || m.id === `${DID}#key-1`);
  assert.equal(ofA.length, 2);
  for (const m of ofA) {
    assert.deepEqual(m.publicKeyJwk, revokedPlaceholder(tpA));
    assert.match(m.revoked, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  }
  const tpB = await thumbprintOf(b.jwk);
  assert.ok(doc.verificationMethod.some((m) => m.id === `${DID}#${tpB}` && !("revoked" in m)));

  // The document announces its records, and maps the type to its documentation.
  assert.deepEqual(doc.service, [{
    id: `${DID}#revocations`, type: "KeyRevocationRecords", serviceEndpoint: `https://${DOMAIN}/revocations/`,
  }]);
  assert.ok(doc["@context"].includes("https://www.w3.org/ns/cid/v1"));
  assert.ok(doc["@context"].some((c) => typeof c === "object" &&
    c.KeyRevocationRecords === `https://${DOMAIN}/doc/keyrevocationrecords#KeyRevocationRecords`));

  // The record: the original key, whose thumbprint is its name.
  const record = JSON.parse(await readFile(recordPath(site, tpA), "utf8"));
  assert.equal(record.id, `${DID}#${tpA}`);
  assert.equal(await thumbprintOf(record.publicKeyJwk), tpA);
  assert.equal(record.revoked, ofA[0].revoked);
  assert.equal(record.compromisedAfter, "2026-01-01T00:00:00Z");
  assert.deepEqual(record.anchors, []);

  // A verifier that ignores `revoked` fails; the procedure's original key succeeds.
  const ecdsa = { name: "ECDSA", namedCurve: "P-256" };
  const placeholder = await crypto.subtle.importKey("jwk", ofA[0].publicKeyJwk, ecdsa, false, ["verify"]);
  const original = await crypto.subtle.importKey("jwk", record.publicKeyJwk, ecdsa, false, ["verify"]);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, placeholder, sig, data), false);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, original, sig, data), true);

  ok(verifyPrevious(site, site), "verify against itself");
});

test("--anchor: adds an anchor whose .ots commits to its root; another digest is refused", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-"], a.jwk), "first key");
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "second key");
  const tpA = await thumbprintOf(a.jwk);
  ok(onSite(site, ["--emergency", "--revoke", tpA, "--compromised-after", "2026-01-01T00:00:00Z"]), "revoke");

  const root = crypto.getRandomValues(new Uint8Array(32));
  const dir = await mkdtemp(join(tmpdir(), "did-ots-"));
  await writeFile(join(dir, "good.ots"), otsHeader(Buffer.from(root)));
  await writeFile(join(dir, "bad.ots"), otsHeader(Buffer.alloc(32, 7)));
  const rootB64 = Buffer.from(root).toString("base64url");

  const bad = onSite(site, ["--anchor", tpA, "--tree-size", "42", "--root", rootB64, "--ots", join(dir, "bad.ots")]);
  assert.notEqual(bad.status, 0);
  assert.ok(hasLine(bad.stderr, /^FAULT .+\.ots commits to .+, not to the root .+$/), bad.stderr);

  ok(onSite(site, ["--anchor", tpA, "--tree-size", "42", "--root", rootB64, "--ots", join(dir, "good.ots")]), "anchor");
  const record = JSON.parse(await readFile(recordPath(site, tpA), "utf8"));
  assert.deepEqual(record.anchors, [{ treeSize: 42, rootHash: rootB64, ots: `${tpA}/42.ots` }]);
  assert.deepEqual(await readFile(join(site, "revocations", tpA, "42.ots")), await readFile(join(dir, "good.ots")));
});

test("--verify-file --previous: extensions pass; a removed or altered entry, or a later compromisedAfter, fails", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey(), c = await freshKey();
  ok(onSite(site, ["--from-private", "-"], a.jwk), "first key");
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "second key");
  const tpA = await thumbprintOf(a.jwk);
  const v1 = await copySite(site);

  // An appended key and a valid revocation both extend v1.
  ok(onSite(site, ["--from-private", "-", "--append"], c.jwk), "third key");
  ok(verifyPrevious(site, v1), "append");
  ok(onSite(site, ["--emergency", "--revoke", tpA, "--compromised-after", "2026-01-01T00:00:00Z"]), "revoke");
  ok(verifyPrevious(site, v1), "revocation");
  const v2 = await copySite(site);

  // compromisedAfter may move earlier, never later.
  ok(onSite(site, ["--revoke-update", tpA, "--compromised-after", "2025-12-01T00:00:00Z"]), "earlier");
  ok(verifyPrevious(site, v2), "earlier compromisedAfter");
  const later = await copySite(site);
  const rec = JSON.parse(await readFile(recordPath(later, tpA), "utf8"));
  rec.compromisedAfter = "2026-02-01T00:00:00Z";
  await writeFile(recordPath(later, tpA), JSON.stringify(rec, null, 2) + "\n");
  const r1 = verifyPrevious(later, v2);
  assert.notEqual(r1.status, 0);
  assert.ok(hasLine(r1.stderr, /^FAULT .+: compromisedAfter moved later .+$/), r1.stderr);

  // A removed entry, and an entry whose key changed, fail.
  const tpB = await thumbprintOf(b.jwk), tpC = await thumbprintOf(c.jwk);
  const removed = await copySite(v2);
  const d1 = await readDoc(removed);
  d1.verificationMethod = d1.verificationMethod.filter((m) => !m.id.endsWith(tpB));
  d1.assertionMethod = d1.verificationMethod.map((m) => m.id);
  await writeFile(docPath(removed), JSON.stringify(d1, null, 2) + "\n");
  const r2 = verifyPrevious(removed, v2);
  assert.notEqual(r2.status, 0);
  assert.ok(hasLine(r2.stderr, /^FAULT .+: removed since the previous state$/), r2.stderr);

  const altered = await copySite(v2);
  const d2 = await readDoc(altered);
  const target = d2.verificationMethod.find((m) => m.id.endsWith(tpC));
  target.controller = "did:web:elsewhere.test";
  await writeFile(docPath(altered), JSON.stringify(d2, null, 2) + "\n");
  const r3 = verifyPrevious(altered, v2);
  assert.notEqual(r3.status, 0);
  assert.ok(hasLine(r3.stderr, /^FAULT .+: changed since the previous state$/), r3.stderr);
});

test("--normalize: the CID context, the documentation term and the service entry; no entry changes", async () => {
  const site = await newSite();
  const { jwk } = await freshKey();
  // An old-form document, as published before revocation existed.
  ok(onSite(site, ["--from-private", "-"], jwk), "first key");
  const doc = await readDoc(site);
  doc["@context"] = ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/jwk/v1"];
  delete doc.service;
  await writeFile(docPath(site), JSON.stringify(doc, null, 2) + "\n");
  const old = await copySite(site);

  ok(onSite(site, ["--normalize"]), "normalize");
  const after = await readDoc(site);
  assert.deepEqual(after.verificationMethod, doc.verificationMethod);
  assert.deepEqual(after.assertionMethod, doc.assertionMethod);
  assert.ok(after["@context"].includes("https://www.w3.org/ns/cid/v1"));
  assert.equal(after.service[0].type, "KeyRevocationRecords");
  ok(verifyPrevious(site, old), "normalized extends the old form");
});

// --- authentication: a temporary copy of assertionMethod (#21) --------------------
//
// Until #16, the tool publishes the entries of assertionMethod under
// `authentication` too, the same identifiers in the same order, and
// --verify-file refuses any other list. Revocation is disabled unless
// --emergency is given.

const AUTH_FAULT = /^FAULT authentication differs from assertionMethod \(a temporary copy until #16\)$/;

test("creation: authentication is a copy of assertionMethod, with one entry or two", async () => {
  const { jwk } = await freshKey();
  const one = await scratch();
  make(jwk, one);
  const d1 = JSON.parse(await readFile(one, "utf8"));
  assert.deepEqual(d1.authentication, d1.assertionMethod);
  assert.deepEqual(d1.authentication, [`${DID}#${await thumbprintOf(jwk)}`]);

  const two = await scratch();
  make(jwk, two, ["--also-key-name", "key-1"]);
  const d2 = JSON.parse(await readFile(two, "utf8"));
  assert.deepEqual(d2.authentication, d2.assertionMethod);
  assert.equal(d2.authentication.length, 2);
  // The list goes right after assertionMethod.
  const keys = Object.keys(d2);
  assert.equal(keys.indexOf("authentication"), keys.indexOf("assertionMethod") + 1);
  assert.equal(verify(two).status, 0);
});

test("rotation: --append adds the new key to authentication, after the first", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-", "--also-key-name", "key-1"], a.jwk), "first key");
  const before = await readDoc(site);
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "append");
  const after = await readDoc(site);
  assert.deepEqual(after.authentication, after.assertionMethod);
  assert.deepEqual(after.authentication.slice(0, 2), before.assertionMethod);
  assert.equal(after.authentication[2], `${DID}#${await thumbprintOf(b.jwk)}`);
  ok(verifyPrevious(site, site), "verify");
});

test("rollout: --normalize adds authentication to a document without it, which it extends", async () => {
  const site = await newSite();
  const { jwk } = await freshKey();
  ok(onSite(site, ["--from-private", "-", "--also-key-name", "key-1"], jwk), "first key");
  // The form published before #21: no authentication list.
  const doc = await readDoc(site);
  delete doc.authentication;
  await writeFile(docPath(site), JSON.stringify(doc, null, 2) + "\n");
  ok(verifyPrevious(site, site), "a document without the list is accepted");
  const old = await copySite(site);

  ok(onSite(site, ["--normalize"]), "normalize");
  const after = await readDoc(site);
  assert.deepEqual(after.authentication, doc.assertionMethod);
  assert.deepEqual(after.verificationMethod, doc.verificationMethod);
  ok(verifyPrevious(site, old), "the normalized document extends the old form");
  const again = ok(onSite(site, ["--normalize"]), "normalize again");
  assert.ok(hasLine(again.stderr, /^unchanged .+did\.json$/), again.stderr);
});

test("--revoke without --emergency is refused, and nothing is written", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-"], a.jwk), "first key");
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "second key");
  const tpA = await thumbprintOf(a.jwk);
  const before = await readFile(docPath(site), "utf8");
  const r = onSite(site, ["--revoke", tpA, "--compromised-after", "2026-01-01T00:00:00Z"]);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(hasLine(r.stderr, /^FAULT --revoke is disabled until #16 \(authentication keys\); --emergency revokes anyway$/), r.stderr);
  assert.equal(await readFile(docPath(site), "utf8"), before, "document unchanged");
  await assert.rejects(readFile(recordPath(site, tpA)), { code: "ENOENT" }, "no record written");
});

test("--revoke --emergency revokes; the revoked entries stay in both lists", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-", "--also-key-name", "key-1"], a.jwk), "first key");
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "second key");
  const tpA = await thumbprintOf(a.jwk);
  const v1 = await copySite(site);
  ok(onSite(site, ["--revoke", tpA, "--compromised-after", "2026-01-01T00:00:00Z", "--emergency"]), "emergency revoke");
  const doc = await readDoc(site);
  assert.ok(doc.verificationMethod.filter((m) => "revoked" in m).length === 2);
  assert.deepEqual(doc.authentication, doc.assertionMethod);
  assert.ok(doc.authentication.includes(`${DID}#${tpA}`) && doc.authentication.includes(`${DID}#key-1`));
  await readFile(recordPath(site, tpA)); // the record exists
  ok(verifyPrevious(site, v1), "the revocation extends the previous state");
});

test("--verify-file refuses an authentication list that is not exactly assertionMethod; no list is accepted", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-", "--also-key-name", "key-1"], a.jwk), "first key");
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "second key");
  const base = await readDoc(site);
  const am = base.assertionMethod; // [#tpA, #key-1, #tpB]
  const tpA = await thumbprintOf(a.jwk);
  const flip = (s) => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
  const cases = {
    "an entry missing": am.slice(1),
    "an entry added": [...am, `${DID}#key-2`],
    "an entry twice": [...am, am[0]],
    "the order swapped": [am[1], am[0], am[2]],
    "#key-10 for #key-1": am.map((id) => id === `${DID}#key-1` ? `${DID}#key-10` : id),
    "a thumbprint with one character changed": am.map((id) => id === `${DID}#${tpA}` ? `${DID}#${flip(tpA)}` : id),
    "a trailing space": am.map((id, i) => i === 0 ? `${id} ` : id),
    "another domain": am.map((id) => id.replace(DID, `${DID}.example`)),
    "a relative reference": am.map((id) => id.slice(DID.length)),
    "an embedded method object": am.map((id, i) => i === 0 ? base.verificationMethod.find((m) => m.id === id) : id),
    "a different case": am.map((id) => id.replace(DID, DID.toUpperCase())),
    "an empty list": [],
  };
  for (const [what, list] of Object.entries(cases)) {
    const s = await copySite(site);
    await writeFile(docPath(s), JSON.stringify({ ...base, authentication: list }, null, 2) + "\n");
    const r = verify(docPath(s));
    assert.equal(r.status, 1, `${what}: ${r.stderr}`);
    assert.ok(hasLine(r.stderr, AUTH_FAULT), `${what}: ${r.stderr}`);
  }

  const none = await copySite(site);
  const { authentication, ...without } = base;
  await writeFile(docPath(none), JSON.stringify(without, null, 2) + "\n");
  ok(verify(docPath(none)), "no list");
});

// Edge cases of #21.

test("--revoke without --emergency, with a key to --append: refused, and nothing written", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-"], a.jwk), "first key");
  const tpA = await thumbprintOf(a.jwk);
  const before = await readFile(docPath(site), "utf8");
  const r = onSite(site, ["--from-private", "-", "--append", "--revoke", tpA, "--compromised-after", "2026-01-01T00:00:00Z"], b.jwk);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(lines(r.stderr.trimEnd()), ["FAULT --revoke is disabled until #16 (authentication keys); --emergency revokes anyway"]);
  assert.equal(await readFile(docPath(site), "utf8"), before, "document unchanged: the key was not appended either");
  await assert.rejects(readFile(recordPath(site, tpA)), { code: "ENOENT" }, "no record written");
});

test("--revoke --emergency with a key to --append: the new key joins both lists, in one change", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-"], a.jwk), "first key");
  const tpA = await thumbprintOf(a.jwk), tpB = await thumbprintOf(b.jwk);
  const v1 = await copySite(site);
  ok(onSite(site, ["--from-private", "-", "--append", "--emergency", "--revoke", tpA, "--compromised-after", "2026-01-01T00:00:00Z"], b.jwk), "append and revoke");
  const doc = await readDoc(site);
  assert.deepEqual(doc.assertionMethod, [`${DID}#${tpA}`, `${DID}#${tpB}`]);
  assert.deepEqual(doc.authentication, doc.assertionMethod);
  assert.ok("revoked" in doc.verificationMethod[0] && !("revoked" in doc.verificationMethod[1]));
  const v = ok(verifyPrevious(site, v1), "the change extends the previous state");
  assert.ok(!hasLine(v.stderr, /^FAULT /), v.stderr);
});

test("--emergency alone is not an operation: a usage error, nothing written", async () => {
  const site = await newSite();
  const { jwk } = await freshKey();
  ok(onSite(site, ["--from-private", "-"], jwk), "first key");
  const before = await readFile(docPath(site), "utf8");
  const r = onSite(site, ["--emergency"]);
  assert.equal(r.status, 2, r.stderr);
  assert.ok(hasLine(r.stderr, /^one of --new, --from-private, .+ is required$/), r.stderr);
  assert.equal(await readFile(docPath(site), "utf8"), before);
});

test("--from-private --check: the key is found, and nothing is written, with the list present", async () => {
  const site = await newSite();
  const { jwk } = await freshKey();
  ok(onSite(site, ["--from-private", "-"], jwk), "first key");
  const before = await readFile(docPath(site), "utf8");
  assert.ok("authentication" in JSON.parse(before));
  const r = ok(onSite(site, ["--from-private", "-", "--check"], jwk), "check");
  assert.deepEqual(lines(r.stderr.trimEnd()), [`OK ${docPath(site)} carries the key supplied`]);
  assert.equal(await readFile(docPath(site), "utf8"), before);
});

test("--verify-file refuses an authentication list in a document without assertionMethod", async () => {
  const site = await newSite();
  const { jwk } = await freshKey();
  ok(onSite(site, ["--from-private", "-"], jwk), "first key");
  const { assertionMethod, ...doc } = await readDoc(site);
  await writeFile(docPath(site), JSON.stringify(doc, null, 2) + "\n");
  const r = verify(docPath(site));
  assert.equal(r.status, 1, r.stderr);
  assert.ok(hasLine(r.stderr, AUTH_FAULT), r.stderr);
});

// --- edge cases -----------------------------------------------------------------

/** A site with keys a (also #key-1) and b, a revoked; returns the pieces. */
async function revokedSite() {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-", "--also-key-name", "key-1"], a.jwk), "first key");
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "second key");
  const tpA = await thumbprintOf(a.jwk), tpB = await thumbprintOf(b.jwk);
  ok(onSite(site, ["--emergency", "--revoke", tpA, "--compromised-after", "2026-01-01T00:00:00Z"]), "revoke");
  return { site, a, b, tpA, tpB };
}

test("--append twice with the same key changes nothing", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-"], a.jwk), "first key");
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "append");
  const before = await readFile(docPath(site), "utf8");
  const r = ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "append again");
  assert.ok(hasLine(r.stderr, /^unchanged .+did\.json$/), r.stderr);
  assert.equal(await readFile(docPath(site), "utf8"), before);
});

test("a logical name designates one key for good; `next` takes the next free key-<n>", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey(), c = await freshKey();
  ok(onSite(site, ["--from-private", "-", "--also-key-name", "key-1"], a.jwk), "first key");
  const taken = onSite(site, ["--from-private", "-", "--append", "--also-key-name", "key-1"], b.jwk);
  assert.notEqual(taken.status, 0);
  assert.ok(hasLine(taken.stderr, /^FAULT .+#key-1: already designates another key$/), taken.stderr);
  ok(onSite(site, ["--from-private", "-", "--append", "--also-key-name", "next"], b.jwk), "next");
  ok(onSite(site, ["--from-private", "-", "--append", "--also-key-name", "next"], c.jwk), "next again");
  const ids = (await readDoc(site)).verificationMethod.map((m) => m.id.split("#")[1]);
  assert.deepEqual(ids.filter((f) => f.startsWith("key-")), ["key-1", "key-2", "key-3"]);
});

test("--revoke refuses an unknown thumbprint, and a key already revoked", async () => {
  const s = await revokedSite();
  const unknown = onSite(s.site, ["--emergency", "--revoke", "A".repeat(43), "--compromised-after", "2026-01-01T00:00:00Z"]);
  assert.notEqual(unknown.status, 0);
  assert.ok(hasLine(unknown.stderr, /^FAULT A{43}: no entry with this thumbprint$/), unknown.stderr);
  const again = onSite(s.site, ["--emergency", "--revoke", s.tpA, "--compromised-after", "2026-01-01T00:00:00Z"]);
  assert.notEqual(again.status, 0);
  assert.ok(hasLine(again.stderr, /^FAULT .+: already revoked$/), again.stderr);
});

test("--compromised-after: required, a UTC dateTimeStamp, not after the revocation", async () => {
  const site = await newSite();
  const a = await freshKey(), b = await freshKey();
  ok(onSite(site, ["--from-private", "-"], a.jwk), "first key");
  ok(onSite(site, ["--from-private", "-", "--append"], b.jwk), "second key");
  const tpA = await thumbprintOf(a.jwk);
  const before = await readFile(docPath(site), "utf8");
  for (const [args, re] of [
    [[], /^FAULT --compromised-after <dateTimeStamp> is required: .+$/],
    [["--compromised-after", "2026-01-01"], /^FAULT --compromised-after 2026-01-01: not a UTC dateTimeStamp$/],
    [["--compromised-after", "2999-01-01T00:00:00Z"], /^FAULT --compromised-after 2999-01-01T00:00:00Z: after the revocation .+$/],
  ]) {
    const r = onSite(site, ["--emergency", "--revoke", tpA, ...args]);
    assert.notEqual(r.status, 0);
    assert.ok(hasLine(r.stderr, re), r.stderr);
  }
  assert.equal(await readFile(docPath(site), "utf8"), before, "nothing written");
});

test("revoking the last active key succeeds, with a warning; the document still verifies", async () => {
  const site = await newSite();
  const { jwk } = await freshKey();
  ok(onSite(site, ["--from-private", "-"], jwk), "only key");
  const r = ok(onSite(site, ["--emergency", "--revoke", await thumbprintOf(jwk), "--compromised-after", "2026-01-01T00:00:00Z"]), "revoke");
  assert.ok(hasLine(r.stderr, /^WARNING did:web:example\.test: no active key remains; .+$/), r.stderr);
  const v = ok(verifyPrevious(site, site), "verify");
  assert.ok(hasLine(v.stderr, /^WARNING did:web:example\.test: no active key; .+$/), v.stderr);
});

test("a revoked key is never published again", async () => {
  const s = await revokedSite();
  const r = onSite(s.site, ["--from-private", "-", "--append"], s.a.jwk);
  assert.notEqual(r.status, 0);
  assert.ok(hasLine(r.stderr, /^FAULT .+: revoked; a revoked key is never published again$/), r.stderr);
});

test("--check reports a revoked key as revoked", async () => {
  const s = await revokedSite();
  const r = onSite(s.site, ["--from-private", "-", "--check"], s.a.jwk);
  assert.notEqual(r.status, 0);
  assert.ok(hasLine(r.stderr, /^FAULT .+ carries the key supplied as revoked$/), r.stderr);
});

test("--revoke-update refuses to move compromisedAfter later", async () => {
  const s = await revokedSite();
  const r = onSite(s.site, ["--revoke-update", s.tpA, "--compromised-after", "2026-02-01T00:00:00Z"]);
  assert.notEqual(r.status, 0);
  assert.ok(hasLine(r.stderr, /^FAULT .+: compromisedAfter moved later .+; it may only move earlier$/), r.stderr);
});

test("--anchor: the same anchor twice changes nothing; other values for its tree size are refused; a .tsr is kept", async () => {
  const s = await revokedSite();
  const dir = await mkdtemp(join(tmpdir(), "did-ots-"));
  const root = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  await writeFile(join(dir, "a.ots"), otsHeader(root));
  await writeFile(join(dir, "a.tsr"), Buffer.from("token"));
  const args = ["--anchor", s.tpA, "--tree-size", "7", "--root", root.toString("base64url"), "--ots", join(dir, "a.ots")];
  ok(onSite(s.site, [...args, "--tsr", join(dir, "a.tsr")]), "anchor");
  const r = ok(onSite(s.site, [...args, "--tsr", join(dir, "a.tsr")]), "again");
  assert.ok(hasLine(r.stderr, /^unchanged .+\.json$/), r.stderr);
  const other = Buffer.alloc(32, 9);
  await writeFile(join(dir, "b.ots"), otsHeader(other));
  const clash = onSite(s.site, ["--anchor", s.tpA, "--tree-size", "7", "--root", other.toString("base64url"), "--ots", join(dir, "b.ots")]);
  assert.notEqual(clash.status, 0);
  assert.ok(hasLine(clash.stderr, /^FAULT .+: anchor 7 is already listed with other values$/), clash.stderr);
  const record = JSON.parse(await readFile(recordPath(s.site, s.tpA), "utf8"));
  assert.deepEqual(record.anchors, [{ treeSize: 7, rootHash: root.toString("base64url"), ots: `${s.tpA}/7.ots`, tsr: `${s.tpA}/7.tsr` }]);
});

test("--verify-file: a revoked entry with another key, or a record whose key is not its name, is refused", async () => {
  const s = await revokedSite();
  const wrong = await copySite(s.site);
  const d = await readDoc(wrong);
  const entry = d.verificationMethod.find((m) => m.id.endsWith("#key-1"));
  entry.publicKeyJwk = { crv: "P-256", kty: "EC", x: s.b.jwk.x, y: s.b.jwk.y };
  await writeFile(docPath(wrong), JSON.stringify(d, null, 2) + "\n");
  const r1 = verifyPrevious(wrong, wrong);
  assert.notEqual(r1.status, 0);
  assert.ok(hasLine(r1.stderr, /^FAULT .+#key-1: revoked, but its key is not the placeholder of a revoked thumbprint$/), r1.stderr);

  const forged = await copySite(s.site);
  const rec = JSON.parse(await readFile(recordPath(forged, s.tpA), "utf8"));
  rec.publicKeyJwk = { crv: "P-256", kty: "EC", x: s.b.jwk.x, y: s.b.jwk.y };
  await writeFile(recordPath(forged, s.tpA), JSON.stringify(rec, null, 2) + "\n");
  const r2 = verifyPrevious(forged, forged);
  assert.notEqual(r2.status, 0);
  assert.ok(hasLine(r2.stderr, /^FAULT .+: the record's key does not hash to its name$/), r2.stderr);
});

test("--previous: an .ots upgraded on the same digest passes; another digest fails", async () => {
  const s = await revokedSite();
  const dir = await mkdtemp(join(tmpdir(), "did-ots-"));
  const root = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  await writeFile(join(dir, "p.ots"), otsHeader(root));
  ok(onSite(s.site, ["--anchor", s.tpA, "--tree-size", "5", "--root", root.toString("base64url"), "--ots", join(dir, "p.ots")]), "anchor");
  const v1 = await copySite(s.site);
  // Upgraded: same header, an attestation appended.
  await writeFile(join(s.site, "revocations", s.tpA, "5.ots"), Buffer.concat([otsHeader(root), Buffer.from([0x00, 0x05])]));
  ok(verifyPrevious(s.site, v1), "upgraded");
  await writeFile(join(s.site, "revocations", s.tpA, "5.ots"), otsHeader(Buffer.alloc(32, 1)));
  const r = verifyPrevious(s.site, v1);
  assert.notEqual(r.status, 0);
  assert.ok(hasLine(r.stderr, /^FAULT .+: anchor 5 removed or changed since the previous state$/), r.stderr);
});

test("the records' endpoint may move, if every record follows; a lost record or a later compromisedAfter fails", async () => {
  const s = await revokedSite();
  const v1 = await copySite(s.site);
  const move = async (site) => {
    const d = await readDoc(site);
    d.service[0].serviceEndpoint = "https://example.test/did/v2/revocations/";
    await writeFile(docPath(site), JSON.stringify(d, null, 2) + "\n");
    await mkdir(join(site, "did", "v2"), { recursive: true });
    await cp(join(site, "revocations"), join(site, "did", "v2", "revocations"), { recursive: true });
    await rm(join(site, "revocations"), { recursive: true });
  };
  const moved = await copySite(s.site);
  await move(moved);
  ok(verifyPrevious(moved, v1), "moved with its records");

  const lost = await copySite(s.site);
  await move(lost);
  await rm(join(lost, "did", "v2", "revocations", `${s.tpA}.json`));
  const r1 = verifyPrevious(lost, v1);
  assert.notEqual(r1.status, 0);
  assert.ok(hasLine(r1.stderr, /^FAULT .+: revoked, but no record at .+$/), r1.stderr);

  const later = await copySite(s.site);
  await move(later);
  const path = join(later, "did", "v2", "revocations", `${s.tpA}.json`);
  const rec = JSON.parse(await readFile(path, "utf8"));
  rec.compromisedAfter = "2026-02-01T00:00:00Z";
  await writeFile(path, JSON.stringify(rec, null, 2) + "\n");
  const r2 = verifyPrevious(later, v1);
  assert.notEqual(r2.status, 0);
  assert.ok(hasLine(r2.stderr, /^FAULT .+: compromisedAfter moved later .+$/), r2.stderr);
});

// --- Change History -------------------------------------------------------
// | PR     | Summary                                                       |
// |--------|---------------------------------------------------------------|
// | #10    | DID_DOMAIN and DID_LOG replace --config (#8)                  |
// | #22    | authentication copied, --revoke behind --emergency (#21)      |
