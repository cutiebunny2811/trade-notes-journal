import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../hermes-mcp/server.mjs", import.meta.url));
const token = `tn_${"a".repeat(64)}`;
const sample = {
  sourceKey: "tg:-123:45:1", lane: "swing", assetClass: "stock", symbol: "STX",
  direction: "LONG", action: "buy", intent: "buy1", quantity: 2, unitPrice: 10,
  multiplier: 1, commission: 0.1, otherFees: 0, executedAt: "2026-10-14T10:00:00Z",
};

function runAdapter(env, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { env: { ...process.env, ...env } });
    const lines = readline.createInterface({ input: child.stdout });
    const output = [];
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(chunk.toString()));
    lines.on("line", (line) => {
      output.push(JSON.parse(line));
      if (output.length === messages.length) child.stdin.end();
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(errors.join("") || `exit ${code}`)));
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

test("lists only the journal writer and refuses a missing token", async () => {
  const output = await runAdapter({ TRADE_NOTES_AGENT_TOKEN: "" }, [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "record_confirmed_trade_fill", arguments: sample } },
  ]);
  assert.equal(output[0].result.tools.length, 1);
  assert.equal(output[1].result.isError, true);
});

test("sends a confirmed fill to the exact RPC and returns its read-back", async () => {
  let captured;
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    captured = { path: request.url, key: request.headers.apikey, body: JSON.parse(Buffer.concat(chunks).toString()) };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ duplicate: false, symbol: "STX", openQuantity: 2, fillCount: 1 }));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = http.address();
    const output = await runAdapter({
      TRADE_NOTES_AGENT_TOKEN: token,
      TRADE_NOTES_URL: `http://127.0.0.1:${port}`,
      TRADE_NOTES_PUBLISHABLE_KEY: "public-test-key",
    }, [{ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "record_confirmed_trade_fill", arguments: sample,
    } }]);
    assert.equal(captured.path, "/rest/v1/rpc/api_tsuki_record_fill");
    assert.equal(captured.key, "public-test-key");
    assert.equal(captured.body.p_token, token);
    assert.deepEqual(captured.body.p_payload, sample);
    assert.equal(JSON.parse(output[0].result.content[0].text).fillCount, 1);
  } finally {
    http.close();
  }
});
