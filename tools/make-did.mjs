#!/usr/bin/env node
// Produces, extends, revokes and checks a did:web DID document. The DID comes
// from did.config.json at the repository root (or --config, or --did); no
// site is named in this code.
//
// WHY A SCRIPT AND NOT A HAND-WRITTEN FILE. The published document and the key
// loaded by the signing service must designate the same thing, and nothing in
// a copied JSON file guarantees it. Here both descend from the same key pair:
// the fragment is the key's RFC 7638 thumbprint, so both sides agree without
// talking to each other.
//
// THE SECRET NEVER TOUCHES THE DISK. `--new` writes the private key to stdout
// and nothing else. This script writes only PUBLIC key material to disk.
//
// NO KEY ENTRY EVER DISAPPEARS. Removing a key would make every credential it
// ever signed unverifiable, and indistinguishable from a forgery. A rotation
// appends; a compromised key is REVOKED: its entries stay, marked `revoked`,
// with a placeholder key nobody can sign for, and the original key moves to a
// revocation record. Any other change to an existing entry is refused. The
// format is defined on /doc/keyrevocationrecords of the DID's own site.
//
// Usage (document: --out <file>, default public/.well-known/did.json; site
// root: --site <dir>, default public — records live where the document's
// `service` entry says):
//   --new [--append]
//       creates a P-256 pair, emits the private JWK on stdout, writes the document.
//   --from-private <file|-> [--append]
//       builds the document from an existing key. Without --append, refused if
//       the document exists and would lose or change an entry. With --append,
//       adds the key after the existing entries; a key already present changes
//       nothing.
//   --from-private <file|-> --check
//       writes nothing; exits 1 if the document on disk does not carry the key.
//   --revoke <thumbprint> --compromised-after <dateTimeStamp>
//       revokes every entry of the key and writes its revocation record, as one
//       change. Allowed on the last active key. Combinable with a key to --append.
//   --revoke-update <thumbprint> --compromised-after <dateTimeStamp>
//       moves a record's compromisedAfter EARLIER; never later.
//   --anchor <thumbprint> --tree-size <n> --root <base64url> --ots <file> [--tsr <file>]
//       adds an anchor of the issuance log to a record, with its proof files.
//   --normalize
//       brings @context and the `service` entry to the current form; refused
//       if any entry would change.
//   --verify-file <file> [--previous <site-dir>]
//       consistency check WITHOUT any secret: the check the deploy-time build
//       runs. With --previous, also refuses anything that does not extend the
//       earlier state found in <site-dir> (document and records).
//
// Options:
//   --config <file>        default did.config.json at the repository root
//   --did <did>            overrides the config
//   --also-key-name <n>    ALSO publishes the key under the fragment #<n>;
//                          `next` takes the next free key-<n>. A name
//                          designates one key for good.

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
// stdin is read through node:stream/consumers: the promise flavour of fs does
// not accept a numeric file descriptor, and `--from-private -` is the
// publication path that keeps the secret off the disk.
import { text as readStdin } from "node:stream/consumers";
import { webcrypto as crypto } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revokedPlaceholder } from "./hash-to-curve.mjs";
import { otsDigest } from "./ots-header.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = join(REPO, "did.config.json");
const DEFAULT_SITE = "public";
const DOCUMENT = join(".well-known", "did.json");
const SERVICE_TYPE = "KeyRevocationRecords";
// A dateTimeStamp in UTC, as `revoked` and `compromisedAfter` are written.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The four required members of an EC key, and nothing else: RFC 7638 §3.2. */
const requiredMembers = (jwk) => ({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });

/**
 * JWK thumbprint, RFC 7638: SHA-256 of the JSON serialisation of the required
 * members, in lexicographic order, without whitespace, then base64url.
 * The order is imposed explicitly rather than left to insertion order.
 */
async function thumbprint(publicJwk) {
  const m = requiredMembers(publicJwk);
  const canonical = JSON.stringify(m, Object.keys(m).sort());
  const digest = await crypto.subtle.digest("SHA-256", Buffer.from(canonical, "utf8"));
  return b64url(new Uint8Array(digest));
}

