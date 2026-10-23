# official-did

The reference storage of the public keys of several `did:web` identifiers, one
per domain, and the tools that publish them safely.

A `did:web` identifier resolves to an HTTPS address: `did:web:example.org`
resolves to **https://example.org/.well-known/did.json**. That document
carries the public keys with which anyone can verify a credential signed by
the domain's owner, **without asking the owner anything**.

## Why this repository exists on its own

- **The documents must outlive their owners' servers.** They are served by
  Netlify, not by the owners' own infrastructure, so that credentials stay
  verifiable while those servers are down, migrating, or gone.
- **They are public by nature.** They contain public keys only. Keeping them
  apart from any product repository means they can be public without exposing
  anything else.
- **One code base for every domain.** The deploy-time check, the rules on
  revocation and the publishing tools are security controls. A fix to them
  reaches every domain in one reviewed pull request.

## Code on `main`, data on one branch per domain

The repository holds two kinds of content, on different branches:

| Branch | Holds | Written by |
|---|---|---|
| `main` | all the code, the shared files of the site, the templates, this documentation. **It names no domain.** | reviewed pull requests only |
| `data/<domain>` | that domain's DID document and revocation records, and nothing else | that domain's publishing tool, through `tools/publish.sh` |

A data branch is an **orphan** branch: it shares no history with `main` and
holds exactly these paths:

| Path | Content |
|---|---|
| `.well-known/did.json` | the DID document, as served |
| `revocations/<thumbprint>.json` | the revocation record of a revoked key |
| `revocations/<thumbprint>/<tree size>.ots`, `.tsr` | the timestamp proofs of the record's anchors |
| `.gitignore` | a byte-identical copy of [`tools/data-branch.gitignore`](tools/data-branch.gitignore): it ignores every other path, so that a tool cannot commit a stray file by mistake |

A data branch is never merged into `main`, never takes a pull request, and is
never checked out in a worktree of the SCM process.

### Each domain has its own Netlify project, which builds `main`

Every domain is served by its own Netlify project, and **every project builds
`main`**, never its data branch. Its build:

1. reads the domain from the project's `DID_DOMAIN` variable;
2. fetches `data/$DID_DOMAIN` from the repository into a temporary tree;
3. **refuses the tree** if it holds anything but the data paths above, if its
   `.gitignore` differs from `tools/data-branch.gitignore`, or if the
   document's `id` is not `did:web:$DID_DOMAIN`;
4. assembles the site in `dist/`: the shared files of `public/`, the
   templates filled in with the project's variables, and the data;
5. runs the deploy-time check (rule 3 below) against **that domain's own live
   site**, `$URL`, after checking that the host of `$URL` is `DID_DOMAIN`.

Netlify reads `netlify.toml` from the branch it builds, and that file takes
precedence over the project's own build settings. If a project built its data
branch, whoever can write to that branch could replace the build command and
switch the check off. Because projects build `main`, nothing on a data branch
is ever read as configuration: not a `netlify.toml`, a `_headers`, a
`_redirects`, nor a workflow. The checks of step 3 run in the build, whose
code comes from `main`, because the build is the only step that publishes.

A push to a data branch does not trigger Netlify by itself, since the project
builds `main`. `tools/publish.sh` calls the project's **build hook** after
each push. Netlify never cancels a build started by a hook.

### The project's variables

| Variable | Required | Example | Use |
|---|---|---|---|
| `DID_DOMAIN` | yes | `example.org` | the DID is `did:web:$DID_DOMAIN`; the data branch is `data/$DID_DOMAIN` |
| `DID_REDIRECT` | yes | `https://www.example.com/` | where `/` sends human visitors |
| `DID_LOG` | no | `https://log.example.org/` | the `log` written in new revocation records |

One value, `DID_DOMAIN`, names both the DID and the branch, so the two cannot
disagree. A port, as in `did:web:localhost%3A8443`, is written the same way in
`DID_DOMAIN`.

The variables hold no secret. Keep one file per domain, `env/<domain>.env`, in
the ignored `env/` directory of your clone, and load it into the domain's
project with the Netlify CLI, from a clone linked to that project:

```bash
netlify env:import env/example.org.env
```

### Templates

The files of `public/` that name the domain are templates. The build fills in
these placeholders:

