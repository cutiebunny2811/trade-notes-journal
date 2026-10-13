# Journal data contract (v4)

Trade Notes stores one JSON `data` document per row in `public.journal_trades`, with a UUID `id` and owner `user_id` in separate columns. The browser authenticates through Supabase Auth; RLS limits rows and screenshots to that user. This document is a format reference for a future Hermes integration, **not** an invitation to embed credentials in GitHub or client code.

```json
{
  "id": "trade-uuid",
  "matchKey": "TN-trade-uuid",
  "lane": null,
  "assetClass": "stock",
  "tradeStyle": "swing",
  "optionContract": null,
  "symbol": "AAPL",
  "status": "pending",
  "direction": "LONG",
  "date": "2026-10-13T18:30",
  "pl": null,
  "setup": "",
  "emotions": {
    "before": null,
    "during": null,
    "after": null
  },
  "notes": "Entry thesis and what to review",
  "imagePaths": []
}
```

`assetClass`: `gold` | `stock` | `option` | `crypto`. The quick form uses the underlying stock symbol as an option's simple name. A future slip writer must also set `optionContract` (expiry date, strike, call/put) before matching an option fill; matching only by underlying ticker is unsafe. `tradeStyle`: `swing` | `day` | `position` for stock/option entries, otherwise `null`. `status`: `pending` | `closed`. A pending entry has `pl: null` and `emotions.after: null`; a closed entry may have numeric USD P/L or `null` if the cost basis is still unknown. Before/during: `confident` | `anxious` | `hesitant` | `fomo`. After: `satisfied` | `proud` | `disappointed` | `regretful`. `imagePaths` contains private Storage object paths, not public URLs.

Old entries may omit `assetClass` and `tradeStyle`. The UI infers GOLD/XAU as gold and common crypto tickers as crypto; otherwise it displays stock. Editing and saving an older entry writes an explicit class. The UI does not automatically rewrite historical records.

Quick entries may have `setup: ""` and `emotions.before/during/after: null`; the app must never infer these from a broker slip. A new manual entry receives a stable `matchKey` based on its UUID. Existing entries without one receive it the next time they are saved. `lane` can be `nut`, `ging`, `swing`, or `option` when known; a missing lane is not silently guessed. A bot-calculated result will set `plSource: "fills"`, keeping manual P/L entry read-only. A closed trade with an unknown cost basis may have `pl: null` and is excluded from P/L and win-rate calculations until reconciled. The browser must preserve fields it does not edit when saving a journal row, and reject a stale save instead of overwriting a newer bot update.

## Manual stock fills (live)

A saved stock trade can contain a `data.fills` array. Each fill has `id` (UUID), `source: "manual"`, `sourceKey: "manual:<id>"`, `action: "buy" | "sell"`, positive `quantity`, nonnegative `unitPrice`, `multiplier: 1`, separate nonnegative `commission` and `otherFees`, UTC `executedAt`, and `createdAt`. The UI sorts by execution time, shows sequential opening buys (or opening sells for a SHORT), allows edit/delete of manual fills, and rejects an exit exceeding the open quantity. A new position after full exit needs a new trade/MatchKey.

The browser calculates realized P/L with **weighted-average cost**: gross is quantity × unit price × multiplier; opening fees are added to long cost (or subtracted from short proceeds), and closing fees are deducted at exit. The journal is `pending` while shares remain and `closed` only when all shares have exited. A partial exit's realized P/L is visible in the execution detail but is not included in closed-trade Insights. This is a journal performance method, not tax-lot accounting. If all fills are deleted, the trade returns to pending with unknown P/L. Manual fills reuse the existing private `journal_trades` JSON row and its RLS; they do not need the separate ledger migration.

## Execution ledger (prepared, not yet live)

`supabase/migrations/20261014000000_journal_fills.sql` defines private `journal_fills`, with one row per confirmed broker fill, linked to a journal trade. It records `side`, `quantity`, `unit_price`, `multiplier`, `commission`, `other_fees`, `executed_at`, original broker time text, and optional private evidence path. Gross BUY/SELL is `quantity × unit_price × multiplier` (100 for a standard equity option contract); fees stay separate. A per-user unique `source_key` prevents replaying the same fill. The stable `matchKey` belongs to the trade, not to a Telegram message. `broker_execution_id`, when present, is the preferred fill identity; otherwise the bot must use a stable message identity plus a fill ordinal. If the same broker fill is forwarded in another message, the bot must detect that before writing.

The migration file is only a repository artifact until it has been applied to the live Supabase project. Do not enable a bot writer before deploying and verifying it. The existing app continues to save quick journal entries using `journal_trades` alone.

Before moving bot writes to `journal_fills`, copy any existing manual `data.fills` exactly once into that table with their stable source keys, verify each trade's count and calculated totals, and switch the reader to a single ledger-backed projection. Never display both copies as two executions.

## Hermes handoff

The Insights page can export all entries and setups as a JSON file with `schemaVersion: 2`. The file excludes signed image URLs and includes private `imagePaths`; keep it private. For Hermes to read or write directly later, use a user-authorized Supabase session or a narrowly scoped backend that respects the owner `user_id` and the same RLS policies. The future bot endpoint may auto-save a clearly identified, confirmed broker fill without a user confirmation tap, but it must stop and ask one targeted question when the lane, contract, or existing trade is ambiguous. Read the inserted fill and updated trade back before claiming success. Do not commit passwords, service-role keys, session tokens, or exported journal files. A GitHub repository alone does not grant Hermes access to private journal rows or screenshots.
