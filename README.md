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
| `main` | all the code, the shared files of the site, the templates, this documentation, and the variables of each domain's project. **The code names no domain**: only `netlify-env-public/` and the test data of `tools/fixtures/` do. | reviewed pull requests only |
| `data/<domain>` | that domain's DID document and revocation records, and nothing else | `tools/publish.sh`, run by a repository admin until #9 (see *Write access*) |

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
   site**, `$URL`, after checking that the host name of `$URL` is
   `DID_DOMAIN`.

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
disagree. It is a host name: Netlify serves no other port than 443, so a
`did:web` with a port has no place here.

`DID_LOG` is read by `tools/make-did.mjs` only, on the publishing server: the
build does not use it. It is recorded with the other variables so that one
file says how a domain is set up.

#### `netlify-env-public/`: the variables of every domain, on `main`

The variables of each served domain are tracked on `main`, one file per
domain, `netlify-env-public/<domain>.env`, and loaded into the domain's
Netlify project as described in *Loading a file into its project*, below.

The folder's name is a warning: **everything in it is public**. It is on
GitHub, on every branch that carries it, as soon as it is pushed, and its
values are on the domain's site: `DID_DOMAIN` everywhere, `DID_REDIRECT` in
`index.html`. The build does not serve the files themselves. The variables
hold no secret, and no secret may ever be written there.

The format leaves a secret no field to hide in:

- the file is named `<DID_DOMAIN>.env`, and nothing but `*.env` files can be
  tracked in the folder (`.gitignore`);