| Placeholder | Value |
|---|---|
| `{{DID_DOMAIN}}` | `DID_DOMAIN` |
| `{{DID_REDIRECT}}` | `DID_REDIRECT` |
| `{{DID_REDIRECT_HOST}}` | the host of `DID_REDIRECT`, for link text |

A placeholder left unfilled fails the build. `public/_headers` and
`public/revocations/README.txt` name no domain, and are copied as they are.

### Write access

GitHub has no deploy key limited to one branch: a deploy key with write access
can write to every branch on which deploy keys bypass the rules. So the rules
are on the branches:

| Ruleset | Branches | Rules | Bypass |
|---|---|---|---|
| `Protect main` | `main` | pull request, review, linear history, no force-push, no deletion, the Deploy Preview of every project | none for deploy keys |
| `Data branches` | `data/**` | restrict creations, updates and deletions; linear history; no force-push | deploy keys, repository admins |

So **no deploy key can change the code or the deploy-time check**: they are
on `main`, which takes reviewed pull requests only. A deploy key can only
fast-forward an existing data branch.

Each publishing server has **its own deploy key**, named after its domain
(`publisher example.org`). The name does not limit the key. It designates the
key in GitHub's "last used" column and when the key is deleted.

Also set in the repository: default workflow permissions **read**, and Actions
not allowed to create or approve pull requests. A data branch could carry a
workflow file, and GitHub would run it. With these settings and no repository
secret, such a workflow can neither write to `main` nor propose a change to
it. The build refuses that data branch anyway (step 3).

**Residual risk.** A deploy key of one domain can still push to another
domain's data branch. The tools stop mistakes: `publish.sh` writes only to
`data/$DID_DOMAIN`, the other domain's build refuses anything that is not its
data, and the check against its live site refuses any dropped or altered
entry. Nothing in this repository stops a **stolen** key from **adding** a key
to another domain's document. Removing that risk requires one credential per
domain that only its own branch accepts, such as one GitHub App per domain,
each the only bypass of its own `data/<domain>` ruleset. This is a follow-up
issue.

### Why this layout

Three ways of keeping several domains in one repository were compared:

| | 1. A full branch per domain | 2. A folder per domain on `main` | 3. Code on `main`, data on a branch per domain (**chosen**) |
|---|---|---|---|
| A fix to the tools reaches every domain | one squashed PR per domain branch: linear history forbids merging `main` in, and no force-push forbids rebasing | one PR | one PR |
| Who can change the deploy-time check | any deploy key, on its branch | any deploy key, on `main` | only a reviewed PR |
| Isolation between domains | none against a deploy key | none against a deploy key | none against a stolen deploy key; the tools stop mistakes |
| Files that name the domain | stored per branch | generated from the project's variables | generated from the project's variables |
| SCM process | needs a policy for long-lived full branches | unchanged | data branches are never merged and take no PR |

Approach 3 is the only one in which a deploy key cannot touch the code that
checks what it publishes. One repository per domain, with the tools shipped as
a package, was set aside: every copy would need each fix.

## Layout of `main`

| Path | Role |
|---|---|
| [`public/doc/keyrevocationrecords.html`](public/doc/keyrevocationrecords.html) | template: **the** description of revocation records and of how to check a suspect credential, indexed, readable without a GitHub account |
| [`public/_headers`](public/_headers) | response headers: media type, CORS, no caching, no indexing outside `/doc/` |
| [`public/robots.txt`](public/robots.txt), [`public/sitemap.xml`](public/sitemap.xml) | templates: crawlers may fetch `/doc/` only |
| [`public/index.html`](public/index.html) | template: human visitors are redirected to `DID_REDIRECT` |
| [`public/revocations/README.txt`](public/revocations/README.txt) | what the records directory is, for a human who opens it |
| [`netlify.toml`](netlify.toml) | Netlify publishes `dist/` after the deploy-time check |
| [`tools/netlify-build.sh`](tools/netlify-build.sh) | the build: fetches the data branch, assembles the site, runs the deploy-time check |
| [`tools/build-site.mjs`](tools/build-site.mjs) | assembles `dist/` from `public/`, the variables and a data tree, and refuses a data tree that holds anything else |
| [`tools/make-did.mjs`](tools/make-did.mjs) | generates, extends, revokes and checks a document |
| [`tools/publish.sh`](tools/publish.sh) | applies one change to a data branch, pushes it, retries when another tool published first, then calls the build hook |
| [`tools/data-branch.sh`](tools/data-branch.sh) | creates the orphan commit of a new data branch |
| [`tools/data-branch.gitignore`](tools/data-branch.gitignore) | the `.gitignore` of every data branch |
| [`tools/fetch-live.mjs`](tools/fetch-live.mjs) | mirrors a live site's document and records, for the check |
| [`tools/hash-to-curve.mjs`](tools/hash-to-curve.mjs) | RFC 9380 hash-to-curve for P-256: the placeholder of a revoked key |
| [`tools/ots-header.mjs`](tools/ots-header.mjs) | reads the digest an OpenTimestamps proof commits to |
| `tools/*.test.mjs` | the cases each of them must decide |
| `tools/fixtures/` | test data; the only tracked files that may name a real domain |

