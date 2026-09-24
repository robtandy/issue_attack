import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, "..", "package.json");

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

export default packageJson.version;
