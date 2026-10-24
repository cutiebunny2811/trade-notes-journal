# Journal data contract (v4)

Trade Notes stores one JSON `data` document per row in `public.journal_trades`, with a UUID `id` and owner `user_id` in separate columns. The browser authenticates through Supabase Auth; RLS limits rows and screenshots to that user. This document is a format reference for a future Hermes integration, **not** an invitation to embed credentials in GitHub or client code.

```json
{
  "id": "trade-uuid",
  "matchKey": "TN-trade-uuid",
  "lane": null,
  "portfolioKey": "WEBULL SWING A",
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

`assetClass`: `gold` | `oil` | `stock` | `option` | `crypto`. The quick form uses the underlying stock symbol as an option's simple name. A future slip writer must also set `optionContract` (expiry date, strike, call/put) before matching an option fill; matching only by underlying ticker is unsafe. `tradeStyle`: `swing` | `day` | `position` for stock/option entries, otherwise `null`. `status`: `pending` | `closed`. A pending entry has `pl: null` and `emotions.after: null`; a closed entry may have numeric USD P/L or `null` if the cost basis is still unknown. Before/during: `confident` | `anxious` | `hesitant` | `fomo`. After: `satisfied` | `proud` | `disappointed` | `regretful`. `imagePaths` contains private Storage object paths, not public URLs.

Old entries may omit `assetClass` and `tradeStyle`. The UI infers GOLD/XAU as gold, common oil symbols as oil, and common crypto tickers as crypto; otherwise it displays stock. Editing and saving an older entry writes an explicit class. The UI does not automatically rewrite historical records.

Quick entries may have `setup: ""` and `emotions.before/during/after: null`; the app must never infer these from a broker slip. A new manual entry receives a stable `matchKey` based on its UUID. Existing entries without one receive it the next time they are saved. `portfolioKey` is an optional stable private account/portfolio identifier, independent of `lane`; old rows remain unscoped until the user labels them. Bot `lane` is `swing`, `option`, or `position`; retired Nut/Ging/longterm captions are never mapped automatically. A missing lane is not silently guessed. A bot-calculated result will set `plSource: "fills"`, keeping manual P/L entry read-only. A closed trade with an unknown cost basis may have `pl: null` and is excluded from P/L and win-rate calculations until reconciled. The browser must preserve fields it does not edit when saving a journal row, and reject a stale save instead of overwriting a newer bot update.

## Manual stock fills (live)

A saved stock trade can contain a `data.fills` array. Each fill has `id` (UUID), `source: "manual"`, `sourceKey: "manual:<id>"`, `action: "buy" | "sell"`, positive `quantity`, nonnegative `unitPrice`, `multiplier: 1`, separate nonnegative `commission` and `otherFees`, UTC `executedAt`, and `createdAt`. The UI sorts by execution time, shows sequential opening buys (or opening sells for a SHORT), allows edit/delete of manual fills, and rejects an exit exceeding the open quantity. A new position after full exit needs a new trade/MatchKey.

The browser calculates realized P/L with **weighted-average cost**: gross is quantity × unit price × multiplier; opening fees are added to long cost (or subtracted from short proceeds), and closing fees are deducted at exit. The journal is `pending` while shares remain and `closed` only when all shares have exited. A partial exit's realized P/L is visible in the execution detail but is not included in closed-trade Insights. This is a journal performance method, not tax-lot accounting. If all fills are deleted, the trade returns to pending with unknown P/L. Manual fills reuse the existing private `journal_trades` JSON row and its RLS; they do not need the separate ledger migration.

## Tsuki writer (separate deployment)

`supabase/migrations/20261015000000_tsuki_writer.sql` is the deployment for Tsuki. It keeps `journal_trades.data.fills` as the sole execution source read by the existing app, adding a private agent-token table, private idempotency receipts, and an atomic `api_tsuki_record_fill` RPC. The RPC verifies a revocable random token, owner, route, exact contract, source identity, possible forwarded duplicate, matching open trade, position quantity and fees before changing the journal. It recalculates weighted-average P/L and reads the inserted fill back within the same database transaction. The browser's optimistic `updated_at` check prevents a stale manual save from overwriting a new bot fill. Bot fills remain read-only in the form. The later `20261015020000_tsuki_review_correction.sql` migration adds a separate audited correction RPC that updates one identified bot fill and its receipt, never a duplicate append, plus a bounded read-only journal review RPC.

This migration and `hermes-mcp/server.mjs` have to be deployed/configured before any Telegram prompt is switched from Google Sheets. The public publishable key permits calling the RPC but cannot authorize a write without the separate Tsuki token. Store that token only in Hermes' private profile configuration; never in the app, GitHub, or a chat message.

## Earlier ledger proposal (not deployed)

`supabase/migrations/20261014000000_journal_fills.sql` is an earlier, unapplied normalized-ledger proposal. Do not apply it alongside the current Tsuki writer; doing so would introduce a second execution source without migrating the browser reader. A later ledger migration would need a one-time copy of existing `data.fills` and one canonical projection.

The writer, route correction, and review/correction migrations were applied to the Trade Notes Supabase project on 2026-10-14. Do not enable any later bot capability until its SQL and adapter are both deployed and verified.

## Hermes handoff

The Insights page can export all entries and setups as a JSON file with `schemaVersion: 2`. The file excludes signed image URLs and includes private `imagePaths`; keep it private. For Hermes to read or write directly later, use a user-authorized Supabase session or a narrowly scoped backend that respects the owner `user_id` and the same RLS policies. The future bot endpoint may auto-save a clearly identified, confirmed broker fill without a user confirmation tap, but it must stop and ask one targeted question when the lane, contract, or existing trade is ambiguous. Read the inserted fill and updated trade back before claiming success. Do not commit passwords, service-role keys, session tokens, or exported journal files. A GitHub repository alone does not grant Hermes access to private journal rows or screenshots.
