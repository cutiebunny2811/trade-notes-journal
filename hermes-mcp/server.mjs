import readline from "node:readline";
import { createHash } from "node:crypto";

const projectUrl = process.env.TRADE_NOTES_URL || "https://yfbbpertvtmwfadfldia.supabase.co";
const publishableKey = process.env.TRADE_NOTES_PUBLISHABLE_KEY || "sb_publishable_-zWhSbG4lfuTqd1T6o2P4A_D_CveFwH";
const agentToken = process.env.TRADE_NOTES_AGENT_TOKEN || "";
const timeoutMs = Math.max(Number(process.env.TRADE_NOTES_TIMEOUT_MS || 30_000), 1_000);

const tools = [{
  name: "record_confirmed_trade_fill",
  description: "Record one broker-confirmed execution in the private Trade Notes journal. The server resolves the open position, rejects ambiguous matches, deduplicates a Telegram/broker identity, calculates P/L, and reads the inserted fill back. Never call for a draft, pending order, SETUP, TEST, or PING. Fees must be explicit; do not invent zero fees.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["lane", "assetClass", "symbol", "direction", "action", "quantity", "unitPrice", "multiplier", "commission", "otherFees", "executedAt"],
    properties: {
      sourceKey: { type: "string", description: "Optional stable tg:<chat_id>:<message_id>:<fill_ordinal> if message metadata is actually available. Otherwise omit it; the adapter derives a deterministic key from the broker execution ID or visible fill facts." },
      brokerExecutionId: { type: "string", description: "Stable broker execution identity if visible. Prefix with broker name, for example webull:12345." },
      lane: { type: "string", enum: ["nut", "ging", "swing", "option", "gold"] },
      assetClass: { type: "string", enum: ["stock", "option", "gold"] },
      tradeStyle: { type: "string", enum: ["swing", "day", "position"] },
      symbol: { type: "string", description: "Underlying ticker, not an option contract string." },
      direction: { type: "string", enum: ["LONG", "SHORT"] },
      action: { type: "string", enum: ["buy", "sell"] },
      intent: { type: "string", enum: ["buy1", "buy2", "sell", "open", "add"] },
      matchKey: { type: "string", description: "Exact Trade Notes MatchKey only if supplied or otherwise unambiguously known." },
      optionContract: {
        type: "object", additionalProperties: false, required: ["expiry", "strike", "right"],
        properties: {
          expiry: { type: "string", description: "YYYY-MM-DD" },
          strike: { type: "number", exclusiveMinimum: 0 },
          right: { type: "string", enum: ["call", "put"] },
        },
      },
      quantity: { type: "number", exclusiveMinimum: 0 },
      unitPrice: { type: "number", minimum: 0 },
      multiplier: { type: "number", enum: [1, 100] },
      commission: { type: "number", minimum: 0 },
      otherFees: { type: "number", minimum: 0 },
      executedAt: { type: "string", description: "ISO 8601 broker execution time with explicit timezone, such as 2026-10-14T14:30:00-04:00." },
      brokerTimeText: { type: "string", description: "Original date/time text as printed on the slip." },
    },
  },
}];

async function callWriter(args) {
  if (!agentToken) throw new Error("Trade Notes writer is not configured");
  const payload = { ...args };
  if (!payload.sourceKey) {
    const identity = payload.brokerExecutionId
      ? ["execution", payload.brokerExecutionId]
      : ["slip-fingerprint", payload.lane, payload.assetClass, payload.symbol,
        payload.optionContract?.expiry, payload.optionContract?.strike,
        payload.optionContract?.right, payload.direction, payload.action,
        payload.quantity, payload.unitPrice, payload.multiplier,
        payload.commission, payload.otherFees, payload.executedAt];
    const prefix = payload.brokerExecutionId ? "execution" : "slipfp";
    payload.sourceKey = `broker:${prefix}-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  }
  const target = new URL("/rest/v1/rpc/api_tsuki_record_fill", projectUrl);
  if (!(target.protocol === "https:" && target.hostname.endsWith(".supabase.co")) &&
      !(target.protocol === "http:" && ["127.0.0.1", "localhost"].includes(target.hostname))) {
    throw new Error("Trade Notes URL must be the Supabase project or local test server");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { apikey: publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ p_token: agentToken, p_payload: payload }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({ message: "Invalid response from Trade Notes" }));
    if (!response.ok) throw new Error(body?.message || `Trade Notes error ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
async function handle(message) {
  const { id, method, params } = message;
  if (method === "notifications/initialized") return;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "trade-notes-tsuki", version: "1.0.0" },
    } });
    return;
  }
  if (method === "ping") { send({ jsonrpc: "2.0", id, result: {} }); return; }
  if (method === "tools/list") { send({ jsonrpc: "2.0", id, result: { tools } }); return; }
  if (method === "tools/call") {
    try {
      if (params?.name !== "record_confirmed_trade_fill") throw new Error("Unknown tool");
      const value = await callWriter(params.arguments || {});
      send({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: JSON.stringify(value) }], isError: false,
      } });
    } catch (error) {
      send({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      } });
    }
    return;
  }
  if (method === "resources/list" || method === "prompts/list") {
    send({ jsonrpc: "2.0", id, result: method === "resources/list" ? { resources: [] } : { prompts: [] } });
    return;
  }
  if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  try { await handle(JSON.parse(line)); }
  catch (error) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } });
  }
});