## Rules

**1. The document is generated, never hand-written.** `tools/make-did.mjs`
derives each key's fragment from the key itself (its RFC 7638 thumbprint), so
the document and the signer cannot drift apart. The private key reaches the tool
through **stdin** and never touches the disk. The DID is `--did <did>`, or
else `did:web:$DID_DOMAIN`; there is no default. The `log` of a new
revocation record is `--log <url>`, or else `DID_LOG`. Run from a clone of a
data branch, whose root is the site:

```bash
<command that prints the private JWK> | DID_DOMAIN=example.org \
  node <main>/tools/make-did.mjs --site . --from-private - --append
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
  re-issued: see `/doc/keyrevocationrecords` on the domain's own site, the
  published description of the records and of the checking procedure.

**3. Nothing goes live that breaks rule 2.** Netlify's build runs
`tools/netlify-build.sh`. It checks the document, fetches the **live**
document and records of `$URL`, and refuses any build that drops or alters a
key, changes a revocation other than by moving `compromisedAfter` earlier, or
removes an anchor. A refused production build leaves the live site as it is.
A refused Deploy Preview fails the required check of the PR: every PR to
`main` is checked by every domain's project, against each domain's own live
state.

**4. Tools publish through `tools/publish.sh`.** It works in a clone of
`data/$DID_DOMAIN` only. It fetches, resets to the remote head, applies one
`make-did.mjs` operation, checks the result, commits the data paths only, and
pushes. A push rejected as non-fast-forward means another tool published
first: it starts again from the new head, after a random pause, for as long
as it takes, and logs `publish: still retrying after <k> rejected pushes` every
`DID_PUBLISH_ALERT_EVERY` attempts (default 10), on stderr and to syslog.
Any other failure stops it at once. Once the push is accepted, it calls the
build hook. If the hook fails, the change is on the branch but not live: it
logs an alert and exits `3`, and the caller calls the hook again. It uses the
git credentials of its environment, its server's own deploy key, and never
holds a secret.

**5. Nothing is cached.** `public/_headers` serves the document and the
records with `Cache-Control: max-age=0, must-revalidate`, so a rotation or a
revocation is visible at once, and with `Access-Control-Allow-Origin: *`,
because verifiers resolve the DID from a browser on another origin. Without
that header the read fails silently.

## The tools' interfaces

### `tools/netlify-build.sh` (the Netlify build command)

| Variable | Meaning |
|---|---|
| `DID_DOMAIN`, `DID_REDIRECT`, `DID_LOG` | the project's variables, above |
| `URL` | set by Netlify: the project's production URL, whose live state is compared. Its host must be `DID_DOMAIN` |
| `REPOSITORY_URL` | set by Netlify: the repository the data branch is fetched from |
| `DID_DATA_DIR` | a local data tree, used instead of fetching `data/$DID_DOMAIN` (tests, local builds) |
| `DID_PREVIOUS_DIR` | a local copy of the previous state, used instead of fetching `$URL` |
| `DID_ALLOW_NO_PREVIOUS` | `1` to deploy without a previous state: the first deploy of a new domain only, set by hand and removed after |
| `DID_DIST` | the output directory, default `dist` |
| `NODE` | default `node` |

It logs the data commit it built (`netlify-build: data/<domain> at <sha>`), and
ends with `netlify-build: OK` or a non-zero exit. The refusals before the
check print one line each:

- `netlify-build: DID_DOMAIN is not set`
- `netlify-build: DID_REDIRECT is not set`
- `netlify-build: URL host <host> is not DID_DOMAIN <domain>`
- `netlify-build: no branch data/<domain> in <repository>`

### `tools/build-site.mjs`

```bash
DID_DOMAIN=example.org DID_REDIRECT=https://www.example.com/ \
  node tools/build-site.mjs --data <data tree> --out <dist> [--public <dir>]
