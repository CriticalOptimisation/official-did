Revocation records of this DID's revoked keys, one <thumbprint>.json per key,
with the key's timestamp proofs under <thumbprint>/. They are written by
tools/make-did.mjs and found through the `service` entry of type
KeyRevocationRecords in /.well-known/did.json.

The format, and how to check a credential signed by a revoked key:
/doc/KeyRevocationRecords
