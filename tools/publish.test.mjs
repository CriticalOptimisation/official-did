// tools/publish.test.mjs — tools/publish.sh: one change, pushed to main,
// re-applied from the new head for as long as other tools publish first.
//
// Each test builds a bare "origin" and a working copy in a temporary
// directory, and puts a fake `git` first on PATH. The fake delegates to the
// real git, except for `push`, which it counts and, depending on the test,
// rejects as a lost race, fails as an authentication error, or precedes with a
// competing push. Private keys go through stdin only; the competitor uses
// --new and discards its key.
//
// Run with: node --test tools/publish.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir, chmod } from "node:fs/promises";
import { webcrypto as crypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLISH = join(HERE, "publish.sh");
const MAKE_DID = join(HERE, "make-did.mjs");
const DID = "did:web:example.test";
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const lines = (text) => text.split("\n");
const matching = (text, re) => lines(text).filter((l) => re.test(l));

function git(cwd, ...args) {
  return execFileSync(REAL_GIT, args, { cwd, encoding: "utf8" });
}

/** origin (bare) seeded with one key; a working copy for publish.sh. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "did-publish-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  for (const dir of [seed]) {
    git(dir, "config", "user.email", "test@example.invalid");
    git(dir, "config", "user.name", "test");
  }
  await mkdir(join(seed, "public", ".well-known"), { recursive: true });
  await writeFile(join(seed, "did.config.json"), JSON.stringify({ did: DID }) + "\n");
  execFileSync(process.execPath, [MAKE_DID, "--config", join(seed, "did.config.json"),
    "--site", join(seed, "public"), "--out", join(seed, "public", ".well-known", "did.json"), "--new"],
  { stdio: ["ignore", "ignore", "pipe"] });
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "seed");
  git(seed, "push", "-q", "origin", "main");
  git(root, "clone", "-q", origin, work);
  git(work, "config", "user.email", "publisher@example.invalid");
  git(work, "config", "user.name", "publisher");
  return { root, origin, seed, work };
}

/**
 * Writes a fake `git` into <root>/bin. `before` runs before each counted push
 * while the push number is ≤ `times`; `mode` decides what that push does:
 * "reject" (a lost race, in porcelain form), "auth" (authentication failure),
 * or "real" (delegate to the real git).
 */
async function fakeGit(root, { mode, times, before = "" }) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const count = join(root, "push-count");
  await writeFile(join(bin, "git"), `#!/bin/sh
for a in "$@"; do
  if [ "$a" = push ]; then
    n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${count}'
    if [ "$n" -le ${times} ]; then
      ${before}
      case '${mode}' in
        reject)
          echo "To origin"
          printf '!\\tHEAD:refs/heads/main\\t[rejected] (fetch first)\\n'
          echo "Done"
          echo "error: failed to push some refs to 'origin'" >&2
          exit 1 ;;
        auth)
          echo "fatal: Authentication failed for 'origin'" >&2
          exit 128 ;;
      esac
    fi
    break
  fi
done
exec '${REAL_GIT}' "$@"
`);
  await chmod(join(bin, "git"), 0o755);
  return { bin, count };
}

/** A logger stub: each call appends its arguments, one line per call. */
async function loggerStub(root) {
  const log = join(root, "logger-calls");
  const stub = join(root, "logger");
  await writeFile(stub, `#!/bin/sh\necho "$*" >> '${log}'\n`);
  await chmod(stub, 0o755);
  return { stub, log };
}

async function freshJwk() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", pair.privateKey);
}

function publish(env, args, input) {
  return spawnSync("sh", [PUBLISH, ...args], {
    input, encoding: "utf8",
    env: { ...process.env, NODE: process.execPath, DID_PUBLISH_PAUSE_MAX: "0", ...env },
  });
}

async function originDoc(ctx) {
  git(ctx.seed, "pull", "-q", "origin", "main");
  return JSON.parse(await readFile(join(ctx.seed, "public", ".well-known", "did.json"), "utf8"));
}

const ALERT = /^publish: still retrying after (\d+) rejected pushes \(.+\)$/;

