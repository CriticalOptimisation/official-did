// tools/hash-to-curve.test.mjs — RFC 9380 hash-to-curve for P-256, and the
// placeholder key of a revoked entry derived with it.
//
// The vectors are RFC 9380's own (Appendix J.1.1), extracted by script from
// the RFC text into fixtures/rfc9380-p256-ro.json, never retyped. An
// implementation that reproduces them is RFC 9380.
//
// Run with: node --test tools/hash-to-curve.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto as crypto } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashToFieldP256, hashToCurveP256, revokedPlaceholder, REVOKED_DST } from "./hash-to-curve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RFC = JSON.parse(await readFile(join(HERE, "fixtures", "rfc9380-p256-ro.json"), "utf8"));

const hex = (n) => n.toString(16).padStart(64, "0");
const b64urlToHex = (s) => Buffer.from(s, "base64url").toString("hex");

test("the fixture is RFC 9380's P256_XMD:SHA-256_SSWU_RO_ suite, five messages", () => {
  assert.equal(RFC.suite, "P256_XMD:SHA-256_SSWU_RO_");
  assert.equal(RFC.dst, "QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_RO_");
  assert.equal(RFC.vectors.length, 5);
});

for (const v of RFC.vectors) {
  const label = v.msg.length > 16 ? `${v.msg.slice(0, 8)}…(${v.msg.length})` : JSON.stringify(v.msg);

  test(`hash_to_field reproduces u[0], u[1] for msg ${label}`, () => {
    const u = hashToFieldP256(v.msg, RFC.dst, 2);
    assert.deepEqual(u.map(hex), v.u);
  });

  test(`hash_to_curve reproduces P for msg ${label}`, () => {
    const P = hashToCurveP256(v.msg, RFC.dst);
    assert.deepEqual({ x: hex(P.x), y: hex(P.y) }, v.P);
  });
}

test("the revocation DST names no site", () => {
  assert.equal(REVOKED_DST, "DID-WEB-REVOKED-V1_P256_XMD:SHA-256_SSWU_RO_");
});

test("the placeholder of a thumbprint is hash_to_curve(thumbprint, REVOKED_DST), as a P-256 JWK", () => {
  const tp = "EXbuzo8vjX85lRx4zuwJiRhJYbQfKCLqK6VpEpZ3ggw";
  const jwk = revokedPlaceholder(tp);
  const P = hashToCurveP256(tp, REVOKED_DST);
  assert.deepEqual(Object.keys(jwk).sort(), ["crv", "kty", "x", "y"]);
  assert.equal(jwk.kty, "EC");
  assert.equal(jwk.crv, "P-256");
  assert.equal(b64urlToHex(jwk.x), hex(P.x));
  assert.equal(b64urlToHex(jwk.y), hex(P.y));
  assert.deepEqual(revokedPlaceholder(tp), jwk, "deterministic");
  assert.notDeepEqual(revokedPlaceholder(tp.slice(0, -1) + "x"), jwk, "one point per thumbprint");
});

test("the placeholder imports as a verification key, so verifiers reject signatures instead of choking", async () => {
  const jwk = revokedPlaceholder("EXbuzo8vjX85lRx4zuwJiRhJYbQfKCLqK6VpEpZ3ggw");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const data = Buffer.from("a credential");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data), false);
});
