// tools/publish.test.mjs — tools/publish.sh: one change, pushed to the
// domain's data branch data/$DID_DOMAIN, re-applied from the new head for as
// long as other tools publish first, then the domain's build hook is called
// (#8).
//
// Each test builds a bare "origin" holding `main` and the data branches of
// two domains, A and B, and a single-branch clone of data/A as the working
// copy. It puts a fake `git` first on PATH. The fake delegates to the real
// git, except for `push`, which it counts and, depending on the test, rejects
// as a lost race, fails as an authentication error, or precedes with a
// competing push. A local HTTP server stands for the build hook. Private keys
// go through stdin only; the competitor uses --new and discards its key.
//
// Run with: node --test tools/publish.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  A, B, PUBLISH, MAKE_DID, REAL_GIT, DOCUMENT,
  twoDomainOrigin, headOf, git, freshJwk, hookServer, run, lines,
} from "./fixtures/domains.mjs";

const BRANCH = `data/${A}`;
const matching = (text, re) => lines(text).filter((l) => re.test(l));

/** origin with A and B; `seed` and `work`, two single-branch clones of data/A. */
async function setup() {
  const o = await twoDomainOrigin();
  const seed = join(o.root, "seed-a");
  const work = join(o.root, "work");
  for (const [dir, who] of [[seed, "competitor"], [work, "publisher"]]) {
    git(o.root, "clone", "-q", "--single-branch", "-b", BRANCH, o.origin, dir);
    git(dir, "config", "user.email", `${who}@example.invalid`);
    git(dir, "config", "user.name", who);
  }
  return { ...o, seed, work };
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
          printf '!\\tHEAD:refs/heads/${BRANCH}\\t[rejected] (fetch first)\\n'
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

/** Runs publish.sh for domain A, with a build hook that answers `hookStatus`. */
async function publish(ctx, env, args, input = "", hookStatus = 200) {
  const hook = await hookServer(hookStatus);
  try {
    const r = await run("sh", [PUBLISH, ...args], {
      DID_DOMAIN: A, DID_PUBLISH_WORKDIR: ctx.work, DID_PUBLISH_BUILD_HOOK: hook.url,
      DID_PUBLISH_PAUSE_MAX: "0", ...env,
    }, input);
    return { ...r, hookCalls: hook.calls };
  } finally { hook.close(); }
}

const originDoc = (ctx) => JSON.parse(git(ctx.origin, "show", `${BRANCH}:${DOCUMENT}`));

const ALERT = /^publish: still retrying after (\d+) rejected pushes \(.+\)$/;

test("lost races are retried without limit; one alert line, and one syslog call, every N rejections", async () => {
  const ctx = await setup();
  const { bin, count } = await fakeGit(ctx.root, { mode: "reject", times: 7 });
  const { stub, log } = await loggerStub(ctx.root);
  const r = await publish(ctx, {
    PATH: `${bin}:${process.env.PATH}`, DID_PUBLISH_ALERT_EVERY: "3", DID_PUBLISH_LOGGER: stub,
  }, ["--from-private", "-", "--append"], JSON.stringify(await freshJwk()));

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(matching(r.stderr, ALERT).map((l) => Number(ALERT.exec(l)[1])), [3, 6]);
  assert.equal(lines((await readFile(log, "utf8")).trimEnd()).length, 2);
  assert.equal(matching(r.stderr, /^publish: published [0-9a-f]{40} after 7 rejected pushes$/).length, 1, r.stderr);
  assert.equal(Number(await readFile(count, "utf8")), 8);
  assert.equal(originDoc(ctx).verificationMethod.length, 3);
});

test("an authentication failure is not a lost race: one attempt, then a stop", async () => {
  const ctx = await setup();
  const { bin, count } = await fakeGit(ctx.root, { mode: "auth", times: 99 });
  const r = await publish(ctx, { PATH: `${bin}:${process.env.PATH}` },
    ["--from-private", "-", "--append"], JSON.stringify(await freshJwk()));

  assert.notEqual(r.status, 0);
  assert.equal(Number(await readFile(count, "utf8")), 1);
  assert.equal(matching(r.stderr, /^publish: push failed, not retried: fatal: Authentication failed for 'origin'$/).length, 1, r.stderr);
  assert.equal(matching(r.stderr, ALERT).length, 0);
  assert.deepEqual(r.hookCalls, []);
});

test("a competitor publishes first, twice: the change is re-applied on its head, and both survive", async () => {
  const ctx = await setup();
  // Before each of the first two pushes, the competitor appends a fresh key
  // from the seed clone and pushes it, so publish.sh genuinely loses the race.
  const competitor = [
    `'${REAL_GIT}' -C '${ctx.seed}' pull -q origin '${BRANCH}'`,
    `'${process.execPath}' '${MAKE_DID}' --did 'did:web:${A}' --site '${ctx.seed}' --out '${ctx.seed}/${DOCUMENT}' --new --append > /dev/null 2>&1`,
    `'${REAL_GIT}' -C '${ctx.seed}' commit -qam competitor`,
    `'${REAL_GIT}' -C '${ctx.seed}' push -q origin '${BRANCH}'`,
  ].join("\n      ");
  const { bin } = await fakeGit(ctx.root, { mode: "real", times: 2, before: competitor });
  const jwk = await freshJwk();
  const r = await publish(ctx, { PATH: `${bin}:${process.env.PATH}` },
    ["--from-private", "-", "--append"], JSON.stringify(jwk));

  assert.equal(r.status, 0, r.stderr);
  assert.equal(matching(r.stderr, /^publish: published [0-9a-f]{40} after 2 rejected pushes$/).length, 1, r.stderr);
  const doc = originDoc(ctx);
  // The two keys of the fixture, two competitor keys, and ours: nothing was overwritten.
  assert.equal(doc.verificationMethod.length, 5);
  const ours = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  assert.ok(doc.verificationMethod.some((m) => m.publicKeyJwk.x === ours.x && m.publicKeyJwk.y === ours.y));
});

test("nothing to publish: the change is already there, no push, no build", async () => {
  const ctx = await setup();
  const { bin, count } = await fakeGit(ctx.root, { mode: "real", times: 0 });
  const r = await publish(ctx, { PATH: `${bin}:${process.env.PATH}` }, ["--normalize"]);
  // The fixture was written by the current tool, so normalizing changes nothing.
  assert.equal(r.status, 0, r.stderr);
  assert.equal(matching(r.stderr, /^publish: nothing to publish$/).length, 1, r.stderr);
  assert.equal(await readFile(count, "utf8").catch(() => "0"), "0");
  assert.deepEqual(r.hookCalls, []);
});

test("a make-did.mjs failure is not a lost race: no push, no retry", async () => {
  const ctx = await setup();
  const { bin, count } = await fakeGit(ctx.root, { mode: "real", times: 0 });
  const r = await publish(ctx, { PATH: `${bin}:${process.env.PATH}` },
    ["--revoke", "A".repeat(43), "--compromised-after", "2026-01-01T00:00:00Z"]);
  assert.notEqual(r.status, 0);
  assert.equal(matching(r.stderr, /^FAULT A{43}: no entry with this thumbprint$/).length, 1, r.stderr);
  assert.equal(matching(r.stderr, /^publish: make-did\.mjs failed, not retried$/).length, 1, r.stderr);
  assert.equal(await readFile(count, "utf8").catch(() => "0"), "0");
});

// --- several domains (#8) -------------------------------------------------------

test("publishing for A changes data/A only: data/B and main are untouched", async () => {
  const ctx = await setup();
  const before = { main: headOf(ctx.origin, "main"), a: headOf(ctx.origin, BRANCH), b: headOf(ctx.origin, `data/${B}`) };
  const r = await publish(ctx, {}, ["--from-private", "-", "--append"], JSON.stringify(await freshJwk()));
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(headOf(ctx.origin, BRANCH), before.a);
  assert.equal(headOf(ctx.origin, `data/${B}`), before.b);
  assert.equal(headOf(ctx.origin, "main"), before.main);
  assert.equal(originDoc(ctx).verificationMethod.length, 3);
});

test("after the accepted push, the build hook is called once, with a POST", async () => {
  const ctx = await setup();
  const r = await publish(ctx, {}, ["--from-private", "-", "--append"], JSON.stringify(await freshJwk()));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(matching(r.stderr, /^publish: published [0-9a-f]{40} after 0 rejected pushes$/).length, 1, r.stderr);
  assert.deepEqual(r.hookCalls, ["POST"]);
});

test("a failed build hook: published, not deployed; one alert, exit 3", async () => {
  const ctx = await setup();
  const { stub, log } = await loggerStub(ctx.root);
  const r = await publish(ctx, { DID_PUBLISH_LOGGER: stub },
    ["--from-private", "-", "--append"], JSON.stringify(await freshJwk()), 500);
  assert.equal(r.status, 3, r.stderr);
  const head = headOf(ctx.origin, BRANCH);
  assert.equal(matching(r.stderr, new RegExp(`^publish: published ${head}, not deployed: build hook failed \\(.+\\)$`)).length, 1, r.stderr);
  assert.equal(lines((await readFile(log, "utf8")).trimEnd()).length, 1);
  assert.deepEqual(r.hookCalls, ["POST"]);
  assert.equal(originDoc(ctx).verificationMethod.length, 3);
});