- every line is `KEY=VALUE`, split at the first `=`: no comment, no blank
  line, no `export`, no carriage return. The value is one character or more,
  none of them a blank, a control character, a quote (`"`, `'`, `` ` ``) or a
  backslash: a host name or a URL needs none, and the `.env` format would
  read them. So a trailing space, which `new URL()` would silently drop, makes
  the line a fault (`not KEY=VALUE`), and so does a value in quotes. The final
  newline may be left out;
- the keys are those that
  [`tools/netlify-env-keys.txt`](tools/netlify-env-keys.txt) lists as
  `required` (each once) or `optional` (at most once). Any other key is refused,
  whether that list names it as `prohibited`, with the reason, or not at all;
- `DID_DOMAIN` is a lower-case host name; `DID_REDIRECT`, and `DID_LOG` when
  present, are `http(s)` URLs without user information (`https://user:pass@…`).

`tools/netlify-env-keys.txt` is the versioned reference of the keys: one key
per line, its status, and for a `prohibited` key the reason. It names the
dangerous keys known so far, such as `DID_ALLOW_NO_PREVIOUS`, which is set by
hand for one deploy and never recorded, or the build hook of a publisher,
whose URL is a capability. A key is added to it by a reviewed pull request.

What the format cannot catch is a token in the query string of a URL: a
redirect may need one. The review must.

Changing a variable: change the file through a pull request, then load it
again once merged. Loading merges into the project's variables: a key removed
from the file stays in the project until it is deleted there by hand.

#### Loading a file into its project

No tool of this repository calls the Netlify CLI, and none needs it: the build
runs on Netlify, and the publisher calls a build hook. Loading the variables
is a maintainer step, done once per domain and again after each change.

**In the Netlify UI** (the usual way; nothing to install). In the domain's
project:

1. *Project configuration > Environment variables*, then *Add a variable >
   Import from a .env file*.
2. Paste the content of `netlify-env-public/<domain>.env` from `main`, as it
   is: its format is the `.env` format.
3. Scopes: all scopes. Deploy contexts: the same value for all deploy contexts;
   the Deploy Preview of every pull request needs the variables too.
4. If a key already exists, the form shows a *Merge strategy*: choose
   *Update conflicts*, so that the file's values replace the project's.
5. *Import variables*. The values apply from the next build.

A key removed from the file is deleted on the same page, from the key's own
options.

**With the API and `curl`** (to compare, or to script). The Netlify API
serves the variables of a project under `https://api.netlify.com/api/v1/`,
authenticated by a personal access token (*User settings > Applications >
Personal access tokens*). The token is a secret: keep it in your shell only,
never in a file of the clone, and never in `netlify-env-public/`, whose
checker refuses `NETLIFY_AUTH_TOKEN`. `<project id>` is the *Project ID* of
*Project configuration > General*.

```bash
read -rs NETLIFY_AUTH_TOKEN && export NETLIFY_AUTH_TOKEN   # paste the token; nothing is echoed
API=https://api.netlify.com/api/v1
SITE=<project id>
auth="Authorization: Bearer $NETLIFY_AUTH_TOKEN"

# Read: every variable of the project, to compare with its file (changes nothing).
curl -sf -H "$auth" "$API/sites/$SITE/env"

# The project's team, needed by the writing calls: the "account_slug" field.
curl -sf -H "$auth" "$API/sites/$SITE"
ACCOUNT=<account_slug>

# Write one key that the project does not have yet:
curl -sf -X POST -H "$auth" -H 'Content-Type: application/json' \
  "$API/accounts/$ACCOUNT/env?site_id=$SITE" \
  --data '[{"key":"DID_REDIRECT","values":[{"context":"all","value":"https://www.example.com/"}]}]'

# Replace all the values of a key that it has:
curl -sf -X PUT -H "$auth" -H 'Content-Type: application/json' \
  "$API/accounts/$ACCOUNT/env/DID_REDIRECT?site_id=$SITE" \
  --data '{"key":"DID_REDIRECT","values":[{"context":"all","value":"https://www.example.com/"}]}'

# Delete a key removed from the file:
curl -sf -X DELETE -H "$auth" "$API/accounts/$ACCOUNT/env/DID_LOG?site_id=$SITE"
```

The values go inside a JSON string: they hold no `"` or `\`, since they are
host names and URLs that the checker accepts. These calls follow Netlify's API
reference (`getSiteEnvVars`, `createEnvVars`, `updateEnvVar`, `deleteEnvVar`);
the `scopes` field is left out, so a variable gets every scope.

**With the Netlify CLI** (optional). It is the npm package `netlify-cli`,
which needs Node.js 22.13 or later and, with `npx`, no installation by a
package manager: `npx netlify-cli login`, then, from a clone linked to the
project (`npx netlify-cli link`),
`npx netlify-cli env:import netlify-env-public/<domain>.env`. It sets every
key to all scopes and all deploy contexts, and merges. Never add
`--replace-existing`: it deletes every variable the file does not name,
`DID_ALLOW_NO_PREVIOUS` included.

#### Checking a file before it leaves your clone

[`tools/check-netlify-env.mjs`](tools/check-netlify-env.mjs) applies the
rules above:

```bash
node tools/check-netlify-env.mjs <file>...   # the files given
node tools/check-netlify-env.mjs --staged    # what the index holds under netlify-env-public/
```

Each fault is one line on stderr, `FAULT <path>: <reason>`, and the exit
code is `1`; nothing is printed and the exit code is `0` when every file
passes. Every fault of every file is reported, the faults of the lines first,
in order, then those of the file. With `--staged`, it reads each staged file under
`netlify-env-public/` from the index (`git show :<path>`), so it checks what
will be committed, not the working copy; a staged file of the folder that is
not named `*.env` (added with `git add -f`) is a fault too, and a deleted file
is not checked. The reasons:

- `FAULT <path>: not named <DID_DOMAIN>.env`, with the value of `DID_DOMAIN`, when the file's name is not that value followed by `.env`;
- `FAULT <path>:<n>: not KEY=VALUE`, for a comment, a blank line, an `export`, a carriage return, or any other line;
- `FAULT <path>:<n>: <KEY> is prohibited: <reason>`, with the reason from the reference list;
- `FAULT <path>:<n>: <KEY> is not an allowed key`;
- `FAULT <path>:<n>: <KEY> given twice`;
- `FAULT <path>: <KEY> missing`, for a required key;
- `FAULT <path>: DID_DOMAIN <value> is not a lower-case host name`;
- `FAULT <path>: <KEY> <value> is not an http(s) URL`, or `FAULT <path>: <KEY> holds user information`.

`<DID_DOMAIN>` stands for the value when the file has none and is not named
`*.env` directly in the folder.

A missing argument, `--staged` with a file, an unreadable file, an unreadable
or malformed reference list, or a failed `git` command (`--staged` outside a
work tree) is a usage error, one line `check-netlify-env: <reason>`, exit `2`.

[`tools/git-hooks/pre-commit`](tools/git-hooks/pre-commit) runs it with
`--staged` before every commit, and refuses the commit on a fault. Enable it
once per clone; the worktrees of the clone share the setting:

```bash
git config core.hooksPath tools/git-hooks
```

Its limits: it is a setting of your clone, not of the repository; `git commit
--no-verify` skips it; commits that git makes without running `pre-commit`,
by `cherry-pick` or `rebase`, are not checked; and a worktree whose branch
predates the hook has no hook to run. The repository's **push protection**
and secret scanning are the server-side line: they block known token formats
at push time. A secret that reaches GitHub anyway must be **rotated**:
deleting it does not unpublish it.

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
| `Data branches` | `data/**` | restrict creations, updates and deletions; linear history; no force-push | repository admins (deploy keys: removed until #9) |

So **no deploy key can change the code or the deploy-time check**: they are
on `main`, which takes reviewed pull requests only.

**Autonomous publishing by deploy keys is temporarily disabled.** The design
gives each publishing server its own deploy key, named after its domain
(`publisher example.org`), and lets deploy keys fast-forward the data
branches. Since #21 publishes the attestation keys under `authentication`
too, a stolen deploy key could add a key that signs in as any domain. So,
until #9 gives each domain a credential that only its own branch accepts,
deploy keys are removed from the bypass of `Data branches`: a repository admin
runs `tools/publish.sh`, and no `publisher <domain>` key is created. A deploy
key left with write access can still push branches outside `main` and
`data/**`, which nothing deploys; delete the unused ones.

Also set in the repository: default workflow permissions **read**, and Actions
not allowed to create or approve pull requests. A data branch could carry a
workflow file, and GitHub would run it. With these settings and no repository
secret, such a workflow can neither write to `main` nor propose a change to
it. The build refuses that data branch anyway (step 3).

**Residual risk.** While deploy keys are out of the bypass, no deploy key can
write to a data branch; the writers are the repository admins, behind their
own login. The risk below returns, larger, if deploy keys are put back before
#9: an added key would then also be an `authentication` key, able to sign in
as the domain, and such sign-ins leave no durable trace.

With deploy keys in the bypass, a deploy key of one domain can push to another
domain's data branch. The tools stop mistakes: `publish.sh` writes only to
`data/$DID_DOMAIN`, the other domain's build refuses anything that is not its
data, and the check against its live site refuses any dropped or altered
entry. Nothing in this repository stops a **stolen** key from **adding** a key
to another domain's document. Removing that risk requires one credential per
domain that only its own branch accepts, such as one GitHub App per domain,
each the only bypass of its own `data/<domain>` ruleset: #9.

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
| [`tools/check-netlify-env.mjs`](tools/check-netlify-env.mjs) | checks the files of `netlify-env-public/` |
| [`tools/netlify-env-keys.txt`](tools/netlify-env-keys.txt) | the reference of the keys a file of `netlify-env-public/` may, must or must never hold |
| [`tools/git-hooks/pre-commit`](tools/git-hooks/pre-commit) | refuses a commit whose files of `netlify-env-public/` fail the check |
| `tools/*.test.mjs` | the cases each of them must decide |
| `netlify-env-public/<domain>.env` | the variables of a domain's Netlify project; with `tools/fixtures/`, the only tracked files that may name a real domain |
| `tools/fixtures/` | test data. `tools/fixtures/<first domain>/` holds the pages and the variables that domain was served with before the move to a data branch: the frozen input of a regression test, not the record of its variables |

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

**`authentication` is, for now, a copy of `assertionMethod`.** The keys
attest (`assertionMethod`). So that the DID can also authenticate its
controller (sign in to a service, answer a challenge), the tool publishes the
same entries, in the same order, under `authentication`. This is a temporary
copy of the attestation keys (#21), superseded by #16, which will decide
whether authentication gets keys of its own. `--verify-file` refuses a
document whose `authentication` is anything else; a document without the list,
as published before this change, is accepted, and `--normalize` adds it.

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
- **revocation is temporarily disabled**, until #16 decides what a revoked
  key means for `authentication`: `--revoke` is refused unless `--emergency`
  is also given. With `--emergency`, a compromised key is revoked as above,
  and its entries stay in both `assertionMethod` and `authentication`, with
  the placeholder key nobody can sign for. `publish.sh` records the
  arguments, `--emergency` included, in the commit message of the data
  branch;
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
git credentials of its environment and never holds a secret. Until #9, those
are a repository admin's: **autonomous publishing by deploy keys is
temporarily disabled** (see *Write access*).

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
| `URL` | set by Netlify: the project's production URL, whose live state is compared. Its host name must be `DID_DOMAIN`; a port, if any, is not compared |
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
- `netlify-build: DID_DOMAIN <domain> is not a lower-case host name`
- `netlify-build: DID_REDIRECT is not set`
- `netlify-build: URL is not set`, or `netlify-build: URL <url> is not a URL`
- `netlify-build: URL host <host> is not DID_DOMAIN <domain>`
- `netlify-build: no branch data/<domain> in <repository>`

The data branch is extracted with `git archive`, and the branch's own
`.gitattributes` is overridden, so that it can neither hide a file from the
check of step 3 nor rewrite one. Each build starts from an empty `DID_DIST`.

### `tools/build-site.mjs`

```bash
DID_DOMAIN=example.org DID_REDIRECT=https://www.example.com/ \
  node tools/build-site.mjs --data <data tree> --out <dist> [--public <dir>]
```

`--public` defaults to the repository's `public/`. `--out` must not exist,
and nothing is written outside it, nor anything at all when the build is
refused. Each refusal is one line, `FAULT <path>: <reason>`, and the exit
code is `1`:

- `FAULT <path>: not a data file`, for any file other than the data paths;
- `FAULT <path>: not a regular file`, for a symbolic link, even at a data path;
- `FAULT .gitignore: missing`, or `FAULT .gitignore: differs from tools/data-branch.gitignore`;
- `FAULT .well-known/did.json: missing`, `not JSON`, or `id is <id>, not did:web:<domain>`;
- `FAULT <path>: both a data file and a file of <public>`: a data file never replaces a shared one;
- `FAULT <template>: {{<NAME>}} left unfilled`.

In `.html` and `.xml` files, the values are escaped for HTML. A missing
variable or argument, a `DID_DOMAIN` that is not a lower-case host name, a
`DID_REDIRECT` that is not an `http(s)` URL, and an existing `--out` are
usage errors, exit `2`.

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
nothing pushed; `2` a usage error (`publish: <VARIABLE> is not set`); `3`
**published, not deployed**: the push was accepted, but the build hook failed
(`publish: published <sha>, not deployed: build hook failed (<reason>)`).

Each round starts from a clean copy of the remote head: files left in the
working copy, ignored ones included, are removed. A change outside the data
paths, such as a record written where a moved `service` endpoint points, is
refused: `publish: <path> is not a data path, not published`, exit `1`.

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
`DID_PREVIOUS_DIR` when that is set. It refuses, exits `1` and creates
nothing when:

- a file differs: `data-branch: <path> differs from the live state`;
- the live site serves a data file that the source lacks:
  `data-branch: <path> is live but missing from <source site>`;
- a data path of the source is a link: `data-branch: <path> is not a regular file`;
- the branch exists: `data-branch: data/<domain> already exists in <clone>`.

It leaves the clone's `HEAD`, index and working tree as they are. A
`<domain>` that is not a lower-case host name is a usage error, exit `2`.

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
3. **The variables.** Through a pull request to `main`, add
   `netlify-env-public/<domain>.env` with `DID_DOMAIN`, `DID_REDIRECT` and, if
   used, `DID_LOG`, and add the domain to the list of real domains of
   `tools/site.test.mjs`. This step may come before step 2: nothing reads the
   file until a project imports it, and a project whose data branch does not
   exist yet fails its build (`no branch data/<domain>`) without changing
   anything live.
4. **The Netlify project.** Create it from this repository, with production
   branch `main`. Leave its build settings empty: `netlify.toml` on `main`
   gives them. Once step 3 is merged, load
   `netlify-env-public/<domain>.env` into it (*Loading a file into its
   project*: in the Netlify UI, *Import from a .env file*). Add
   `DID_ALLOW_NO_PREVIOUS=1` by hand, in the UI, for the **first deploy
   only**: it is never in the file.
5. **The custom domain.** Attach `<domain>` to the project, and wait until
   Netlify serves a valid certificate for it.
6. **First deploy.** Trigger it. Then **remove `DID_ALLOW_NO_PREVIOUS`** and
   trigger a second deploy, which must pass the check against the first.
7. **Resolution.** `curl -sI https://<domain>/.well-known/did.json` answers
   `200`, `content-type: application/did+json` and
   `access-control-allow-origin: *`.
8. **The publisher.** Create a build hook for the project. Until #9, a
   repository admin publishes, with a single-branch clone of `data/<domain>`,
   the hook URL and `DID_DOMAIN`; no deploy key is created (see *Write
   access*). Once #9 lands, the publishing server gets the domain's own
   credential instead.
9. **The required check.** Add the project's Deploy Preview check,
   `netlify/<project>/deploy-preview`, to the required checks of `Protect main`.

## Moving a single-domain deployment to a data branch

For a domain that was served from `public/` on `main` before this layout:

1. `tools/data-branch.sh init <domain> <clone> public` from `main` before the
   change. It refuses unless every copied file is identical to the live one.
   A maintainer pushes the branch.
2. Load the domain's `netlify-env-public/<domain>.env` into its project
   (*Loading a file into its project*). The old build ignores these variables.
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
`tools/fixtures/` and `netlify-env-public/` names a real domain: its list of
real domains, built from parts so that the test does not name them, must be
exactly the domains of `netlify-env-public/`. Finally, it checks that no script
of the repository (a `*.sh` file, a hook of `tools/git-hooks/`, or a file
starting with `#!`) calls the Netlify CLI (`netlify`, `ntl`, `netlify-cli`):
only Netlify's runner, which reads `netlify.toml`, has it.

`check-netlify-env.test.mjs` checks the files of `netlify-env-public/`: the
folder admits only `*.env` files; every tracked file passes
`tools/check-netlify-env.mjs`; every file builds a site with `build-site.mjs`,
so its values pass the build's own checks; the reference list of keys is
well formed; the checker refuses each prohibited key of that list, any
unlisted key and every malformed line; and the `pre-commit` hook refuses a
commit that fails the check.

`--verify-file` needs no secret, so it is the check the deploy-time build runs.
It refuses a fragment that has the *shape* of a thumbprint without being one, a
`controller` that does not designate the document, a private member `d` (a
published private key is burnt), an `assertionMethod` without a matching
method, an `authentication` list that is not exactly `assertionMethod` (same
entries, same order: `FAULT authentication differs from assertionMethod (a
temporary copy until #16)`), and a document where no key is addressable by its
thumbprint. For a
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

<!--
Change History

| PR  | Summary |
|-----|---------|
| #10 | several domains: code on main, data on one orphan branch per domain (#8) |
| #13 | the variables of every domain tracked in netlify-env-public/ (#11) |
| #22 | authentication, a temporary copy of assertionMethod; revocation behind --emergency; deploy keys out of the data-branch bypass until #9 (#21) |
-->
