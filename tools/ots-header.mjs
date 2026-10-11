// Reads the digest an OpenTimestamps proof commits to: the file digest in the
// proof's header. Nothing beyond the header is parsed, and Bitcoin is not
// consulted; full verification of a proof is the job of an OpenTimestamps
// client, in the procedure published on /doc/keyrevocationrecords.

// "\x00OpenTimestamps\x00\x00Proof\x00" followed by 8 magic bytes.
const MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");
const VERSION = 0x01;
const OP_SHA256 = 0x08;

/**
 * The 32-byte SHA-256 digest that a detached timestamp file commits to.
 * Throws on anything that is not a version-1 proof over a SHA-256 digest.
 */
export function otsDigest(file) {
  const b = Buffer.from(file);
  if (b.length < MAGIC.length + 2 + 32 || !b.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error("not an OpenTimestamps proof");
  if (b[MAGIC.length] !== VERSION) throw new Error(`unsupported OpenTimestamps version ${b[MAGIC.length]}`);
  if (b[MAGIC.length + 1] !== OP_SHA256) throw new Error("the proof is not over a SHA-256 digest");
  return b.subarray(MAGIC.length + 2, MAGIC.length + 2 + 32);
}
