import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import version from "../dist/lib/version.js";

test("version is exported as a non-empty string", () => {
  assert.strictEqual(typeof version, "string", "version should be a string");
  assert.notStrictEqual(version.length, 0, "version should not be empty");
});

test("version matches package.json version", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.strictEqual(version, pkg.version, "exported version should match package.json");
});

test("version is semver-ish format", () => {
  const semverPattern = /^\d+\.\d+\.\d+/;
  assert.match(version, semverPattern, "version should match semver pattern (major.minor.patch)");
});
