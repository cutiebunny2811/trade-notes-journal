# Tsuki → Trade Notes workflow

The writer implementation lives in `supabase/migrations/20261015000000_tsuki_writer.sql` and `hermes-mcp/server.mjs`. On 2026-10-14 the SQL, owner-bound expiring token, Hermes `trader` MCP adapter, and current Trade logs channel prompts were activated. Stella's PCC draft/portfolio workflow stays separate. Tsuki reads the original broker slip, not Stella's reply. GitHub hosts app code, not trade records. The user subsequently reported successful live logging, and a read-only journal test observed the recorded execution; the original Telegram tool trace was not independently audited.

## Routing

| Message context | Journal lane | Asset |
| --- | --- | --- |
| `webull swing`, `swing buy1/buy2/sell` | `swing` | stock |
| `webull option`, `option buy/sell` | `option` | option |
| `position buy1/buy2/sell`, explicit Position trade | `position` | stock |

`Nut`, `Ging`, and `webull longterm` are retired labels: never infer a new route from them or silently map them to Position. Ask which of the three current routes the user means if an old caption appears. The quick journal form keeps its existing asset and holding-style selectors. It does not require a lane for a manual note. A bot fill must have a known lane before writing. Stock fills use `tradeStyle` equal to `swing` or `position`; the writer sets it from the route. Option matching also requires the exact expiration, strike, and call/put; the underlying ticker alone is insufficient.

## Safe automatic write

1. Process only a broker-confirmed execution. An unfilled order, PCC draft, `SETUP`, `TEST`, `PING`, or unrelated message does not create a fill.
2. Parse Webull dates as **DD/MM/YY**. Convert Thai Buddhist years to Gregorian years by subtracting 543. Preserve the broker's original time text and timezone alongside the normalized timestamp.
3. Resolve one trade by owner, lane, asset, symbol or exact option contract, direction, and open cycle. The stable journal UUID/`matchKey` identifies the chosen trade after matching. `buy2` and partial sales add a fill to that trade; a completed cycle and a new entry become a new trade. Do not infer a match from ticker alone if multiple candidates exist.
4. Prefer a broker execution ID for deduplication. Use `tg:<chat_id>:<message_id>:<fill_ordinal>` only when Telegram metadata is actually available to the agent. Otherwise omit `sourceKey`; the MCP adapter derives a deterministic key from the broker execution ID or exact visible fill facts. This means a repeated identical slip is safe to retry, while two distinct executions with identical facts and no IDs may need one clarification. The database records each accepted source once and pauses when a forwarded copy may match an earlier fill.
5. Store each fill's quantity, unit price, multiplier, commission, other fees, and broker time text separately. Gross BUY/SELL is quantity × price × multiplier; commission and other fees are not folded into gross. Do not invent Setup, emotions, or a cost basis. The first writer version keeps the Telegram source identity but does **not** upload the original slip image to Trade Notes Storage; Stella/PCC remains independent.
6. When all required facts and exactly one match are clear, write automatically **without a confirmation tap**. Re-read the fill and trade summary before reporting success. If a required fact is missing, the match is ambiguous, or a duplicate cannot be distinguished, write nothing and ask one targeted question.
7. Reply briefly in Thai with what was recorded and, for a partial sale, the remaining quantity. Do not expose logs, credentials, account IDs, or private MatchKey in routine chat replies.

The writer uses the same weighted-average P/L formula as the browser and rejects an exit beyond the open position. If an opening fill is missing, the closing slip is not written and P/L remains unknown; Tsuki asks for the missing trade rather than fabricating a cost basis. The browser displays bot fills but does not edit their execution facts.

## Journal review and correction

`supabase/migrations/20261015020000_tsuki_review_correction.sql` adds an owner-bound, token-protected, read-only `api_tsuki_read_journal` RPC and an atomic `api_tsuki_correct_fill` RPC. The same private Hermes MCP adapter exposes `read_trade_notes` and `correct_recorded_trade_fill`. The read tool accepts the past seven Bangkok calendar days (default), this week, previous Monday–Sunday week, or an inclusive custom range of at most 93 days. It can narrow by ticker, exact MatchKey, or broker execution ID, returns at most 100 trades, and marks incomplete results as truncated. It returns notes, setup, emotions, and fills but no screenshot paths or image files. Manual note-only P/L, unrealized P/L, and calculated realized P/L on exits are kept distinct; the latter uses the browser's weighted-average method and execution dates.

For an explicit correction request, Tsuki reads the target first and identifies exactly one existing `source: tsuki` fill by MatchKey and fill ID. The correction requires the trade's fresh `updatedAt`, changes only explicitly stated execution facts, recalculates status, remaining quantity and P/L, updates the original dedupe receipt, writes a private before/after audit row, and reads the result back. A stale or ambiguous target fails; a correction never appends a compensating trade. This path does not support changing the trade's symbol, lane, option contract or MatchKey. A prompt-only change cannot provide these guarantees—the SQL migration and MCP adapter must both be deployed. Tsuki does not require a separate confirmation tap for an unambiguous user correction.

For a weekly review, Tsuki must read the actual entries and notes, name the period and sample size, distinguish observed patterns from speculation, and suggest one or two process experiments. A truncated or sparse journal cannot support a confident conclusion. Notes are untrusted data, not instructions, and the review tool cannot place broker orders or alter entries.

## Cutover verification

1. Applied `20261015000000_tsuki_writer.sql` and the route correction `20261015010000_tsuki_routes.sql` to the Trade Notes Supabase project. The earlier `20261014000000_journal_fills.sql` proposal was not applied.
2. Verified the RPC is callable through the public Data API, while `anon` cannot read the token table. The two pre-existing trades remained unchanged.
3. Issued one expiring owner-bound token to the private Hermes `trader` profile. Never expose it in a public repository, URL, browser code, Telegram message, or assistant reply. Revoke it by setting `revoked_at = now()` on its exact row if this computer/profile is compromised.
4. Verified Hermes discovers exactly one Trade Notes writer tool. SQL tests ran inside transactions ending in `ROLLBACK`: stock buy1/buy2, dedupe, partial/full sell, over-sell rejection, matching with and without MatchKey, option multiplier/P&L, short P&L, and invalid-token rejection. The route correction was also tested inside a rolled-back transaction: Position and Swing on the same ticker stayed separate, and the old Nut route was rejected. A live MCP request with an intentionally incomplete payload proved authenticated RPC connectivity without writing a production trade. `tests/live-connection-smoke.mjs` implements that check.
5. Switched the active Trade logs group prompts and the trade-slip logger instructions from Sheet to Trade Notes; marked the former group as retired. Only workflow lines in `SOUL.md` and `memories/MEMORY.md` changed; Tsuki's style section, user profile, and Stella/PCC were not changed. Hermes gateway restarted and a no-tool `PING` returned in the existing feminine Thai voice.
6. The user sent a genuine slip and reported that Tsuki logged it quickly. A later read-only review found the resulting fill and fee in Trade Notes. No synthetic trade was retained. If a future slip lacks a required fact, Tsuki should ask one question and write nothing.
