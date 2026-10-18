#!/usr/bin/env node
/**
 * Release gate: every package.json carries one version, CHANGELOG.md has a
 * heading for it, and (when given) the git tag is `v<version>`.
 *
 *   node scripts/check-release.mjs          # versions + changelog
 *   node scripts/check-release.mjs v0.3.0   # ... and the tag
 *
 * Run it before tagging, so a tag without the version bump or the changelog
 * entry is caught before anything ships.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const manifests = [
  "package.json",
  ...readdirSync(join(root, "packages")).map((name) => `packages/${name}/package.json`),
];
const versions = new Map(manifests.map((path) => [path, JSON.parse(read(path)).version]));
const version = versions.get("package.json");
const problems = [];

for (const [path, v] of versions) {
  if (v !== version) problems.push(`${path} is ${v}, root package.json is ${version}`);
}

const heading = new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
if (!heading.test(read("CHANGELOG.md"))) {
  problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" heading`);
}

const tag = process.argv[2];
if (tag !== undefined && tag !== `v${version}`) {
  problems.push(`tag ${tag} does not match version v${version}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`release check: ${problem}`);
  process.exit(1);
}
console.log(`release check: ${manifests.length} manifests at ${version}, changelog entry present${tag ? `, tag ${tag} matches` : ""}`);
