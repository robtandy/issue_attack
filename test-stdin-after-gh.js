import { exec } from "./lib/exec.js";
import { readFileSync } from "node:fs";

async function test() {
  console.log("Before gh command:");
  console.log("  process.stdin.isTTY:", process.stdin.isTTY);
  
  // Simulate calling a gh command like in context()
  try {
    console.log("\nCalling gh repo view...");
    const { code, stdout } = await exec("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], {
      cwd: process.cwd()
    });
    console.log("  gh command returned code:", code);
  } catch (e) {
    console.log("  gh command failed (expected if not in a repo):", e.message);
  }
  
  console.log("\nAfter gh command:");
  console.log("  process.stdin.isTTY:", process.stdin.isTTY);
  
  // Try to read stdin
  console.log("\nAttempting to read from stdin...");
  try {
    const data = readFileSync(0, "utf8");
    console.log("  Got data:", JSON.stringify(data.substring(0, 30)));
  } catch (e) {
    console.log("  Error reading stdin:", e.message);
  }
}

test().catch(console.error);