async function publicFromPrivate(privateJwk) {
  // Import then export: fields are not copied by hand, and a malformed JWK is
  // refused here rather than discovered at signing time.
  const key = await crypto.subtle.importKey(
    "jwk", { ...privateJwk, key_ops: ["sign"], ext: true },
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  if (key.algorithm.namedCurve !== "P-256") throw new Error("the key is not on P-256");
  return requiredMembers({ crv: privateJwk.crv, kty: privateJwk.kty, x: privateJwk.x, y: privateJwk.y });
}

// --- the DID, its site, and the current form of its document ------------------

/** The host of a did:web, which also serves its records and documentation. */
function domainOf(did) {
  const m = /^did:web:([^:]+)/.exec(did);
  if (!m) throw new Error(`not a did:web: ${did}`);
  return decodeURIComponent(m[1]);
}

/**
 * The context verifiers expect for JsonWebKey methods, plus the Controlled
 * Identifiers context that defines `revoked`, and the term that maps the
 * service type to its documentation on the DID's own site.
 */
const contextFor = (did) => [
  "https://www.w3.org/ns/did/v1",
  "https://w3id.org/security/jwk/v1",
  "https://www.w3.org/ns/cid/v1",
  { [SERVICE_TYPE]: `https://${domainOf(did)}/doc/${SERVICE_TYPE.toLowerCase()}#${SERVICE_TYPE}` },
];

const defaultService = (did) =>
  ({ id: `${did}#revocations`, type: SERVICE_TYPE, serviceEndpoint: `https://${domainOf(did)}/revocations/` });

/**
 * A document in the current form, keeping the given entries as they are. An
 * existing revocation service is kept, so that its endpoint may move only on
 * purpose.
 */
function normalised(did, methods, assertion, service) {
  const kept = (service ?? []).filter((s) => s.type === SERVICE_TYPE);
  return {
    "@context": contextFor(did),
    id: did,
    verificationMethod: methods,
    // `assertionMethod`, not `authentication`: these keys attest, they do not
    // open sessions.
    assertionMethod: assertion,
    service: kept.length ? service : [...(service ?? []), defaultService(did)],
  };
}

const serialise = (doc) => JSON.stringify(doc, null, 2) + "\n";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function method(did, fragment, publicJwk) {
  return { id: `${did}#${fragment}`, type: "JsonWebKey", controller: did, publicKeyJwk: publicJwk };
}

/** Where the records of `doc` live inside `site`: the path of its service endpoint. */
function recordsDir(site, doc, did) {
  const service = (doc?.service ?? []).find((s) => s.type === SERVICE_TYPE) ?? defaultService(did);
  return join(site, new URL(service.serviceEndpoint).pathname);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${path}: ${e.message}`);
  }
}

const fragmentOf = (m) => String(m.id).split("#")[1];
const looksLikeThumbprint = (f) => /^[A-Za-z0-9_-]{43}$/.test(f ?? "");
const nowStamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

class Faults {
  constructor() { this.list = []; }
  add(text) { this.list.push(text); }
  get any() { return this.list.length > 0; }
  /** Prints every fault and exits 1, if there is any. */
  exitIfAny() {
    if (!this.any) return;
    this.list.forEach((f) => console.error(`FAULT ${f}`));
    process.exit(1);
  }
}

// --- consistency of one state ---------------------------------------------------

/**
 * Internal consistency of a DID document and of its revocation records,
 * without any secret.
 *
 * What this really catches: a hand-edited document whose fragment no longer
 * matches the key it carries — that is, a credential signed under an
 * identifier the document does not announce, hence unverifiable, and
 * unverifiable SILENTLY; a revoked entry whose placeholder or record is not
 * exactly what revocation produces. What it does not catch: a perfectly
 * consistent document built on a key nobody holds. Only `--check` with the
 * private key says that.
 */
async function checkState(site, docFile, did, faults) {
  const doc = await readJson(docFile);
  if (!doc) { faults.add(`${docFile} is missing`); return null; }
  if (doc.id !== did) faults.add(`id is ${doc.id}, expected ${did}`);
  if (!same(doc["@context"], contextFor(did))) faults.add("@context differs from the expected one");
  if (!(doc.service ?? []).some((s) => s.type === SERVICE_TYPE))
    faults.add(`no service of type ${SERVICE_TYPE}`);
  const methods = doc.verificationMethod ?? [];
  if (methods.length === 0) faults.add("no verificationMethod");
  const dir = recordsDir(site, doc, did);
  const records = new Map(); // thumbprint → record, for the revoked keys
  let active = 0, activeByThumbprint = 0;

  for (const m of methods) {
    const jwk = m.publicKeyJwk ?? {};
    if ("d" in jwk) faults.add(`${m.id}: PRIVATE KEY PUBLISHED, member "d" present`);
    if (m.controller !== did) faults.add(`${m.id}: controller is ${m.controller}`);
    const fragment = fragmentOf(m);
    if ("revoked" in m) {
      if (!DATE_TIME.test(m.revoked ?? "")) faults.add(`${m.id}: revoked is not a UTC dateTimeStamp`);
      continue; // checked below, against the records
    }
    active++;
    const tp = await thumbprint(jwk);
    // TWO FRAGMENT FORMS ARE LEGITIMATE, AND THEY MUST BE TOLD APART.
    //
    // A logical name — `key-1` — is accepted: it is the --also-key-name
    // variant. A thumbprint is accepted if it is RIGHT.
    //
    // What cannot pass is a fragment that has the SHAPE of a thumbprint without
    // being one: 43 base64url characters, i.e. a SHA-256 digest, that does not
    // match the key it accompanies. A reader would take it for a verified
    // thumbprint and not recompute it. That is exactly what a hand edit of the
    // document produces.
    if (looksLikeThumbprint(fragment) && fragment !== tp)
      faults.add(`${m.id}: thumbprint-shaped fragment, but the key gives ${tp}`);
    if (!looksLikeThumbprint(fragment)) console.error(`note ${m.id}: named fragment, thumbprint ${tp}`);
    if (fragment === tp) activeByThumbprint++;
  }

  // Revoked entries: the record of each revoked thumbprint, and the exact
  // placeholder of its key on every entry that carried it.
  for (const m of methods.filter((m) => "revoked" in m && looksLikeThumbprint(fragmentOf(m)))) {
    const tp = fragmentOf(m);
    const record = await readJson(join(dir, `${tp}.json`));
    if (!record) { faults.add(`${m.id}: revoked, but no record at ${join(dir, `${tp}.json`)}`); continue; }
    records.set(tp, record);
    await checkRecord(dir, tp, record, did, faults);
    if (record.revoked !== m.revoked) faults.add(`${m.id}: revoked differs from its record`);
  }
  for (const m of methods.filter((m) => "revoked" in m)) {
    const owner = [...records.keys()].find((tp) => same(m.publicKeyJwk, revokedPlaceholder(tp)));
    if (!owner) faults.add(`${m.id}: revoked, but its key is not the placeholder of a revoked thumbprint`);
    else if (records.get(owner).revoked !== m.revoked) faults.add(`${m.id}: revoked differs from its record`);
  }

  // At least one active entry must be addressable by thumbprint. Without it, a
  // signer that derives its fragment from its key has nothing to hold on to.
  // No active key at all is legitimate (the last key was just revoked), but
  // nothing can be signed until a key is appended.
  if (active === 0 && methods.length) console.error(`WARNING ${did}: no active key; nothing verifies until a key is appended`);
  else if (active && !activeByThumbprint) faults.add("no key published under its RFC 7638 thumbprint");

  const ids = methods.map((m) => m.id);
  for (const a of doc.assertionMethod ?? [])
    if (!ids.includes(a)) faults.add(`assertionMethod ${a} has no verificationMethod`);
  return { doc, dir, records };
}

async function checkRecord(dir, tp, record, did, faults) {
  if (record.id !== `${did}#${tp}`) faults.add(`${tp}: record id is ${record.id}`);
  if (await thumbprint(record.publicKeyJwk ?? {}) !== tp) faults.add(`${tp}: the record's key does not hash to its name`);
  if (!DATE_TIME.test(record.compromisedAfter ?? "")) faults.add(`${tp}: compromisedAfter is not a UTC dateTimeStamp`);
  else if (Date.parse(record.compromisedAfter) > Date.parse(record.revoked)) faults.add(`${tp}: compromisedAfter is after revoked`);
  for (const a of record.anchors ?? []) {
    try {
      const digest = otsDigest(await readFile(join(dir, a.ots)));
      if (b64url(digest) !== a.rootHash) faults.add(`${join(dir, a.ots)} commits to ${b64url(digest)}, not to the root ${a.rootHash}`);
    } catch (e) { faults.add(`${tp}: anchor ${a.treeSize}: ${a.ots}: ${e.code === "ENOENT" ? "missing" : e.message}`); }
    if (a.tsr) await readFile(join(dir, a.tsr)).catch(() => faults.add(`${tp}: anchor ${a.treeSize}: ${a.tsr} missing`));
  }
}

// --- what may change from one state to the next ---------------------------------

/**
 * `current` extends `previous` when no entry disappeared or changed, except
 * an active entry that became validly revoked; and when every revocation
 * record of `previous` is still reachable, with the same key and `revoked`, a
 * `compromisedAfter` no later, and every anchor (an .ots may be upgraded, on
 * the same digest). The records are compared wherever each state's service
 * endpoint points: an endpoint may move, its records may not be lost.
 */
async function checkExtends(current, previous, did, faults) {
  const now = new Map(current.doc.verificationMethod.map((m) => [m.id, m]));
  for (const before of previous.doc.verificationMethod ?? []) {
    const after = now.get(before.id);
    if (!after) { faults.add(`${before.id}: removed since the previous state`); continue; }
    if (same(after, before)) continue;
    const revokedNow = !("revoked" in before) && "revoked" in after &&
      same({ ...after, publicKeyJwk: before.publicKeyJwk, revoked: undefined }, { ...before, revoked: undefined });
    if (!revokedNow) faults.add(`${before.id}: changed since the previous state`);
  }
  for (const a of previous.doc.assertionMethod ?? [])
    if (!(current.doc.assertionMethod ?? []).includes(a)) faults.add(`${a}: no longer in assertionMethod`);

  for (const [tp, before] of previous.records) {
    const after = current.records.get(tp);
    if (!after) { faults.add(`${tp}: record missing since the previous state`); continue; }
    if (!same(after.publicKeyJwk, before.publicKeyJwk) || after.revoked !== before.revoked)
      faults.add(`${tp}: record key or revoked changed since the previous state`);
    if (Date.parse(after.compromisedAfter) > Date.parse(before.compromisedAfter))
      faults.add(`${tp}: compromisedAfter moved later (${before.compromisedAfter} → ${after.compromisedAfter})`);
    for (const a of before.anchors ?? []) {
      const b = (after.anchors ?? []).find((x) => x.treeSize === a.treeSize);
      let kept = b && b.rootHash === a.rootHash && b.tsr === a.tsr;
      if (kept) {
        const digests = await Promise.all([join(previous.dir, a.ots), join(current.dir, b.ots)]
          .map(async (f) => b64url(otsDigest(await readFile(f)))).map((p) => p.catch(() => null)));
        kept = digests[0] !== null && digests[0] === digests[1];
      }
      if (!kept) faults.add(`${tp}: anchor ${a.treeSize} removed or changed since the previous state`);
    }
  }
}

// --- operations ------------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(name);

async function writeDoc(out, doc) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, serialise(doc));
  console.error(`wrote ${out}`);
}

