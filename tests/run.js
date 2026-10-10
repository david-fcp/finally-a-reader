/* Runs every test suite. `node tests/run.js` from anywhere. */
const { execFileSync } = require("child_process");
const path = require("path");

const suites = ["test-markdown.js"];
let failed = 0;

for (const suite of suites) {
  process.stdout.write(suite.padEnd(20));
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, suite)], {
      encoding: "utf8",
    });
    const summary = out.trim().split("\n").filter((l) => l.trim()).pop();
    console.log(summary.trim());
  } catch (e) {
    failed++;
    console.log("FAILED");
    console.log((e.stdout || "") + (e.stderr || ""));
  }
}

console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
