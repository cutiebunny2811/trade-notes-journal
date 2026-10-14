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

test("lists scoped writer, reader and correction tools and refuses a missing token", async () => {
  const output = await runAdapter({ TRADE_NOTES_AGENT_TOKEN: "" }, [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "record_confirmed_trade_fill", arguments: sample } },
  ]);
  assert.deepEqual(output[0].result.tools.map(tool => tool.name), [
    "record_confirmed_trade_fill", "read_trade_notes", "correct_recorded_trade_fill",
  ]);
  const fields = output[0].result.tools[0].inputSchema.properties;
  assert.deepEqual(fields.lane.enum, ["swing", "option", "position"]);
  assert.deepEqual(fields.assetClass.enum, ["stock", "option"]);
  assert.deepEqual(fields.tradeStyle.enum, ["swing", "position"]);
  assert.equal(output[1].result.isError, true);
});

test("reviews a Bangkok-date window and calculates exit P/L without treating an open position as closed", async () => {
  let captured;
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    captured = { path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
    const from = captured.body.p_from, to = captured.body.p_to;
    const opened = new Date(Date.parse(from) + 60_000).toISOString();
    const exited = new Date(Date.parse(from) + 120_000).toISOString();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ from, to, totalCount: 1, returnedCount: 1, truncated: false,
      trades: [{ symbol: "STX", direction: "LONG", status: "pending", notes: "waited for setup",
        fills: [
          { action: "buy", quantity: 2, unitPrice: 10, commission: 1, otherFees: 0, multiplier: 1, executedAt: opened },
          { action: "sell", quantity: 1, unitPrice: 15, commission: 0.5, otherFees: 0, multiplier: 1, executedAt: exited },
        ] }] }));
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = http.address();
    const output = await runAdapter({ TRADE_NOTES_AGENT_TOKEN: token,
      TRADE_NOTES_URL: `http://127.0.0.1:${port}` }, [
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "read_trade_notes",
        arguments: { period: "last_7_days", symbol: "STX" } } },
    ]);
    assert.equal(captured.path, "/rest/v1/rpc/api_tsuki_read_journal");
    assert.equal(captured.body.p_token, token);
    assert.equal(captured.body.p_symbol, "STX");
    const result = JSON.parse(output[0].result.content[0].text);
    assert.equal(result.metrics.realizedOnExits, 4);
    assert.equal(result.metrics.feesOnExecutions, 1.5);
    assert.equal(result.trades[0].status, "pending");
    assert.equal(result.trades[0].periodExitCount, 1);
  } finally { http.close(); }
});

test("sends one exact fill correction to the correction RPC", async () => {
  let captured;
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    captured = { path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ unchanged: false, openQuantity: 1, realizedPl: 0 }));
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = http.address();
    const correction = { matchKey: "TN-example", fillId: "00000000-0000-0000-0000-000000000001",
      expectedUpdatedAt: "2026-10-14T10:00:00Z", changes: { unitPrice: 706.11 }, reason: "correct price from user" };
    const output = await runAdapter({ TRADE_NOTES_AGENT_TOKEN: token,
      TRADE_NOTES_URL: `http://127.0.0.1:${port}` }, [
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "correct_recorded_trade_fill",
        arguments: correction } },
    ]);
    assert.equal(captured.path, "/rest/v1/rpc/api_tsuki_correct_fill");
    assert.deepEqual(captured.body.p_payload, correction);
    assert.equal(output[0].result.isError, false);
  } finally { http.close(); }
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

test("derives a stable source key when Telegram does not expose message metadata", async () => {
  const sources = [];
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    sources.push(JSON.parse(Buffer.concat(chunks).toString()).p_payload.sourceKey);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ duplicate: sources.length > 1 }));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = http.address();
    const env = { TRADE_NOTES_AGENT_TOKEN: token, TRADE_NOTES_URL: `http://127.0.0.1:${port}` };
    const withoutSource = { ...sample };
    delete withoutSource.sourceKey;
    await runAdapter(env, [{ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
      name: "record_confirmed_trade_fill", arguments: withoutSource,
    } }]);
    await runAdapter(env, [{ jsonrpc: "2.0", id: 5, method: "tools/call", params: {
      name: "record_confirmed_trade_fill", arguments: withoutSource,
    } }]);
    assert.match(sources[0], /^broker:slipfp-[a-f0-9]{64}$/);
    assert.equal(sources[0], sources[1]);
  } finally {
    http.close();
  }
});
