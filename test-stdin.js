import { readFileSync } from "node:fs";

async function test() {
  // Simulate the context function call
  await new Promise(r => setTimeout(r, 10));
  
  let body = undefined ?? "";
  const opts = { body: undefined };
  
  console.log("process.stdin.isTTY:", process.stdin.isTTY);
  console.log("!opts.body:", !opts.body);
  console.log("!process.stdin.isTTY:", !process.stdin.isTTY);
  console.log("condition:", !opts.body && !process.stdin.isTTY);
  
  if (!opts.body && !process.stdin.isTTY) {
    console.log("Reading from stdin...");
    body = readFileSync(0, "utf8");
    console.log("Body:", JSON.stringify(body));
  } else {
    console.log("Skipped stdin reading");
  }
}

test().catch(console.error);
