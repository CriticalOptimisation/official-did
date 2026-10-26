// tools/fixtures/domains.mjs — two fixture domains for the tests of #8.
//
// Each domain gets a data tree laid out as its data branch holds it: the DID
// document, the revocation record of a revoked key with no anchor, and the
// reference .gitignore. The trees are made with make-did.mjs and an explicit
// --did, so that they can be made with any version of the tool.
//
// THE PRIVATE KEY GOES THROUGH STDIN, NEVER THROUGH A FILE, here too.

import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir, cp, copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { webcrypto as crypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TOOLS = join(REPO, "tools");
export const MAKE_DID = join(TOOLS, "make-did.mjs");
export const BUILD_SITE = join(TOOLS, "build-site.mjs");
export const NETLIFY_BUILD = join(TOOLS, "netlify-build.sh");
export const PUBLISH = join(TOOLS, "publish.sh");
export const DATA_BRANCH = join(TOOLS, "data-branch.sh");
export const DATA_GITIGNORE = join(TOOLS, "data-branch.gitignore");
export const DOCUMENT = join(".well-known", "did.json");
export const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

export const A = "a.example.test";
export const B = "b.example.test";
export const REDIRECT = { [A]: "https://www.a-owner.example.test/", [B]: "https://www.b-owner.example.test/" };

export const lines = (text) => text.split("\n");
/** True if one whole line of `text` matches `re` (anchored by the caller). */
export const hasLine = (text, re) => lines(text).some((l) => re.test(l));

export async function freshJwk() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", pair.privateKey);
}

export async function thumbprintOf(jwk) {
  const m = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return Buffer.from(await crypto.subtle.digest("SHA-256",
    Buffer.from(JSON.stringify(m, Object.keys(m).sort())))).toString("base64url");
}

/** Runs make-did.mjs on a data tree, with an explicit DID and an optional key on stdin. */
export function makeDid(domain, tree, args, jwk = null) {
  const r = spawnSync(process.execPath, [MAKE_DID, "--did", `did:web:${domain}`, "--site", tree,
    "--out", join(tree, DOCUMENT), ...args], { input: jwk ? JSON.stringify(jwk) : "", encoding: "utf8" });
  assert.equal(r.status, 0, `make-did ${args.join(" ")}: ${r.stderr}`);
  return r;
}

/**
 * A data tree for `domain`: two keys, the first revoked (so a revocation
 * record exists), and the reference .gitignore.
 */
export async function dataTree(domain) {
  const tree = join(await mkdtemp(join(tmpdir(), "did-data-")), "data");
  await mkdir(join(tree, ".well-known"), { recursive: true });
  const k1 = await freshJwk(), k2 = await freshJwk();
  makeDid(domain, tree, ["--from-private", "-"], k1);
  makeDid(domain, tree, ["--from-private", "-", "--append"], k2);
  makeDid(domain, tree, ["--emergency", "--revoke", await thumbprintOf(k1), "--compromised-after", "2026-01-01T00:00:00Z"]);
  await copyFile(DATA_GITIGNORE, join(tree, ".gitignore"));
  return { tree, domain, tp1: await thumbprintOf(k1), tp2: await thumbprintOf(k2) };
}

export async function copyOf(dir) {
  const copy = join(await mkdtemp(join(tmpdir(), "did-copy-")), "copy");
  await cp(dir, copy, { recursive: true });
  return copy;
}

export function git(cwd, ...args) {
  return execFileSync(REAL_GIT, args, { cwd, encoding: "utf8" });
}

/** Commits `tree` as the orphan branch data/<domain> of the bare repository `origin`. */
export async function pushDataBranch(origin, domain, tree) {
  const work = await copyOf(tree);
  git(work, "init", "-q", "-b", `data/${domain}`);
  git(work, "config", "user.email", "test@example.invalid");
  git(work, "config", "user.name", "test");
  git(work, "add", "-A");
  git(work, "commit", "-qm", `data for ${domain}`);
  git(work, "push", "-q", origin, `data/${domain}`);
  return git(work, "rev-parse", "HEAD").trim();
}

/**
 * A bare origin with a `main` branch holding one file, and the data branches
 * of A and B. Returns { root, origin, trees: { [domain]: dataTree } }.
 */
export async function twoDomainOrigin() {
  const root = await mkdtemp(join(tmpdir(), "did-origin-"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  await mkdir(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "test@example.invalid");
  git(seed, "config", "user.name", "test");
  await writeFile(join(seed, "README.md"), "main\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "main");
  git(seed, "push", "-q", origin, "main");
  const trees = { [A]: await dataTree(A), [B]: await dataTree(B) };
  for (const d of [A, B]) trees[d].commit = await pushDataBranch(origin, d, trees[d].tree);
  return { root, origin, trees };
}

/** The head commit of `branch` in `origin`, or null. */
export function headOf(origin, branch) {
  try { return git(origin, "rev-parse", "--verify", "-q", `refs/heads/${branch}`).trim(); } catch { return null; }
}

/**
 * The domain of a live site served by `serve`: its URL's host name, so that
 * the build's check "the host of $URL is DID_DOMAIN" holds for it.
 */
export const LOCAL = "localhost";

/** Serves `dir` as a static site on localhost; resolves to { url, close }. */
export function serve(dir) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    try { res.writeHead(200).end(await readFile(join(dir, path))); } catch { res.writeHead(404).end("not found"); }
  });
  return new Promise((ok) => server.listen(0, LOCAL, () =>
    ok({ url: `http://${LOCAL}:${server.address().port}`, close: () => server.close() })));
}

/**
 * A build hook stand-in: records each request's method; answers `status`.
 * Resolves to { url, calls, close }.
 */
export function hookServer(status = 200) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(req.method);
    req.resume();
    req.on("end", () => res.writeHead(status).end("{}"));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () =>
    ok({ url: `http://127.0.0.1:${server.address().port}/build_hooks/test`, calls, close: () => server.close() })));
}

/** Runs a command asynchronously, so that servers in this process keep answering. */
export function run(cmd, args, env, input = "") {
  return new Promise((ok) => {
    const child = spawn(cmd, args, { env: { ...process.env, NODE: process.execPath, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => ok({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

// --- Change History -------------------------------------------------------
// | PR     | Summary                                                       |
// |--------|---------------------------------------------------------------|
// | #10    | two fixture domains with their data branches (#8)             |
// | #22    | the fixture revokes with --emergency (#21)                    |
