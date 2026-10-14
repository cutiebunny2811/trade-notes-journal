// Production smoke test: reads a bounded journal window and attempts a
// correction of a guaranteed-nonexistent MatchKey. Never writes a trade.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

assert.match(process.env.TRADE_NOTES_AGENT_TOKEN || "", /^tn_[a-f0-9]{64}$/);
const adapter = fileURLToPath(new URL("../hermes-mcp/server.mjs", import.meta.url));
const child = spawn(process.execPath, [adapter], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const lines = readline.createInterface({ input: child.stdout });
const timer = setTimeout(() => child.kill(), 30_000);
const request = (id, name, args) => child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
})}\n`);
request(1, "read_trade_notes", { period: "last_7_days" });
let read, correction;
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === 1) {
    assert.equal(message.result?.isError, false, "Journal read failed");
    read = JSON.parse(message.result.content[0].text);
    assert.ok(Array.isArray(read.trades));
    assert.equal(typeof read.totalCount, "number");
    assert.equal(typeof read.truncated, "boolean");
    assert.ok(read.trades.every(trade => !Object.hasOwn(trade, "imagePaths")));
    request(2, "correct_recorded_trade_fill", {
      matchKey: "TN-00000000-0000-0000-0000-000000000000",
      fillId: "00000000-0000-0000-0000-000000000000",
      expectedUpdatedAt: new Date().toISOString(),
      changes: { unitPrice: 1 }, reason: "nonexistent smoke-test target",
    });
  } else if (message.id === 2) {
    correction = message;
    child.stdin.end();
  }
}
clearTimeout(timer);
assert.ok(read, "No read response");
assert.equal(correction?.result?.isError, true);
assert.match(correction.result.content[0].text, /MATCHKEY_NOT_FOUND/);
console.log(`Live Trade Notes review: passed (${read.returnedCount} rows; private details withheld)`);
console.log("Live correction rejection: passed (nonexistent target; no trade changed)");
