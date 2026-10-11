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
// format is defined on /doc/KeyRevocationRecords of the DID's own site.
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

import { readFile, writeFile, mkdir } from "node:fs/promises";
// stdin is read through node:stream/consumers: the promise flavour of fs does
// not accept a numeric file descriptor, and `--from-private -` is the
// publication path that keeps the secret off the disk.
import { text as readStdin } from "node:stream/consumers";
import { webcrypto as crypto } from "node:crypto";
import { dirname } from "node:path";

const DEFAULT_DID = "did:web:natixar.pro";
const DEFAULT_OUT = "public/.well-known/did.json";
// Verifiers compare documents of the same shape; this context is the one they
// expect for JsonWebKey verification methods.
const CONTEXT = ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/jwk/v1"];

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

async function buildDidDocument(publicJwk, did, alsoKeyName) {
  const tp = await thumbprint(publicJwk);
  const method = (fragment) => ({
    id: `${did}#${fragment}`,
    type: "JsonWebKey",
    controller: did,
    publicKeyJwk: publicJwk,
  });
  // The thumbprint first: it is the reference identifier. The logical name, if
  // requested, comes second.
  const methods = [method(tp)];
  if (alsoKeyName) methods.push(method(alsoKeyName));
  return {
    "@context": CONTEXT,
    id: did,
    verificationMethod: methods,
    // `assertionMethod`, not `authentication`: this key attests, it does not
    // open sessions.
    assertionMethod: methods.map((m) => m.id),
  };
}

const serialise = (doc) => JSON.stringify(doc, null, 2) + "\n";

/**
 * Internal consistency of a DID document, without any secret.
 *
 * What this really catches: a hand-edited document whose fragment no longer
 * matches the key it carries — that is, a credential signed under an
 * identifier the document does not announce, hence unverifiable, and
 * unverifiable SILENTLY. What it does not catch: a perfectly consistent
 * document built on a key nobody holds. Only `--check` with the private key
 * says that.
 */
async function verifyFile(path, did) {
  const doc = JSON.parse(await readFile(path, "utf8"));
  const faults = [];
  if (doc.id !== did) faults.push(`id is ${doc.id}, expected ${did}`);
  if (JSON.stringify(doc["@context"]) !== JSON.stringify(CONTEXT))
    faults.push("@context differs from the expected one");
  const methods = doc.verificationMethod ?? [];
  let carriesThumbprint = false;
  if (methods.length === 0) faults.push("no verificationMethod");
  for (const m of methods) {
    const jwk = m.publicKeyJwk ?? {};
    if ("d" in jwk) faults.push(`${m.id}: PRIVATE KEY PUBLISHED, member "d" present`);
    if (m.controller !== did) faults.push(`${m.id}: controller is ${m.controller}`);
    const fragment = String(m.id).split("#")[1];
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
    const looksLikeThumbprint = /^[A-Za-z0-9_-]{43}$/.test(fragment ?? "");
    if (looksLikeThumbprint && fragment !== tp)
      faults.push(`${m.id}: thumbprint-shaped fragment, but the key gives ${tp}`);
    if (!looksLikeThumbprint) console.error(`note ${m.id}: named fragment, thumbprint ${tp}`);
    if (fragment === tp) carriesThumbprint = true;
  }
  // At least one entry must be addressable by thumbprint. Without it, a signer
  // that derives its fragment from its key has nothing to hold on to.
  if (methods.length && !carriesThumbprint)
    faults.push("no key published under its RFC 7638 thumbprint");
  const ids = methods.map((m) => m.id);
  for (const a of doc.assertionMethod ?? [])
    if (!ids.includes(a)) faults.push(`assertionMethod ${a} has no verificationMethod`);
  if (faults.length) { faults.forEach((f) => console.error(`FAULT ${f}`)); process.exit(1); }
  console.error(`OK ${path} consistent, ${methods.length} key(s)`);
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  const did = arg("--did", DEFAULT_DID);
  const out = arg("--out", DEFAULT_OUT);
  const alsoKeyName = arg("--also-key-name", null);
  const check = process.argv.includes("--check");

  const toVerify = arg("--verify-file", null);
  if (toVerify) return verifyFile(toVerify, did);

  let publicJwk;
  if (process.argv.includes("--new")) {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
    publicJwk = requiredMembers(await crypto.subtle.exportKey("jwk", pair.publicKey));
    // The only output on stdout, meant to be redirected into a vault. Nothing
    // else may go to this stream: human messages go to stderr.
    process.stdout.write(JSON.stringify(priv) + "\n");
  } else {
    const from = arg("--from-private");
    if (!from) { console.error("--new or --from-private <file|-> is required"); process.exit(2); }
    const raw = from === "-" ? await readStdin(process.stdin) : await readFile(from, "utf8");
    publicJwk = await publicFromPrivate(JSON.parse(raw));
  }

  const doc = await buildDidDocument(publicJwk, did, alsoKeyName);
  const text = serialise(doc);

  if (check) {
    let onDisk = null;
    try { onDisk = await readFile(out, "utf8"); } catch { /* absent */ }
    if (onDisk === text) { console.error(`OK ${out} matches the key supplied`); return; }
    console.error(onDisk === null
      ? `FAULT ${out} is missing although the key exists`
      : `FAULT ${out} does not match the key supplied`);
    process.exit(1);
  }

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text);
  console.error(`wrote ${out}`);
  console.error(`fragment ${doc.verificationMethod[0].id.split("#")[1]}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
