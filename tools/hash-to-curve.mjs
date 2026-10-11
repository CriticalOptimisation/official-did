// RFC 9380 hash-to-curve for P-256, suite P256_XMD:SHA-256_SSWU_RO_, and the
// placeholder key of a revoked DID entry derived with it.
//
// WHY A PLACEHOLDER, AND WHY THIS ONE. A revoked entry keeps its identifier,
// but its public key must stop verifying anything, including in verifiers that
// ignore `revoked`. Deleting or garbling the key would make some resolvers
// reject the whole document; a point off the curve would invite invalid-curve
// attacks on libraries that skip point validation; any other valid key could
// be held by someone. A point obtained by hashing to the curve is valid, and
// nobody knows its discrete logarithm: every library imports it, and no one
// can sign for it. It is derived from the original key's thumbprint, so there
// is exactly one, and anyone can recompute it.
//
// Not constant-time: it hashes public data only. Plain BigInt, no dependency.

import { createHash } from "node:crypto";

// P-256 (RFC 9380 §8.2): y² = x³ + A·x + B over GF(p), Z = -10, L = 48, h = 1.
const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A = p - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const Z = p - 10n;
const L = 48;

/** The domain separation tag of revocation placeholders. It names no site. */
export const REVOKED_DST = "DID-WEB-REVOKED-V1_P256_XMD:SHA-256_SSWU_RO_";

const mod = (a) => ((a % p) + p) % p;
function pow(base, exp) {
  let result = 1n;
  base = mod(base);
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % p;
    base = (base * base) % p;
    exp >>= 1n;
  }
  return result;
}
const inv0 = (a) => pow(a, p - 2n); // 0 ↦ 0, as RFC 9380 requires
const isSquare = (a) => { const l = pow(a, (p - 1n) / 2n); return l === 0n || l === 1n; };
const sqrt = (a) => pow(a, (p + 1n) / 4n); // p ≡ 3 (mod 4)
const sgn0 = (a) => a % 2n;

const bytes = (s) => (typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s));
const i2osp = (n, len) => { const b = Buffer.alloc(len); b.writeUIntBE(n, 0, len); return b; };
const os2ip = (b) => BigInt("0x" + (b.length ? Buffer.from(b).toString("hex") : "0"));
const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();

/** expand_message_xmd with SHA-256 (RFC 9380 §5.3.1). */
function expandMessageXmd(msg, dst, lenInBytes) {
  const ell = Math.ceil(lenInBytes / 32);
  if (ell > 255 || lenInBytes > 65535 || dst.length > 255) throw new Error("expand_message_xmd: input too long");
  const dstPrime = Buffer.concat([dst, i2osp(dst.length, 1)]);
  const b0 = sha256(Buffer.alloc(64), msg, i2osp(lenInBytes, 2), i2osp(0, 1), dstPrime);
  const out = [sha256(b0, i2osp(1, 1), dstPrime)];
  for (let i = 2; i <= ell; i++) {
    const xored = Buffer.from(b0.map((v, j) => v ^ out[i - 2][j]));
    out.push(sha256(xored, i2osp(i, 1), dstPrime));
  }
  return Buffer.concat(out).subarray(0, lenInBytes);
}

/** hash_to_field (RFC 9380 §5.2), m = 1: `count` elements of GF(p). */
export function hashToFieldP256(msg, dst, count) {
  const uniform = expandMessageXmd(bytes(msg), bytes(dst), count * L);
  return Array.from({ length: count }, (_, i) => mod(os2ip(uniform.subarray(L * i, L * (i + 1)))));
}

/** Simplified SWU (RFC 9380 §6.6.2), applied directly: P-256 needs no isogeny. */
function mapToCurve(u) {
  const tv1 = inv0(mod(Z * Z % p * pow(u, 4n) + Z * u * u));
  let x1 = mod(mod(-B * inv0(A)) * (1n + tv1));
  if (tv1 === 0n) x1 = mod(B * inv0(Z * A));
  const gx1 = mod(x1 * x1 % p * x1 + A * x1 + B);
  let x, y;
  if (isSquare(gx1)) {
    x = x1; y = sqrt(gx1);
  } else {
    x = mod(Z * u * u % p * x1);
    y = sqrt(mod(x * x % p * x + A * x + B));
  }
  if (sgn0(u) !== sgn0(y)) y = mod(-y);
  return { x, y };
}

/** Affine point addition on P-256; `null` is the point at infinity. */
function add(P, Q) {
  if (P === null) return Q;
  if (Q === null) return P;
  let lambda;
  if (P.x === Q.x) {
    if (mod(P.y + Q.y) === 0n) return null;
    lambda = mod((3n * P.x * P.x + A) * inv0(2n * P.y));
  } else {
    lambda = mod((Q.y - P.y) * inv0(Q.x - P.x));
  }
  const x = mod(lambda * lambda - P.x - Q.x);
  return { x, y: mod(lambda * (P.x - x) - P.y) };
}

/** hash_to_curve (RFC 9380 §3), random-oracle encoding; h_eff = 1. */
export function hashToCurveP256(msg, dst) {
  const [u0, u1] = hashToFieldP256(msg, dst, 2);
  const P = add(mapToCurve(u0), mapToCurve(u1));
  if (P === null) throw new Error("hash_to_curve: point at infinity");
  return P;
}

const coordinate = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex").toString("base64url");

/**
 * The placeholder public key of a revoked entry whose original key has the
 * RFC 7638 thumbprint `thumbprint`, as a JWK with the members in the order the
 * DID documents use.
 */
export function revokedPlaceholder(thumbprint) {
  const P = hashToCurveP256(thumbprint, REVOKED_DST);
  return { crv: "P-256", kty: "EC", x: coordinate(P.x), y: coordinate(P.y) };
}
