# official-did

The official DID document of Natixar: `did:web:natixar.pro`.

A `did:web` identifier resolves to an HTTPS address. `did:web:natixar.pro`
resolves to **https://natixar.pro/.well-known/did.json**, and that document
carries the public keys with which anyone can verify a credential signed by
Natixar — **without asking Natixar anything**.

## Why this repository exists on its own

- **The document must outlive our servers.** It is served by Netlify, not by
  Natixar's own infrastructure, so that credentials stay verifiable while our
  servers are down, migrating, or gone.
- **It is public by nature.** It contains public keys only. Keeping it apart
  from any product repository means it can be public without exposing anything
  else.
- **Its write access can be narrow.** A key rotation run by a back-end server
  needs to push to this repository and to nothing else. A deploy key attached
  to this repository alone gives exactly that, and nothing more.

## Layout

| Path | Role |
|---|---|
| [`did.config.json`](did.config.json) | this site's own values: the DID. The tools read it; no code names a site |
| [`public/.well-known/did.json`](public/.well-known/did.json) | the DID document, as served |
| [`public/revocations/`](public/revocations/) | the revocation records of revoked keys, and their timestamp proofs |
| [`public/doc/KeyRevocationRecords.html`](public/doc/KeyRevocationRecords.html) | **the** description of revocation records and of how to check a suspect credential, indexed, readable without a GitHub account |
| [`public/_headers`](public/_headers) | response headers: media type, CORS, no caching, no indexing outside `/doc/` |
| [`public/robots.txt`](public/robots.txt), [`public/sitemap.xml`](public/sitemap.xml) | crawlers may fetch `/doc/` only |
| [`public/index.html`](public/index.html) | human visitors are redirected to natixar.com |
| [`netlify.toml`](netlify.toml) | Netlify publishes `public/` after the deploy-time check |
| [`tools/make-did.mjs`](tools/make-did.mjs) | generates, extends, revokes and checks the document |
| [`tools/publish.sh`](tools/publish.sh) | applies one change and pushes it to `main`, retrying from the new head when another tool published first |
| [`tools/netlify-build.sh`](tools/netlify-build.sh) | the deploy-time check: nothing goes live that drops or alters a key |
| [`tools/hash-to-curve.mjs`](tools/hash-to-curve.mjs) | RFC 9380 hash-to-curve for P-256: the placeholder of a revoked key |
| [`tools/ots-header.mjs`](tools/ots-header.mjs) | reads the digest an OpenTimestamps proof commits to |
| `tools/*.test.mjs` | the cases each of them must decide |

## Rules

**1. The document is generated, never hand-written.** `tools/make-did.mjs`
derives each key's fragment from the key itself (its RFC 7638 thumbprint), so
the document and the signer cannot drift apart. The private key reaches the tool
through **stdin** and never touches the disk. The DID comes from
`did.config.json`.

```bash
<command that prints the private JWK> | node tools/make-did.mjs --from-private - --append
```

`--also-key-name <name>` publishes the same key a second time under the
fragment `#<name>`, for signers that name their key instead of deriving the
fragment from it; `--also-key-name next` takes the next free `key-<n>`. A name
designates one key for good, even after that key is revoked.

**2. No key entry ever disappears.** Removing a key would make every credential
it ever signed unverifiable, and indistinguishable from a forgery. So:

- a **rotation adds** the new key (`--append`). Existing entries are kept byte
  for byte, and a write that would drop or alter one is refused;
- a **compromised key is revoked**, not removed (`--revoke <thumbprint>
  --compromised-after <time>`). Its entries stay, marked `revoked` (W3C
  Controlled Identifiers v1.0), and their public key is replaced by a point
  nobody can sign for, so that even verifiers that ignore `revoked` reject
  it. The original key moves to a **revocation record** under
  `/revocations/`, found through the document's `service` entry. Revoking
  the last active key is allowed: a compromised key is revoked at once,
  successor or not;