```

`--public` defaults to the repository's `public/`. It writes nothing outside
`--out`. Each refusal is one line, `FAULT <path>: <reason>`, and the exit
code is `1`:

- `FAULT <path>: not a data file`, for any file other than the data paths;
- `FAULT .gitignore: missing`, or `FAULT .gitignore: differs from tools/data-branch.gitignore`;
- `FAULT .well-known/did.json: id is <id>, not did:web:<domain>`;
- `FAULT <template>: {{<NAME>}} left unfilled`.

A missing variable or argument is a usage error, exit `2`.

### `tools/publish.sh`

```bash
DID_DOMAIN=example.org DID_PUBLISH_WORKDIR=<clone of data/example.org> \
DID_PUBLISH_BUILD_HOOK=https://api.netlify.com/build_hooks/<id> \
  tools/publish.sh <make-did.mjs arguments>
```

| Variable | Meaning |
|---|---|
| `DID_DOMAIN` | required; the branch is always `data/$DID_DOMAIN` |
| `DID_PUBLISH_WORKDIR` | required; a clone used by this script only, whose root is the site |
| `DID_PUBLISH_BUILD_HOOK` | required; the project's build hook, called with a `POST` after each accepted push |
| `DID_PUBLISH_ALERT_EVERY` | default 10 |
| `DID_PUBLISH_PAUSE_MAX` | longest random pause between rounds, in seconds; default 5 |
| `DID_PUBLISH_LOGGER` | a command called with each alert line; default `logger -t did-publish` when `logger` exists |
| `NODE` | default `node` |

Exit codes: `0` published and deployed, or nothing to publish; `1` a failure,
nothing pushed; `2` a usage error; `3` **published, not deployed**: the push
was accepted, but the build hook failed
(`publish: published <sha>, not deployed: build hook failed (<reason>)`).

### `tools/data-branch.sh`

```bash
tools/data-branch.sh init <domain> <clone> [<source site>]
```

It creates the local branch `data/<domain>` in `<clone>` as an orphan commit
and prints its SHA on stdout. **It pushes nothing**: a maintainer reviews the
commit and pushes it. Without `<source site>`, the commit holds only the
`.gitignore`, for a new domain. With `<source site>`, it copies the data paths
of that directory byte for byte. It first checks that each copied file is
identical to the one the live site serves, from `https://<domain>/`, or from
`DID_PREVIOUS_DIR` when that is set. If a file differs, it prints
`data-branch: <path> differs from the live state`, exits `1` and creates
nothing.

## Adding a domain

1. **Who serves the hostname.** One hostname belongs to one Netlify project.
   If the apex `<domain>` is attached to another project, detach it there
   first, and make sure nothing else must be served at that apex.
2. **The data branch.** In a clone: `tools/data-branch.sh init <domain> .`,
   then check out `data/<domain>` and create the first key there:
   `DID_DOMAIN=<domain> node <main>/tools/make-did.mjs --site . --new >`
   *(into the vault, never a file in the clone)*. Commit
   `.well-known/did.json`, then have a maintainer review and push the branch.
   The `Data branches` ruleset covers it at once.
3. **The variables.** Write `env/<domain>.env` with `DID_DOMAIN`,
   `DID_REDIRECT` and, if used, `DID_LOG`.
4. **The Netlify project.** Create it from this repository, with production
   branch `main`. Leave its build settings empty: `netlify.toml` on `main`
   gives them. Link a clone to it and run `netlify env:import env/<domain>.env`.
   Add `DID_ALLOW_NO_PREVIOUS=1` for the **first deploy only**.
5. **The custom domain.** Attach `<domain>` to the project, and wait until
   Netlify serves a valid certificate for it.