/** The entries one key brings: its thumbprint, then its logical name if any. */
async function keyMethods(did, publicJwk, alsoKeyName, existing) {
  const tp = await thumbprint(publicJwk);
  const methods = [method(did, tp, publicJwk)];
  let name = alsoKeyName;
  if (name === "next") {
    const numbers = existing.map((m) => /^key-(\d+)$/.exec(fragmentOf(m))?.[1]).filter(Boolean).map(Number);
    name = `key-${Math.max(0, ...numbers) + 1}`;
    if (existing.some((m) => same(m.publicKeyJwk, publicJwk) && /^key-\d+$/.test(fragmentOf(m)))) name = null;
  }
  if (name) methods.push(method(did, name, publicJwk));
  return { tp, methods };
}

/** --new / --from-private, with or without --append. Returns the new document, or exits. */
async function withKey(did, doc, publicJwk, alsoKeyName, append, faults) {
  const existing = doc?.verificationMethod ?? [];
  const { tp, methods } = await keyMethods(did, publicJwk, alsoKeyName, existing);
  if (!doc) return normalised(did, methods, methods.map((m) => m.id), null);

  if (!append) {
    // A rebuild from one key: allowed only if it loses or changes nothing.
    const ids = new Map(methods.map((m) => [m.id, m]));
    for (const m of existing) {
      if (!ids.has(m.id)) faults.add(`${m.id}: would be removed; use --append to add a key`);
      else if (!same(ids.get(m.id), m)) faults.add(`${m.id}: would be changed`);
    }
    faults.exitIfAny();
    return normalised(did, existing, doc.assertionMethod, doc.service);
  }

  const added = [];
  for (const m of methods) {
    const there = existing.find((e) => e.id === m.id);
    if (!there) { added.push(m); continue; }
    if ("revoked" in there) faults.add(`${m.id}: revoked; a revoked key is never published again`);
    else if (!same(there.publicKeyJwk, m.publicKeyJwk)) faults.add(`${m.id}: already designates another key`);
  }
  faults.exitIfAny();
  console.error(`fragment ${tp}`);
  return normalised(did, [...existing, ...added],
    [...(doc.assertionMethod ?? []), ...added.map((m) => m.id)], doc.service);
}

