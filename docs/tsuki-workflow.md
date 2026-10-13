# Tsuki → Trade Notes workflow (implementation contract)

This is the planned bot handoff, **not an active integration**. Stella's PCC draft/portfolio workflow stays separate. Tsuki reads the original broker slip, not Stella's reply, and writes only to the owner's private Trade Notes data through a narrowly scoped server endpoint. GitHub hosts the app code, not the user's trade records.

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
4. Prefer a broker execution ID for deduplication. Otherwise use a stable Telegram chat/message identity plus fill ordinal as `source_key`; check for forwarded copies of the same broker fill. The database enforces uniqueness per owner.
5. Store each fill's quantity, unit price, multiplier, commission, other fees, timestamp, and evidence reference separately. Gross BUY/SELL is quantity × price × multiplier; commission and other fees are not folded into gross. Do not invent Setup, emotions, or a cost basis.
6. When all required facts and exactly one match are clear, write automatically **without a confirmation tap**. Re-read the fill and trade summary before reporting success. If a required fact is missing, the match is ambiguous, or a duplicate cannot be distinguished, write nothing and ask one targeted question.
7. Reply briefly in Thai with what was recorded and, for a partial sale, the remaining quantity. Do not expose logs, credentials, account IDs, or private MatchKey in routine chat replies.

P/L and realized cost basis calculation must be implemented and tested before bot-computed `plSource: "fills"` is enabled. A closed trade with incomplete cost basis keeps `pl: null` and is excluded from performance metrics. Corrections should update the original fill or trade with an audit trail, not silently add a second copy.