test("lost races are retried without limit; one alert line, and one syslog call, every N rejections", async () => {
  const ctx = await setup();
  const { bin, count } = await fakeGit(ctx.root, { mode: "reject", times: 7 });
  const { stub, log } = await loggerStub(ctx.root);
  const r = publish({
    PATH: `${bin}:${process.env.PATH}`, DID_PUBLISH_WORKDIR: ctx.work,
    DID_PUBLISH_ALERT_EVERY: "3", DID_PUBLISH_LOGGER: stub,
  }, ["--from-private", "-", "--append"], JSON.stringify(await freshJwk()));

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(matching(r.stderr, ALERT).map((l) => Number(ALERT.exec(l)[1])), [3, 6]);
  assert.equal(lines((await readFile(log, "utf8")).trimEnd()).length, 2);
  assert.equal(matching(r.stderr, /^publish: published [0-9a-f]{40} after 7 rejected pushes$/).length, 1, r.stderr);
  assert.equal(Number(await readFile(count, "utf8")), 8);
  assert.equal((await originDoc(ctx)).verificationMethod.length, 2);
});

test("an authentication failure is not a lost race: one attempt, then a stop", async () => {
  const ctx = await setup();
  const { bin, count } = await fakeGit(ctx.root, { mode: "auth", times: 99 });
  const r = publish({ PATH: `${bin}:${process.env.PATH}`, DID_PUBLISH_WORKDIR: ctx.work },
    ["--from-private", "-", "--append"], JSON.stringify(await freshJwk()));

  assert.notEqual(r.status, 0);
  assert.equal(Number(await readFile(count, "utf8")), 1);
  assert.equal(matching(r.stderr, /^publish: push failed, not retried: fatal: Authentication failed for 'origin'$/).length, 1, r.stderr);
  assert.equal(matching(r.stderr, ALERT).length, 0);
});

test("a competitor publishes first, twice: the change is re-applied on its head, and both survive", async () => {
  const ctx = await setup();
  // Before each of the first two pushes, the competitor appends a fresh key
  // from the seed clone and pushes it, so publish.sh genuinely loses the race.
  const competitor = [
    `'${REAL_GIT}' -C '${ctx.seed}' pull -q origin main`,
    `'${process.execPath}' '${MAKE_DID}' --config '${ctx.seed}/did.config.json' --site '${ctx.seed}/public' --out '${ctx.seed}/public/.well-known/did.json' --new --append > /dev/null 2>&1`,
    `'${REAL_GIT}' -C '${ctx.seed}' commit -qam competitor`,
    `'${REAL_GIT}' -C '${ctx.seed}' push -q origin main`,
  ].join("\n      ");
  const { bin } = await fakeGit(ctx.root, { mode: "real", times: 2, before: competitor });
  const jwk = await freshJwk();
  const r = publish({ PATH: `${bin}:${process.env.PATH}`, DID_PUBLISH_WORKDIR: ctx.work },
    ["--from-private", "-", "--append"], JSON.stringify(jwk));

  assert.equal(r.status, 0, r.stderr);
  assert.equal(matching(r.stderr, /^publish: published [0-9a-f]{40} after 2 rejected pushes$/).length, 1, r.stderr);
  const doc = await originDoc(ctx);
  // The seed key, two competitor keys, and ours: nothing was overwritten.
  assert.equal(doc.verificationMethod.length, 4);
  const ours = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  assert.ok(doc.verificationMethod.some((m) => m.publicKeyJwk.x === ours.x && m.publicKeyJwk.y === ours.y));
});

test("nothing to publish: the change is already there, no push", async () => {
  const ctx = await setup();
  const { bin, count } = await fakeGit(ctx.root, { mode: "real", times: 0 });
  const r = publish({ PATH: `${bin}:${process.env.PATH}`, DID_PUBLISH_WORKDIR: ctx.work }, ["--normalize"], "");
  // The seed was written by the current tool, so normalizing changes nothing.
  assert.equal(r.status, 0, r.stderr);
  assert.equal(matching(r.stderr, /^publish: nothing to publish$/).length, 1, r.stderr);
  assert.equal(await readFile(count, "utf8").catch(() => "0"), "0");
});
