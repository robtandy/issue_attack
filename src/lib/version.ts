// Version module: exports the package version string from package.json
// This is a dependency-free module that provides the version to other modules
// instead of each module reading package.json independently.

import { readFileSync } from "node:fs";

interface PackageJson {
  version: string;
}

const version = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as PackageJson;

export default version.version;
