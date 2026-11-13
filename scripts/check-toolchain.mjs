#!/usr/bin/env node
/**
 * Fails fast, with an explanation, when the Node.js/npm that runs the install is one that npm's
 * dependency resolver cannot handle for this tree.
 *
 * Why this exists: on some npm 10.x releases, `npm install` crashes inside `@npmcli/arborist`
 * with `Cannot read properties of null (reading 'edgesOut')` while it builds the ideal dependency
 * tree — a raw TypeError with no hint about the cause (vitest 5's peer set is what trips it here).
 * `npm ci` does not go through that code path, so it is exempt.
 *
 * Wired as `preinstall`, so it runs before the resolver starts. It never fails on npm >= 11 and it
 * never fails for `npm ci`, so a correct build system never sees it.
 */
import { createRequire } from "node:module";

const MIN_NODE = [20, 18, 1];
const MIN_NPM = [10, 9, 0];

const require = createRequire(import.meta.url);
const fail = [];
const note = [];

function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

const parse = (v) => String(v).trim().replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);

// Node.js: `engines.node` is advisory by default, so check it explicitly.
const nodeVersion = parse(process.versions.node);
if (cmp(nodeVersion, MIN_NODE) < 0) {
  fail.push(`Node.js ${process.versions.node} is too old (need >= ${MIN_NODE.join(".")}).`);
}

// npm: prefer the version that invoked this script over the one resolvable from node_modules.
const npmVersionString = process.env.npm_config_user_agent?.match(/npm\/[\d.]+/)?.[0]?.replace("npm/", "") ??
  (() => {
    try {
      return require("npm/package.json").version;
    } catch {
      return null;
    }
  })();
const npmVersion = npmVersionString ? parse(npmVersionString) : null;
const isCi = process.env.npm_command === "ci";

if (!isCi && npmVersion && cmp(npmVersion, MIN_NPM) < 0) {
  fail.push(`npm ${npmVersionString} is too old (need >= ${MIN_NPM.join(".")}).`);
}
if (!isCi && npmVersion && npmVersion[0] === 10) {
  note.push("npm 10 can crash while resolving this project's peer dependencies; npm 11+ is recommended.");
}

if (fail.length) {
  console.error("\nUnsupported environment for `npm install`:\n");
  for (const line of fail) console.error(`  - ${line}`);
  console.error(`
` + `Use Node.js 22 (>= 22.12) and npm 11, or install straight from the committed lockfile:

  npm ci

` + `In CI / on a host that pins its own image, pin the toolchain instead of relying on the image
default: NODE_VERSION=22, or Corepack (` + "`corepack enable`" + `) with the ` + "`packageManager`" + ` field in package.json.
`);
  process.exit(1);
}

for (const line of note) console.warn(`[toolchain] ${line}`);
