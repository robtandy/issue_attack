import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import version from "../lib/version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

test("version is a non-empty string", () => {
  assert.strictEqual(typeof version, "string");
  assert.notStrictEqual(version, "");
});

test("version matches package.json", () => {
  assert.strictEqual(version, packageJson.version);
});

test("version matches semver-ish format (major.minor.patch)", () => {
  const semverRegex = /^\d+\.\d+\.\d+/;
  assert.match(version, semverRegex);
});
