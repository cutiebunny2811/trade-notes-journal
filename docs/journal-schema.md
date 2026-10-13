# Journal data contract (v2)

Trade Notes stores one JSON `data` document per row in `public.journal_trades`, with a UUID `id` and owner `user_id` in separate columns. The browser authenticates through Supabase Auth; RLS limits rows and screenshots to that user. This document is a format reference for a future Hermes integration, **not** an invitation to embed credentials in GitHub or client code.

```json
{
  "id": "trade-uuid",
  "assetClass": "stock",
  "tradeStyle": "swing",
  "symbol": "AAPL",
  "status": "pending",
  "direction": "LONG",
  "date": "2026-10-13T18:30",
  "pl": null,
  "setup": "Trend Pullback",
  "emotions": {
    "before": "confident",
    "during": "hesitant",
    "after": null
  },
  "notes": "Entry thesis and what to review",
  "imagePaths": []
}
```

`assetClass`: `gold` | `stock` | `option` | `crypto`. An option entry uses the underlying stock symbol as its simple name in this version; contract fields are not yet recorded. `tradeStyle`: `swing` | `day` | `position` for stock/option entries, otherwise `null`. `status`: `pending` | `closed`. A pending entry has `pl: null` and `emotions.after: null`; a closed entry has numeric USD P/L and may record exit emotion. Before/during: `confident` | `anxious` | `hesitant` | `fomo`. After: `satisfied` | `proud` | `disappointed` | `regretful`. `imagePaths` contains private Storage object paths, not public URLs.

Old entries may omit `assetClass` and `tradeStyle`. The UI infers GOLD/XAU as gold and common crypto tickers as crypto; otherwise it displays stock. Editing and saving an older entry writes an explicit class. The UI does not automatically rewrite historical records.

## Hermes handoff

The Insights page can export all entries and setups as a JSON file with `schemaVersion: 2`. The file excludes signed image URLs and includes private `imagePaths`; keep it private. For Hermes to read or write directly later, use a user-authorized Supabase session or a narrowly scoped backend that respects the owner `user_id` and the same RLS policies. Do not commit passwords, service-role keys, session tokens, or exported journal files. A GitHub repository alone does not grant Hermes access to private journal rows or screenshots.
