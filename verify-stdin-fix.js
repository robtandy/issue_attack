// Verify the stdin reading logic works correctly

import { readFileSync } from "fs";

console.log("Testing the new stdin reading logic:");
console.log("====================================");

// Simulate the new logic
function testLogic(opts, label) {
  console.log(`\n${label}:`);
  console.log(`  opts.body: ${opts.body}`);
  console.log(`  opts.bodyFile: ${opts.bodyFile}`);
  console.log(`  process.stdin.isTTY: ${process.stdin.isTTY}`);
  
  let body = opts.body ?? "";
  if (!body && opts.bodyFile) {
    console.log("  → Reading from bodyFile");
  } else if (!body) {
    if (!process.stdin.isTTY) {
      console.log("  → stdin is not a TTY, attempting to read");
      body = readFileSync(0, "utf8");
      console.log(`  → Read ${body.length} chars from stdin`);
    } else {
      console.log("  → stdin is a TTY, skipping stdin read");
    }
  } else {
    console.log("  → Using provided --body");
  }
  return body;
}

// Test cases
testLogic({ body: undefined, bodyFile: undefined }, "Case 1: No body, no bodyFile, piped stdin");
testLogic({ body: "explicit", bodyFile: undefined }, "Case 2: --body provided");
testLogic({ body: undefined, bodyFile: "somefile" }, "Case 3: --body-file provided (would read file)");
