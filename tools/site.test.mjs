// tools/site.test.mjs — what `public/` declares to crawlers and resolvers.
//
// Netlify publishes `public/` as it is: nothing is built, so these files ARE
// the behaviour. The tests read them as Netlify does, without network, and
// check that natixar.pro asks not to be indexed without breaking the headers a
// resolver needs on the DID document.
//
// Run with: node --test tools/site.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const DID_PATH = "/.well-known/did.json";

const read = (name) => readFile(join(PUBLIC, name), "utf8");

// The only part of natixar.pro that search engines may index: documentation
// for people, such as how to check a credential signed by a revoked key.
// Everything else is for machines and stays out of search results.
const INDEXABLE = ["/doc/"];
const indexable = (path) => INDEXABLE.some((prefix) => path.startsWith(prefix));

// Paths a crawler can reach under /doc/ once documentation is published
// there. Netlify serves `name.html` at `/name` too, so both forms count.
const DOC_SAMPLES = ["/doc/KeyRevocationRecords", "/doc/KeyRevocationRecords.html"];

/**
 * Every path Netlify serves from `public/`: one per file, `/` for index.html,
 * and the extensionless form of each `.html` file. `_headers` is Netlify's
 * configuration, not served.
 */
async function servedPaths() {
  const paths = [];
  for (const entry of await readdir(PUBLIC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = "/" + relative(PUBLIC, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (path === "/_headers") continue;
    paths.push(path);
    if (path === "/index.html") paths.push("/");
    else if (path.endsWith(".html")) paths.push(path.slice(0, -".html".length));
  }
  return paths;
}

/** robots.txt as groups: { agents: [...], rules: [[field, value], ...] }. */
function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      // Consecutive User-agent lines share one group.
      if (!current || current.rules.length) groups.push(current = { agents: [], rules: [] });
      current.agents.push(value);
    } else if (current) {
      current.rules.push([field, value]);
    }
  }
  return groups;
}

/** _headers as rules: [{ path, headers: [[name, value], ...] }], in file order. */
function parseHeaders(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ path: raw.trim(), headers: [] });
      continue;
    }
    const m = /^\s+([^:\s]+)\s*:\s*(.*)$/.exec(raw);
    assert.ok(m && rules.length, `unreadable _headers line: ${raw}`);
    rules.at(-1).headers.push([m[1].toLowerCase(), m[2].trim()]);
  }
  return rules;
}

