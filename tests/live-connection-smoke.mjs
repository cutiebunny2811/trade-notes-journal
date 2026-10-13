// Non-mutating production connectivity check. Run only with an agent token in
// TRADE_NOTES_AGENT_TOKEN; the intentionally incomplete payload must be rejected
// *after* token authentication and must never create a journal trade.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

assert.match(process.env.TRADE_NOTES_AGENT_TOKEN || "", /^tn_[a-f0-9]{64}$/);
const adapter = fileURLToPath(new URL("../hermes-mcp/server.mjs", import.meta.url));
const child = spawn(process.execPath, [adapter], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const lines = readline.createInterface({ input: child.stdout });
const timeout = setTimeout(() => child.kill(), 20_000);
let response;
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: "record_confirmed_trade_fill", arguments: {} },
})}\n`);
for await (const line of lines) {
  response = JSON.parse(line);
  child.stdin.end();
  break;
}
clearTimeout(timeout);
assert.ok(response, `Adapter did not respond (${stderr ? "stderr reported" : "no output"})`);
assert.equal(response.result?.isError, true);
assert.match(response.result.content[0].text, /INVALID_ROUTE_OR_IDENTITY/);
console.log("Live Trade Notes MCP authentication and RPC connection: passed (no trade written)");
