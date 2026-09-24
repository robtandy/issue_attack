// Version module: exports the package version string from package.json
// This is a dependency-free module that provides the version to other modules
// instead of each module reading package.json independently.
//
// package.json is imported (not read from disk at runtime) so bundlers and
// `bun build --compile` can inline it into the distributed artifact.

import pkg from "../../package.json" with { type: "json" };

const version: string = pkg.version;

export default version;
