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
| [`public/.well-known/did.json`](public/.well-known/did.json) | the DID document, as served |
| [`public/_headers`](public/_headers) | response headers: media type, CORS, no caching, no indexing |
| [`public/robots.txt`](public/robots.txt) | crawlers are asked to fetch nothing |
| [`public/index.html`](public/index.html) | human visitors are redirected to natixar.com |
| [`netlify.toml`](netlify.toml) | Netlify publishes `public/`, builds nothing |
| [`tools/make-did.mjs`](tools/make-did.mjs) | generates and checks the document |
| [`tools/make-did.test.mjs`](tools/make-did.test.mjs) | the cases the check must decide |
| [`tools/site.test.mjs`](tools/site.test.mjs) | what `public/` declares to crawlers and resolvers |

## Three rules

**1. The document is generated, never hand-written.** `tools/make-did.mjs`
derives each key's fragment from the key itself (its RFC 7638 thumbprint), so
the document and the signer cannot drift apart. The private key reaches the tool
through **stdin** and never touches the disk:

```bash
<command that prints the private JWK> \
  | node tools/make-did.mjs --from-private - --also-key-name key-1
```

`--also-key-name key-1` publishes the same key a second time under the
fragment `#key-1`, for signers that name their key instead of deriving the
fragment from it. A credential signed under either fragment verifies against
this document.

**2. The document is append-only.** Removing a key makes every credential it
ever signed unverifiable, at once and for good. A rotation **adds** the new key;
it never removes an old one. A key is removed only if it is compromised — and
then the credentials it signed *should* stop verifying.

> **Known gap.** `make-did.mjs` currently builds the document from **one** key.
> Run with a new key, it would write a document without the old one — exactly
> what rule 2 forbids. Until the tool can append, a rotation must not be done
> with it unattended. See the issues of this repository.

**3. Nothing is cached.** `public/_headers` serves the document with
`Cache-Control: max-age=0, must-revalidate`, so a rotation is visible at once,
and with `Access-Control-Allow-Origin: *`, because verifiers resolve the DID
from a browser on another origin. Without that header the read fails silently.

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
node --test tools/make-did.test.mjs
node --test tools/site.test.mjs
```

`site.test.mjs` reads `public/` as Netlify publishes it. It checks that
robots.txt allows `/doc/` and nothing else, that every served file outside
`/doc/` gets `X-Robots-Tag` and nothing under `/doc/` does, and the headers
every rule of `_headers` gives `/.well-known/did.json`, taken together: no
indexing, and still the media type, CORS and no caching. It also
refuses a header set by two rules for the same path, since both values would
be sent.

`--verify-file` needs no secret, so it is the check continuous integration can
run. It refuses a fragment that has the *shape* of a thumbprint without being
one, a `controller` that does not designate the document, a private member `d`
(a published private key is burnt), an `assertionMethod` without a matching
method, and a document where no key is addressable by its thumbprint.

What it cannot catch: a consistent document built on a key nobody holds. Only
`--check`, with the private key, says that — so it cannot run in CI:

```bash
<command that prints the private JWK> \
  | node tools/make-did.mjs --from-private - --also-key-name key-1 --check
```

## Publication

Netlify publishes `public/` on every push to `main` that touches `public/` or
`netlify.toml`. Nothing is built.