function compromisedAfterArg(revoked, faults) {
  const t = arg("--compromised-after");
  if (!t) faults.add("--compromised-after <dateTimeStamp> is required: the last moment the key is known to have been safe");
  else if (!DATE_TIME.test(t) || Number.isNaN(Date.parse(t))) faults.add(`--compromised-after ${t}: not a UTC dateTimeStamp`);
  else if (Date.parse(t) > Date.parse(revoked)) faults.add(`--compromised-after ${t}: after the revocation (${revoked}) or in the future`);
  return t;
}

/** --revoke: every entry of the key, and its record, in one change. */
async function revoke(did, doc, site, tp, faults) {
  const methods = doc?.verificationMethod ?? [];
  const main = methods.find((m) => m.id === `${did}#${tp}`);
  if (!main) faults.add(`${tp}: no entry with this thumbprint`);
  else if ("revoked" in main) faults.add(`${tp}: already revoked`);
  const revoked = nowStamp();
  const compromisedAfter = compromisedAfterArg(revoked, faults);
  faults.exitIfAny();

  const original = requiredMembers(main.publicKeyJwk);
  const placeholder = revokedPlaceholder(tp);
  const updated = methods.map((m) => same(m.publicKeyJwk, original) && !("revoked" in m)
    ? { ...m, publicKeyJwk: placeholder, revoked } : m);
  const next = normalised(did, updated, doc.assertionMethod, doc.service);
  if (!updated.some((m) => !("revoked" in m)))
    console.error(`WARNING ${did}: no active key remains; nothing verifies until a key is appended`);

  const config = await readJson(arg("--config", DEFAULT_CONFIG)) ?? {};
  const record = { id: `${did}#${tp}`, publicKeyJwk: original, revoked, compromisedAfter,
    ...(config.log ? { log: config.log } : {}), anchors: [] };
  const dir = recordsDir(site, next, did);
  await mkdir(dir, { recursive: true });
  // The record first: the document must never point to a record that is not there.
  await writeFile(join(dir, `${tp}.json`), serialise(record));
  console.error(`wrote ${join(dir, `${tp}.json`)}`);
  return next;
}

