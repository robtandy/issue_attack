// Test the exact condition used in the code
console.log("Testing stdin.isTTY detection in different scenarios");
console.log("========================================================");

console.log("\nprocess.stdin.isTTY:", process.stdin.isTTY);
console.log("typeof process.stdin.isTTY:", typeof process.stdin.isTTY);
console.log("!process.stdin.isTTY:", !process.stdin.isTTY);
console.log("process.stdin.isTTY === false:", process.stdin.isTTY === false);
console.log("process.stdin.isTTY === true:", process.stdin.isTTY === true);

// The condition from the code
const opts = { body: undefined };
const condition = !opts.body && !process.stdin.isTTY;
console.log("\nCondition (!opts.body && !process.stdin.isTTY):", condition);

// What if we use process.stdin.isTTY === false instead?
const conditionAlternative = !opts.body && process.stdin.isTTY === false;
console.log("Alternative (process.stdin.isTTY === false):", conditionAlternative);