/** Netlify path patterns: `*` matches anything, `:name` one segment. */
function matches(pattern, path) {
  const re = pattern
    .split(/(\*|:[A-Za-z_]\w*)/)
    .map((part) => part === "*" ? ".*"
      : part.startsWith(":") ? "[^/]+"
      : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("");
  return new RegExp(`^${re}$`).test(path);
}

/** Every header the rules give `path`, with the rule each came from. */
function headersFor(rules, path) {
  return rules
    .filter((rule) => matches(rule.path, path))
    .flatMap((rule) => rule.headers.map(([name, value]) => ({ name, value, rule: rule.path })));
}

// A header value is a comma-separated list of directives, each `name` or
// `name=value`. The checks below compare whole directives, never substrings:
// `noindexnofollownoarchive` is one unknown directive, not three, and
// `s-max-age=0` is not `max-age=0`.

/** Directives of a header value: Map of lower-cased name → value, or `true`. */
function directives(value) {
  const map = new Map();
  for (const item of value.split(",")) {
    const m = /^\s*([^=\s]+)\s*(?:=\s*(.*?))?\s*$/.exec(item);
    if (m) map.set(m[1].toLowerCase(), m[2] ?? true);
  }
  return map;
}

const NOT_INDEXED = ["noindex", "nofollow", "noarchive"];

/** The directives of NOT_INDEXED that an X-Robots-Tag value lacks. */
const robotsLacks = (value) => NOT_INDEXED.filter((d) => directives(value).get(d) !== true);

/** Whether a Cache-Control value forces revalidation on every read. */
function revalidatesEveryRead(value) {
  const d = directives(value);
  return d.get("max-age") === "0" && d.get("must-revalidate") === true;
}

// The checks themselves, against values that would fool a substring test.
// They pass before the change too: they test the test, not the site.
test("directive checks compare whole directives, not substrings", () => {
  for (const [value, lacks] of [
    ["noindex, nofollow, noarchive", []],
    ["NoIndex,nofollow , noarchive", []],
    ["noindexnofollownoarchive", NOT_INDEXED],
    ["noindex nofollow noarchive", NOT_INDEXED],
    ["noindex, nofollowed, xnoarchive", ["nofollow", "noarchive"]],
    ["noindex=1, nofollow, noarchive", ["noindex"]],
  ]) assert.deepEqual(robotsLacks(value), lacks, `X-Robots-Tag: ${value}`);

  for (const [value, ok] of [
    ["public, max-age=0, must-revalidate", true],
    ["must-revalidate,max-age=0", true],
    ["s-max-age=0, must-revalidate", false],
    ["max-age=0.5, must-revalidate", false],
    ["max-age=0, x-must-revalidate", false],
    ["max-age=0must-revalidate", false],
    ["max-age=00, must-revalidate", false],
  ]) assert.equal(revalidatesEveryRead(value), ok, `Cache-Control: ${value}`);
});

/**
 * Whether robots.txt lets a crawler without a group of its own fetch `path`,
 * per RFC 9309: the rules of every `User-agent: *` group count together; the
 * longest matching rule wins; `Allow` wins a tie; an empty `Disallow`
 * matches nothing; `*` matches any run of characters and a final `$`
 * anchors the end; no matching rule means allowed. Paths are case-sensitive.
 */
function robotsAllows(text, path) {
  let best = null;
  for (const [field, value] of parseRobots(text).filter((g) => g.agents.includes("*")).flatMap((g) => g.rules)) {
    if ((field !== "allow" && field !== "disallow") || value === "") continue;
    const anchored = value.endsWith("$");
    const pattern = (anchored ? value.slice(0, -1) : value)
      .split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    if (!new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path)) continue;
    const allow = field === "allow";
    if (!best || value.length > best.length || (value.length === best.length && allow))
      best = { length: value.length, allow };
  }
  return best ? best.allow : true;
}

// REVIEW PLACEHOLDER: "robots.txt asks every crawler to fetch nothing" -> "robots.txt lets crawlers fetch /doc/ and nothing else"
test("robots.txt lets crawlers fetch /doc/ and nothing else", async () => {
  const text = await read("robots.txt");
  for (const path of [...await servedPaths(), ...DOC_SAMPLES])
    assert.equal(robotsAllows(text, path), indexable(path), `robots.txt on ${path}`);
});

// REVIEW PLACEHOLDER: "/any/other/path is served with X-Robots-Tag: noindex, nofollow, noarchive" -> "every file served outside /doc/ gets X-Robots-Tag: noindex, nofollow, noarchive"
// A path that matches no file is a 404, which no engine indexes. It is no
// longer covered by a catch-all, since a catch-all `/*` would reach /doc/ too.
test("every file served outside /doc/ gets X-Robots-Tag: noindex, nofollow, noarchive", async () => {
  const rules = parseHeaders(await read("_headers"));
  const paths = (await servedPaths()).filter((path) => !indexable(path));
  assert.ok(paths.includes("/") && paths.includes(DID_PATH), `unexpected served paths: ${paths}`);
  for (const path of paths) {
    const found = headersFor(rules, path).filter((h) => h.name === "x-robots-tag");
    assert.equal(found.length, 1, `expected one X-Robots-Tag for ${path}, got ${found.length}`);
    assert.deepEqual(robotsLacks(found[0].value), [], `${path}: X-Robots-Tag: ${found[0].value}`);
  }
});

test("documentation under /doc/ is served without X-Robots-Tag", async () => {
  const rules = parseHeaders(await read("_headers"));
  for (const path of [...(await servedPaths()).filter(indexable), ...DOC_SAMPLES]) {
    const found = headersFor(rules, path).filter((h) => h.name === "x-robots-tag");
    assert.deepEqual(found, [], `${path} gets X-Robots-Tag from ${found.map((h) => h.rule)}`);
  }
});

