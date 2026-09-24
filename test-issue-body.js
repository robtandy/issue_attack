import { readFileSync } from "node:fs";

async function testFlow() {
  // Simulate what happens in cmdNew
  console.log("=== Before context call ===");
  console.log("process.stdin.isTTY:", process.stdin.isTTY);
  
  // Simulate async context call (like awaiting gh.repoInfo)
  await new Promise(r => setTimeout(r, 10));
  
  console.log("\n=== After context call ===");
  console.log("process.stdin.isTTY:", process.stdin.isTTY);
  
  // Simulate the body reading logic
  const opts = { body: undefined, bodyFile: undefined };
  console.log("\n=== Body reading logic ===");
  console.log("opts.body:", opts.body);
  console.log("opts.bodyFile:", opts.bodyFile);
  console.log("!opts.body:", !opts.body);
  console.log("!process.stdin.isTTY:", !process.stdin.isTTY);
  console.log("Full condition:", !opts.body && !process.stdin.isTTY);
  
  let body = opts.body ?? "";
  if (opts.bodyFile) {
    console.log("Reading from bodyFile");
  } else if (!opts.body && !process.stdin.isTTY) {
    console.log("Reading from stdin...");
    body = readFileSync(0, "utf8");
    console.log("Got body:", JSON.stringify(body.substring(0, 50)));
  } else {
    console.log("Using empty body (no stdin)");
  }
}

testFlow().catch(console.error);