async function revokeUpdate(did, doc, site, tp, faults) {
  const path = join(recordsDir(site, doc, did), `${tp}.json`);
  const record = await readJson(path);
  if (!record) faults.add(`${tp}: no revocation record at ${path}`);
  const t = record ? compromisedAfterArg(record.revoked, faults) : null;
  faults.exitIfAny();
  if (Date.parse(t) > Date.parse(record.compromisedAfter))
    faults.add(`${tp}: compromisedAfter moved later (${record.compromisedAfter} → ${t}); it may only move earlier`);
  faults.exitIfAny();
  if (t === record.compromisedAfter) { console.error(`unchanged ${path}`); return; }
  await writeFile(path, serialise({ ...record, compromisedAfter: t }));
  console.error(`wrote ${path}`);
}

async function anchor(did, doc, site, tp, faults) {
  const dir = recordsDir(site, doc, did);
  const path = join(dir, `${tp}.json`);
  const record = await readJson(path);
  const treeSize = Number(arg("--tree-size"));
  const root = arg("--root"), ots = arg("--ots"), tsr = arg("--tsr");
  if (!record) faults.add(`${tp}: no revocation record at ${path}`);
  if (!Number.isSafeInteger(treeSize) || treeSize < 1) faults.add("--tree-size <n>: a positive integer is required");
  if (!/^[A-Za-z0-9_-]{43}$/.test(root ?? "")) faults.add("--root: a base64url SHA-256 digest is required");
  if (!ots) faults.add("--ots <file> is required");
  faults.exitIfAny();
  try {
    const digest = b64url(otsDigest(await readFile(ots)));
    if (digest !== root) faults.add(`${ots} commits to ${digest}, not to the root ${root}`);
  } catch (e) { faults.add(`${ots}: ${e.message}`); }
  faults.exitIfAny();

  const entry = { treeSize, rootHash: root, ots: `${tp}/${treeSize}.ots`, ...(tsr ? { tsr: `${tp}/${treeSize}.tsr` } : {}) };
  const there = (record.anchors ?? []).find((a) => a.treeSize === treeSize);
  if (there && !same(there, entry)) faults.add(`${tp}: anchor ${treeSize} is already listed with other values`);
  faults.exitIfAny();
  await mkdir(join(dir, tp), { recursive: true });
  await copyFile(ots, join(dir, entry.ots));
  if (tsr) await copyFile(tsr, join(dir, entry.tsr));
  if (there) { console.error(`unchanged ${path}`); return; }
  const anchors = [...(record.anchors ?? []), entry].sort((a, b) => a.treeSize - b.treeSize);
  await writeFile(path, serialise({ ...record, anchors }));
  console.error(`wrote ${path}`);
}