test("the DID document keeps what a resolver needs, and is not indexed", async () => {
  const got = Object.fromEntries(
    headersFor(parseHeaders(await read("_headers")), DID_PATH).map((h) => [h.name, h.value]));
  assert.equal(got["content-type"], "application/did+json");
  assert.equal(got["access-control-allow-origin"], "*");
  assert.ok(revalidatesEveryRead(got["cache-control"] ?? ""), `Cache-Control: ${got["cache-control"]}`);
  assert.deepEqual(robotsLacks(got["x-robots-tag"] ?? ""), [], `X-Robots-Tag: ${got["x-robots-tag"]}`);
});

// A guard, not a discriminator: it passes before the change too. It refuses
// the one way of adding the header that would hurt — repeating, in a second
// rule, a header the DID document already gets, so that Netlify sends both.
test("no header reaches the DID document from two rules", async () => {
  const seen = new Map();
  for (const { name, rule } of headersFor(parseHeaders(await read("_headers")), DID_PATH)) {
    assert.ok(!seen.has(name), `${name} is set by both ${seen.get(name)} and ${rule}`);
    seen.set(name, rule);
  }
});

// --- edge cases ---------------------------------------------------------------

// REVIEW PLACEHOLDER: "robots.txt: look-alikes of `Disallow: /` are refused" -> "robots.txt: the evaluator follows RFC 9309, and look-alikes of the /doc/ exception are refused"
test("robots.txt: the evaluator follows RFC 9309, and look-alikes of the /doc/ exception are refused", () => {
  const site = "User-agent: *\nAllow: /doc/\nDisallow: /\n";
  for (const [text, path, allowed] of [
    [site, "/doc/KeyRevocationRecords", true],
    [site, "/doc/", true],
    [site, "/", false],
    [site, "/.well-known/did.json", false],
    [site, "/doc", false],
    [site, "/docs/KeyRevocationRecords", false],
    [site, "/document", false],
    [site, "/DOC/KeyRevocationRecords", false],
    ["User-agent: *\nDisallow: /\nAllow: /doc/\n", "/doc/x", true],
    ["User-agent: *\nDisallow: /\n", "/doc/x", false],
    ["User-agent: *\nDisallow: / # all of it\n", "/x", false],
    ["User-agent: Googlebot\nUser-agent: *\nDisallow: /\n", "/x", false],
    ["User-agent: *\nDisallow:\n", "/x", true],
    ["User-agent: *\nDisallow: /private\n", "/x", true],
    ["User-agent: *\nDisallow: /\nAllow: /\n", "/x", true],
    ["User-agent: Googlebot\nDisallow: /\n", "/x", true],
    ["# User-agent: *\n# Disallow: /\n", "/x", true],
    ["User-agent: *\nDisallow: /\nAllow: /*.html$\n", "/a.html", true],
    ["User-agent: *\nDisallow: /\nAllow: /*.html$\n", "/a.html.bak", false],
  ]) assert.equal(robotsAllows(text, path), allowed, `${JSON.stringify(text)} on ${path}`);
});

test("_headers: a `/*` rule applies to the DID document wherever it is written", () => {
  const didRule = "/.well-known/did.json\n  Content-Type: application/did+json\n";
  const starRule = "/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n";
  for (const text of [starRule + didRule, didRule + starRule]) {
    const names = headersFor(parseHeaders(text), DID_PATH).map((h) => h.name);
    assert.deepEqual(names.sort(), ["content-type", "x-robots-tag"]);
  }
});

test("_headers: header names are compared without case, so the guard sees a repeat", () => {
  const text = "/*\n  X-Robots-Tag: noindex\n/.well-known/did.json\n  x-robots-tag: noindex\n";
  const names = headersFor(parseHeaders(text), DID_PATH).map((h) => h.name);
  assert.deepEqual(names, ["x-robots-tag", "x-robots-tag"]);
});

test("_headers: a path pattern matches whole paths only", () => {
  assert.ok(matches("/*", "/"));
  assert.ok(matches("/*", DID_PATH));
  assert.ok(matches(DID_PATH, DID_PATH));
  assert.ok(!matches(DID_PATH, "/.well-known/did.json.bak"));
  assert.ok(!matches(DID_PATH, "/.well-known/didXjson"));
  assert.ok(matches("/:dir/did.json", DID_PATH));
  assert.ok(!matches("/:dir/did.json", "/a/b/did.json"));
});