- credentials signed before the compromise can still be shown good, and
  re-issued: see **[/doc/KeyRevocationRecords](https://natixar.pro/doc/KeyRevocationRecords)**,
  the published description of the records and of the checking procedure.

**3. Nothing goes live that breaks rule 2.** Netlify's build runs
`tools/netlify-build.sh`. It checks the document, fetches the **live**
document and records, and refuses any build that drops or alters a key,
changes a revocation other than by moving `compromisedAfter` earlier, or
removes an anchor. A refused production build leaves the live site as it is.
A refused Deploy Preview fails the required check of the PR.

**4. Tools publish through `tools/publish.sh`.** It fetches, resets to
`origin/main`, applies one `make-did.mjs` operation, checks the result, and
pushes. A push rejected as non-fast-forward means another tool published
first: it starts again from the new head, after a random pause, for as long
as it takes, and logs `publish: still retrying after <k> rejected pushes` every
`DID_PUBLISH_ALERT_EVERY` attempts (default 10), on stderr and to syslog.
Any other failure stops it at once. It uses the git credentials of its
environment, the calling tool's own deploy key, and never holds a secret.

**5. Nothing is cached.** `public/_headers` serves the document and the
records with `Cache-Control: max-age=0, must-revalidate`, so a rotation or a
revocation is visible at once, and with `Access-Control-Allow-Origin: *`,
because verifiers resolve the DID from a browser on another origin. Without
that header the read fails silently.

## Not indexed, except `/doc/`

natixar.pro serves a document for machines, not pages for people. None of it
should appear in search results or web archives, **except `/doc/`**: the
documentation for people, such as how to check by yourself a credential signed
by a key that has since been revoked.

- [`public/robots.txt`](public/robots.txt) asks every crawler to fetch nothing
  but `/doc/`.
- `public/_headers` sends `X-Robots-Tag: noindex, nofollow, noarchive` on every
  path outside `/doc/`. robots.txt is only a request, and a URL already known
  from a link can be indexed without being fetched. The header tells crawlers
  that do fetch not to index, follow or archive.
- Netlify cannot exclude one path from a `/*` rule, and crawlers obey the most
  restrictive of two `X-Robots-Tag` headers. So `_headers` names its
  non-indexed paths one by one. **A file added outside `/doc/` needs its own
  rule**: `tools/site.test.mjs` checks every file under `public/`, and fails
  on a file that is missing one.

DID resolution is unaffected: resolvers fetch `/.well-known/did.json` directly
and read neither. This governs natixar.pro only. The pages of this repository on
github.com are indexed under GitHub's own policy, which nothing here changes.

## Checks

```bash
node tools/make-did.mjs --verify-file public/.well-known/did.json
node --test tools/*.test.mjs
```

`site.test.mjs` reads `public/` as Netlify publishes it. It checks that
robots.txt allows `/doc/` and nothing else, that every served file outside
`/doc/` gets `X-Robots-Tag` and nothing under `/doc/` does, and the headers
every rule of `_headers` gives `/.well-known/did.json` and the records, taken
together: the media type, CORS and no caching. It also refuses a header set by
two rules for the same path, since both values would be sent.

`--verify-file` needs no secret, so it is the check the deploy-time build runs.
It refuses a fragment that has the *shape* of a thumbprint without being one, a
`controller` that does not designate the document, a private member `d` (a
published private key is burnt), an `assertionMethod` without a matching
method, and a document where no key is addressable by its thumbprint. For a
revoked entry, it requires the exact placeholder key and a consistent
revocation record, whose proof files commit to the roots they claim. It does
not check Bitcoin or a timestamp authority: the procedure on
`/doc/KeyRevocationRecords` and the external monitor do. With
`--previous <site>`, it also refuses anything that is not an extension of
that earlier state. A document with no active key is a warning, not a fault.

What it cannot catch: a consistent document built on a key nobody holds. Only
`--check`, with the private key, says that, so it cannot run in CI:

```bash
<command that prints the private JWK> | node tools/make-did.mjs --from-private - --check
```

## Publication

Netlify publishes `public/` on every push to `main` that touches `public/`,
`netlify.toml` or the tools the build runs, once `tools/netlify-build.sh` has
passed. Nothing is generated at build time.
