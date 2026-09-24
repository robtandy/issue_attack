import { readFileSync } from "node:fs";

console.log("Test 1: Reading from stdin when piped");
try {
  const data = readFileSync(0, "utf8");
  console.log("Success! Got:", JSON.stringify(data.substring(0, 30)));
} catch (err) {
  console.error("Error:", err.message);
}

console.log("\nTest 2: Check stdin.isTTY after readFileSync");
console.log("process.stdin.isTTY:", process.stdin.isTTY);
