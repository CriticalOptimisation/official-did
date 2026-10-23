#!/usr/bin/env node
// Assembles one domain's site: the shared files of public/, the templates
// filled in with the Netlify project's variables, and the domain's data tree,
// the content of its branch data/$DID_DOMAIN.
//
// A DATA TREE HOLDS DATA, AND NOTHING ELSE. Whoever can write to a data branch
// must not be able to serve a page, set a header or a redirect, or slip in
// another domain's document. So the tree is refused, and nothing is written,
// if it holds any file other than the data paths, a symbolic link, a
// .gitignore that differs from tools/data-branch.gitignore, or a document
// whose id is not did:web:$DID_DOMAIN. The .gitignore is checked, not served.
//
// Usage: DID_DOMAIN=<domain> DID_REDIRECT=<url> \
//          node tools/build-site.mjs --data <data tree> --out <dist> [--public <dir>]
// --out must not exist. Each refusal is one line `FAULT <path>: <reason>`,
// exit 1; a missing variable or argument is a usage error, exit 2.

import { readFile, writeFile, mkdir, readdir, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC = resolve(TOOLS, "..", "public");
const GITIGNORE = join(TOOLS, "data-branch.gitignore");
const DOCUMENT = ".well-known/did.json";

// The paths a data branch may hold, besides its .gitignore. publish.sh and
// data-branch.sh hold the same expression.
const DATA_PATH = /^(\.well-known\/did\.json|revocations\/[A-Za-z0-9_-]{43}\.json|revocations\/[A-Za-z0-9_-]{43}\/[1-9][0-9]*\.(ots|tsr))$/;

// A host name in lower case: the DID, the branch name and the URLs are built
// from it, so nothing else may get in.
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function usage(message) {
  console.error(`build-site: ${message}`);
  process.exit(2);
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1] ?? null;
}

/** Every entry under `root`, depth first, as [posix relative path, lstat]. Links are not followed. */
async function walk(root, rel = "") {
  const found = [];
  for (const name of (await readdir(join(root, rel))).sort()) {
    const path = rel ? `${rel}/${name}` : name;
    const stat = await lstat(join(root, path));
    if (stat.isDirectory()) found.push(...await walk(root, path));
    else found.push([path, stat]);
  }
  return found;
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function main() {
  const domain = process.env.DID_DOMAIN;
  const redirect = process.env.DID_REDIRECT;
  if (!domain) usage("DID_DOMAIN is not set");
  if (!HOST_NAME.test(domain)) usage(`DID_DOMAIN ${domain} is not a lower-case host name`);
  if (!redirect) usage("DID_REDIRECT is not set");
  let redirectUrl;
  try { redirectUrl = new URL(redirect); } catch { usage(`DID_REDIRECT ${redirect} is not a URL`); }
  if (!["https:", "http:"].includes(redirectUrl.protocol)) usage(`DID_REDIRECT ${redirect} is not an http(s) URL`);
  const data = arg("--data"), out = arg("--out"), pub = arg("--public", DEFAULT_PUBLIC);
  if (!data || !out) usage("usage: build-site.mjs --data <data tree> --out <dist> [--public <dir>]");
  if (await lstat(out).then(() => true, () => false)) usage(`--out ${out} exists`);

  const did = `did:web:${domain}`;
  const values = { DID_DOMAIN: domain, DID_REDIRECT: redirect, DID_REDIRECT_HOST: redirectUrl.host };
  const faults = [];
  const files = new Map(); // served path → content

  // The data tree.
  let gitignore = false;
  for (const [path, stat] of await walk(data)) {
    if (!stat.isFile()) { faults.push(`${path}: not a regular file`); continue; }
    if (path === ".gitignore") {
      gitignore = true;
      if (!(await readFile(join(data, path))).equals(await readFile(GITIGNORE)))
        faults.push(".gitignore: differs from tools/data-branch.gitignore");
      continue;
    }
    if (!DATA_PATH.test(path)) { faults.push(`${path}: not a data file`); continue; }
    files.set(path, await readFile(join(data, path)));
  }
  if (!gitignore) faults.push(".gitignore: missing");
  if (!files.has(DOCUMENT)) faults.push(`${DOCUMENT}: missing`);
  else {
    let id;
    try { id = JSON.parse(files.get(DOCUMENT).toString("utf8")).id; } catch { faults.push(`${DOCUMENT}: not JSON`); }
    if (id !== undefined && id !== did) faults.push(`${DOCUMENT}: id is ${id}, not ${did}`);
  }

  // The shared files and the templates. A data file never replaces one.
  for (const [path, stat] of await walk(pub)) {
    if (!stat.isFile()) { faults.push(`${path}: not a regular file in ${pub}`); continue; }
    if (files.has(path)) { faults.push(`${path}: both a data file and a file of ${pub}`); continue; }
    let content = await readFile(join(pub, path));
    if (content.includes("{{")) {
      const escape = /\.(html|xml)$/.test(path) ? escapeHtml : (s) => s;
      let text = content.toString("utf8");
      text = text.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (all, name) => name in values ? escape(values[name]) : all);
      for (const m of new Set(text.match(/\{\{[A-Za-z0-9_]+\}\}/g) ?? [])) faults.push(`${path}: ${m} left unfilled`);
      content = Buffer.from(text, "utf8");
    }
    files.set(path, content);
  }

  if (faults.length) {
    faults.forEach((f) => console.error(`FAULT ${f}`));
    process.exit(1);
  }
  for (const [path, content] of files) {
    await mkdir(dirname(join(out, path)), { recursive: true });
    await writeFile(join(out, path), content);
  }
  console.error(`build-site: ${did}, ${files.size} files in ${out}`);
}

main().catch((e) => { console.error(`build-site: ${e.message}`); process.exit(1); });

// --- Change History -------------------------------------------------------
// | PR     | Summary                                                       |
// |--------|---------------------------------------------------------------|
// | #10    | assembles one domain's site from public/ and its data (#8)    |