async function main() {
  const configFile = arg("--config", DEFAULT_CONFIG);
  const config = await readJson(configFile);
  const did = arg("--did") ?? config?.did;
  if (!did) { console.error(`no DID: give --did, or write it in ${configFile}`); process.exit(2); }
  const site = arg("--site", DEFAULT_SITE);
  const out = arg("--out", join(site, DOCUMENT));
  const faults = new Faults();

  const toVerify = arg("--verify-file", null);
  if (toVerify) {
    const vsite = arg("--site", null) ?? (toVerify.endsWith(DOCUMENT) ? toVerify.slice(0, -DOCUMENT.length) : dirname(toVerify));
    const current = await checkState(vsite, toVerify, did, faults);
    const previousSite = arg("--previous", null);
    if (current && previousSite) {
      const before = new Faults();
      const previous = await checkState(previousSite, join(previousSite, DOCUMENT), did, before);
      // The previous state is what it is; only what it contains is compared.
      if (previous) await checkExtends(current, previous, did, faults);
      else faults.add(`no previous state at ${previousSite}`);
    }
    faults.exitIfAny();
    console.error(`OK ${toVerify} consistent, ${current.doc.verificationMethod.length} key(s)`);
    return;
  }

  let doc = await readJson(out);
  let publicJwk = null;
  if (flag("--new")) {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
    publicJwk = requiredMembers(await crypto.subtle.exportKey("jwk", pair.publicKey));
    // The only output on stdout, meant to be redirected into a vault. Nothing
    // else may go to this stream: human messages go to stderr.
    process.stdout.write(JSON.stringify(priv) + "\n");
  } else if (arg("--from-private")) {
    const from = arg("--from-private");
    const raw = from === "-" ? await readStdin(process.stdin) : await readFile(from, "utf8");
    publicJwk = await publicFromPrivate(JSON.parse(raw));
  }

  if (flag("--check")) {
    if (!publicJwk) { console.error("--check needs --from-private <file|->"); process.exit(2); }
    const tp = await thumbprint(publicJwk);
    const entry = doc?.verificationMethod?.find((m) => m.id === `${did}#${tp}`);
    if (entry && !("revoked" in entry) && same(entry.publicKeyJwk, publicJwk)) { console.error(`OK ${out} carries the key supplied`); return; }
    console.error(!doc ? `FAULT ${out} is missing although the key exists`
      : entry && "revoked" in entry ? `FAULT ${out} carries the key supplied as revoked`
      : `FAULT ${out} does not carry the key supplied`);
    process.exit(1);
  }

  const revokeTp = arg("--revoke"), updateTp = arg("--revoke-update"), anchorTp = arg("--anchor");
  if (publicJwk) doc = await withKey(did, doc, publicJwk, arg("--also-key-name"), flag("--append"), faults);
  if (revokeTp) doc = await revoke(did, doc, site, revokeTp, faults);
  if (updateTp) return revokeUpdate(did, doc, site, updateTp, faults);
  if (anchorTp) return anchor(did, doc, site, anchorTp, faults);
  if (!publicJwk && !revokeTp) {
    if (!flag("--normalize")) {
      console.error("one of --new, --from-private, --revoke, --revoke-update, --anchor, --normalize, --verify-file is required");
      process.exit(2);
    }
    if (!doc) { console.error(`FAULT ${out} is missing`); process.exit(1); }
    doc = normalised(did, doc.verificationMethod, doc.assertionMethod, doc.service);
  }
  const before = await readFile(out, "utf8").catch(() => null);
  if (before === serialise(doc)) { console.error(`unchanged ${out}`); return; }
  await writeDoc(out, doc);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