6. **First deploy.** Trigger it. Then **remove `DID_ALLOW_NO_PREVIOUS`** and
   trigger a second deploy, which must pass the check against the first.
7. **Resolution.** `curl -sI https://<domain>/.well-known/did.json` answers
   `200`, `content-type: application/did+json` and
   `access-control-allow-origin: *`.
8. **The publisher.** Create a build hook for the project. Give the
   publishing server its own deploy key with write access, titled
   `publisher <domain>`, a single-branch clone of `data/<domain>`, the hook URL,
   and `DID_DOMAIN`.
9. **The required check.** Add the project's Deploy Preview check,
   `netlify/<project>/deploy-preview`, to the required checks of `Protect main`.

## Moving a single-domain deployment to a data branch

For a domain that was served from `public/` on `main` before this layout:

1. `tools/data-branch.sh init <domain> <clone> public` from `main` before the
   change. It refuses unless every copied file is identical to the live one.
   A maintainer pushes the branch.
2. Import the domain's `env/<domain>.env` into its project. The old build
   ignores these variables.
3. The pull request that removes the data from `main` gets a Deploy Preview
   that runs the new build against the **live** site, without
   `DID_ALLOW_NO_PREVIOUS`. A lost or altered entry fails it.
4. After the merge, switch the publishing server to `tools/publish.sh` on the
   data branch, then remove the deploy-key bypass from `Protect main`.

## Not indexed, except `/doc/`

Each site serves a document for machines, not pages for people. None of it
should appear in search results or web archives, **except `/doc/`**: the
documentation for people, such as how to check by yourself a credential signed
by a key that has since been revoked.

- `robots.txt` asks every crawler to fetch nothing but `/doc/`.
- `public/_headers` sends `X-Robots-Tag: noindex, nofollow, noarchive` on every
  path outside `/doc/`. robots.txt is only a request, and a URL already known
  from a link can be indexed without being fetched. The header tells crawlers
  that do fetch not to index, follow or archive.
- Netlify cannot exclude one path from a `/*` rule, and crawlers obey the most
  restrictive of two `X-Robots-Tag` headers. So `_headers` names its
  non-indexed paths one by one. **A file added outside `/doc/` needs its own
  rule**: `tools/site.test.mjs` checks every file of the built site, and fails
  on a file that is missing one.

DID resolution is unaffected: resolvers fetch `/.well-known/did.json` directly
and read neither. This governs the domains' sites only. The pages of this
repository on github.com are indexed under GitHub's own policy, which nothing
here changes.

## Checks

```bash
node --test tools/*.test.mjs
```

The tests need no network. They use two fixture domains, `a.example.test` and
`b.example.test`, each with its own data branch in a local bare repository,
and stand in for the live sites with local HTTP servers.

`site.test.mjs` builds the site of a fixture domain, as Netlify would, and
reads the result. It checks that robots.txt allows `/doc/` and nothing else,
that every served file outside `/doc/` gets `X-Robots-Tag` and nothing under
`/doc/` does, and the headers every rule of `_headers` gives
`/.well-known/did.json` and the records, taken together: the media type, CORS
and no caching. It also refuses a header set by two rules for the same path,
since both values would be sent. And it checks that no tracked file outside
`tools/fixtures/` names a real domain.

`--verify-file` needs no secret, so it is the check the deploy-time build runs.
It refuses a fragment that has the *shape* of a thumbprint without being one, a
`controller` that does not designate the document, a private member `d` (a
published private key is burnt), an `assertionMethod` without a matching
method, and a document where no key is addressable by its thumbprint. For a
revoked entry, it requires the exact placeholder key and a consistent
revocation record, whose proof files commit to the roots they claim. It does
not check Bitcoin or a timestamp authority: the procedure on
`/doc/keyrevocationrecords` and the external monitor do. With
`--previous <site>`, it also refuses anything that is not an extension of
that earlier state. A document with no active key is a warning, not a fault.

What it cannot catch: a consistent document built on a key nobody holds. Only
`--check`, with the private key, says that, so it cannot run in CI:

```bash
<command that prints the private JWK> | DID_DOMAIN=<domain> \
  node tools/make-did.mjs --site <data clone> --from-private - --check
```
