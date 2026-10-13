# Tsuki → Trade Notes workflow

The writer implementation lives in `supabase/migrations/20261015000000_tsuki_writer.sql` and `hermes-mcp/server.mjs`. It is **not active** until the SQL is deployed, an owner-bound token is issued, the MCP adapter is configured in the Hermes `trader` profile, and the current Telegram channel prompt is switched. Stella's PCC draft/portfolio workflow stays separate. Tsuki reads the original broker slip, not Stella's reply. GitHub hosts app code, not trade records.

## Routing

| Message context | Journal lane | Asset |
| --- | --- | --- |
| `nut`, `webull longterm` | `nut` | stock |
| `ging` | `ging` | stock |
| `webull swing`, `swing buy1/buy2/sell` | `swing` | stock |
| `webull option`, `option buy/sell` | `option` | option |

The quick journal form keeps its existing asset and holding-style selectors. It does not require a lane for a manual note. A bot fill must have a known lane before writing. Option matching also requires the exact expiration, strike, and call/put; the underlying ticker alone is insufficient.

## Safe automatic write

1. Process only a broker-confirmed execution. An unfilled order, PCC draft, `SETUP`, `TEST`, `PING`, or unrelated message does not create a fill.
2. Parse Webull dates as **DD/MM/YY**. Convert Thai Buddhist years to Gregorian years by subtracting 543. Preserve the broker's original time text and timezone alongside the normalized timestamp.
3. Resolve one trade by owner, lane/account, asset, symbol or exact option contract, direction, and open cycle. The stable journal UUID/`matchKey` identifies the chosen trade after matching. `buy2` and partial sales add a fill to that trade; a completed cycle and a new entry become a new trade. Do not infer a match from ticker alone if multiple candidates exist.
4. Prefer a broker execution ID for deduplication. Otherwise use `tg:<chat_id>:<message_id>:<fill_ordinal>` as `sourceKey`; if the broker ID is available without Telegram identity, use `broker:<broker>:<id>`. A missing stable identity is a reason to ask, not to invent one. The database records each accepted source once and pauses when a forwarded copy may match an earlier fill.
5. Store each fill's quantity, unit price, multiplier, commission, other fees, and broker time text separately. Gross BUY/SELL is quantity × price × multiplier; commission and other fees are not folded into gross. Do not invent Setup, emotions, or a cost basis. The first writer version keeps the Telegram source identity but does **not** upload the original slip image to Trade Notes Storage; Stella/PCC remains independent.
6. When all required facts and exactly one match are clear, write automatically **without a confirmation tap**. Re-read the fill and trade summary before reporting success. If a required fact is missing, the match is ambiguous, or a duplicate cannot be distinguished, write nothing and ask one targeted question.
7. Reply briefly in Thai with what was recorded and, for a partial sale, the remaining quantity. Do not expose logs, credentials, account IDs, or private MatchKey in routine chat replies.

The writer uses the same weighted-average P/L formula as the browser and rejects an exit beyond the open position. If an opening fill is missing, the closing slip is not written and P/L remains unknown; Tsuki asks for the missing trade rather than fabricating a cost basis. The current browser displays bot fills but does not edit their execution facts. A correction flow must update the original fill and receipt with an audit trail; it must not append a duplicate.

## Cutover checklist

1. Apply only `20261015000000_tsuki_writer.sql` to the Trade Notes Supabase project. Do **not** apply the earlier `20261014000000_journal_fills.sql` proposal.
2. Run read-only SQL checks for token/receipt table permissions and the RPC grant. Test the weighted-average helper with synthetic fills.
3. Issue one expiring `tn_...` token bound to the existing Trade Notes owner and put it only in the private Hermes `trader` profile. Never expose it in a public repository, URL, browser code, Telegram message, or assistant reply.
4. Register `hermes-mcp/server.mjs` in that profile. Verify `tools/list`, reject a missing/invalid token, then test a synthetic buy, repeated same source, an over-sell, and a partial/full exit. Remove only the synthetic journal trade after verifying it; keep the source receipt as a replay tombstone.
5. Switch only the active Trade Logs Telegram channel prompt and trade-slip logger work instructions from Sheet to Trade Notes. Do not change `SOUL.md`, `memories/USER.md`, `memories/MEMORY.md`, persona, or Stella/PCC. Keep the old Sheet as read-only history. Confirm a real broker slip only after the synthetic test passes.
