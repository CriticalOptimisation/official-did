// Mirrors the live state of a did:web site into a directory, for the
// deploy-time check: the DID document, and the revocation record of every
// revoked entry with its proof files, laid out as the site serves them.
//
// The live site has no directory listing, so the records are found through
// the live document itself: its revoked entries name the thumbprints, and its
// service endpoint gives the path. Paths are fetched from the base URL given
// (Netlify's $URL), not from the endpoint's host, so that a preview or a test
// server can stand for the site.
//
// Usage: node tools/fetch-live.mjs <base-url> <dir>   — exits 1 on any failure.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [base, dir] = process.argv.slice(2);
const TIMEOUT_MS = 10_000;

async function get(path) {
  const url = new URL(path, base.endsWith("/") ? base : base + "/").href;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), body);
  return body;
}

async function main() {
  if (!base || !dir) throw new Error("usage: fetch-live.mjs <base-url> <dir>");
  const doc = JSON.parse(await get(".well-known/did.json"));
  const service = (doc.service ?? []).find((s) => s.type === "KeyRevocationRecords");
  if (!service) return; // a document from before revocation existed: nothing else to fetch
  const path = new URL(service.serviceEndpoint).pathname.replace(/^\//, "");
  const revoked = (doc.verificationMethod ?? [])
    .filter((m) => "revoked" in m)
    .map((m) => String(m.id).split("#")[1])
    .filter((f) => /^[A-Za-z0-9_-]{43}$/.test(f));
  for (const tp of revoked) {
    const record = JSON.parse(await get(`${path}${tp}.json`));
    for (const a of record.anchors ?? []) {
      await get(`${path}${a.ots}`);
      if (a.tsr) await get(`${path}${a.tsr}`);
    }
  }
}

main().catch((e) => { console.error(`fetch-live: ${e.cause?.code ?? e.message}`); process.exit(1); });
