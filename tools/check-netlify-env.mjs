#!/usr/bin/env node
// Checks the files of netlify-env-public/: the variables of each domain's
// Netlify project, tracked on main (#11).
//
// EVERYTHING IN netlify-env-public/ IS PUBLIC: on GitHub as soon as it is
// pushed, and on the domain's site. So the format leaves a secret no field to
// hide in: the file is named <DID_DOMAIN>.env; every line is KEY=VALUE, with
// no comment, no blank line, no `export`, and a value without blanks, control
// characters, quotes or backslashes; the keys are those that
// tools/netlify-env-keys.txt lists as required (each once) or optional (at
// most once). Any other key is refused; a prohibited one gets the reason the
// list gives. DID_DOMAIN is a lower-case host name; the other values are
// http(s) URLs without user information.
//
// Usage: node tools/check-netlify-env.mjs <file>...   the files given
//        node tools/check-netlify-env.mjs --staged    what the index holds under
//                                                     netlify-env-public/
// Each fault is one line `FAULT <path>[:<line>]: <reason>` on stderr, exit 1;
// nothing is printed when every file passes, exit 0. A missing argument, an
// unreadable file or reference list, or a failed git command is a usage
// error, exit 2.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FOLDER = "netlify-env-public";
const KEYS = join(dirname(fileURLToPath(import.meta.url)), "netlify-env-keys.txt");

// A host name in lower case, as build-site.mjs, which holds the same
// expression, requires of DID_DOMAIN.
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

// A line: a key, `=`, and a value of one character or more, none of them a
// blank, a control character, a quote or a backslash. A value is a host name
// or a URL, so it needs none of them, and the `.env` format would read them.
const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=([^\s\x00-\x1f\x7f"'`\\]+)$/;

function usage(message) {
  console.error(`check-netlify-env: ${message}`);
  process.exit(2);
}

/** The reference list, as a Map key → { status, reason }. */
function referenceList() {
  let text;
  try { text = readFileSync(KEYS, "utf8"); } catch (e) { usage(`cannot read ${KEYS}: ${e.code ?? e.message}`); }
  const list = new Map();
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const [key, status, ...reason] = line.trim().split(/ +/);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !["required", "optional", "prohibited"].includes(status)
      || list.has(key) || (status === "prohibited") !== (reason.length > 0))
      usage(`${KEYS}:${i + 1}: not <KEY> required|optional|prohibited <reason>`);
    list.set(key, { status, reason: reason.join(" ") });
  }
  return list;
}

/** Runs git; resolves to its stdout, or exits with a usage error. */
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) usage(`git ${args[0]}: ${(r.stderr || r.error?.message || "failed").trim().split("\n")[0]}`);
  return r.stdout;
}

/** The faults of one file, `text` printed as `path`, whose name is `name`. */
function faultsOf(path, name, text, list) {
  const faults = [];
  const values = new Map();
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop(); // the final newline ends the last line
  for (const [i, line] of lines.entries()) {
    const at = `FAULT ${path}:${i + 1}`;
    const m = LINE.exec(line);
    if (!m) { faults.push(`${at}: not KEY=VALUE`); continue; }
    const [, key, value] = m;
    const entry = list.get(key);
    if (entry?.status === "prohibited") faults.push(`${at}: ${key} is prohibited: ${entry.reason}`);
    else if (!entry) faults.push(`${at}: ${key} is not an allowed key`);
    else if (values.has(key)) faults.push(`${at}: ${key} given twice`);
    else values.set(key, value);
  }

  const domain = values.get("DID_DOMAIN");
  if (domain !== undefined ? name !== `${domain}.env` : !name.endsWith(".env") || name.includes("/"))
    faults.push(`FAULT ${path}: not named ${domain ?? "<DID_DOMAIN>"}.env`);
  for (const [key, { status }] of list)
    if (status === "required" && !values.has(key)) faults.push(`FAULT ${path}: ${key} missing`);
  for (const [key, value] of values) {
    if (key === "DID_DOMAIN") {
      if (!HOST_NAME.test(value)) faults.push(`FAULT ${path}: DID_DOMAIN ${value} is not a lower-case host name`);
      continue;
    }
    let url = null;
    try { url = new URL(value); } catch { /* not a URL */ }
    if (!url || !["https:", "http:"].includes(url.protocol)) faults.push(`FAULT ${path}: ${key} ${value} is not an http(s) URL`);
    else if (url.username || url.password) faults.push(`FAULT ${path}: ${key} holds user information`);
  }
  return faults;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.includes("--staged") && args.length > 1))
    usage("usage: check-netlify-env.mjs <file>... | --staged");
  const list = referenceList();

  // [path printed, name checked, content]
  const files = [];
  if (args[0] === "--staged") {
    // From the top of the work tree, whatever the current directory: git
    // prints the paths from there. A deleted file is not checked.
    const top = git(["rev-parse", "--show-toplevel"]).trim();
    const staged = git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "--", `${FOLDER}/`], top)
      .split("\0").filter(Boolean);
    for (const path of staged) files.push([path, path.slice(FOLDER.length + 1), git(["show", `:${path}`], top)]);
  } else {
    for (const path of args) {
      let text;
      try { text = readFileSync(path, "utf8"); } catch (e) { usage(`cannot read ${path}: ${e.code ?? e.message}`); }
      files.push([path, basename(path), text]);
    }
  }

  const faults = files.flatMap(([path, name, text]) => faultsOf(path, name, text, list));
  for (const f of faults) console.error(f);
  process.exit(faults.length ? 1 : 0);
}

main();

// --- Change History -------------------------------------------------------
// | PR     | Summary                                                       |
// |--------|---------------------------------------------------------------|
// | #13    | checks the files of netlify-env-public/ (#11)                 |
