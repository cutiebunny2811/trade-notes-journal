# Trade Notes Journal

Personal trading journal for gold, stocks, options, and crypto. Save pending or closed positions, P/L in USD, editable setups, emotions through the trade, and order screenshots. Entries can be edited or deleted with confirmation; deleting an entry also removes its linked screenshots. The journal screener filters by asset class, symbol, and status. The Insights view compares market, setup, symbol, entry emotion, and holding style, and opens trades needing review.

The entry form is quick-first: asset, symbol, holding style, status, direction, and a short note stay visible; date, setup, emotions, and screenshots are optional details. New entries do not silently select a setup or emotion. A stable `matchKey` is assigned when a manual entry is saved, and bot-managed execution fields are preserved when a note is edited.

For stocks, save the quick entry to open **ไม้ซื้อ–ขาย** immediately; opening an existing stock row returns directly to its fills. Add, edit, or remove buy/sell executions with quantity, price, time, and separate fees. The list labels ซื้อไม้ 1 / ซื้อไม้ 2 / ขายบางส่วน / ขายปิดครบ and shows remaining shares, weighted-average entry cost, and realized P/L. A fully closed position sets journal P/L automatically; a partial sale stays open and is excluded from closed-trade Insights. One completed position cycle gets one MatchKey; entering again after a full exit requires a new journal entry. This manual feature uses the existing authenticated `journal_trades` row and is live without a database migration. No Google Sheet history is imported.

The app is a static app in `dist/`, backed by Supabase Authentication, Postgres, and a private Storage bucket. GitHub Pages publishes `dist/` at https://cutiebunny2811.github.io/trade-notes-journal/ through `.github/workflows/deploy-pages.yml`; the earlier Codex Site remains available at https://trade-notes-journal.politecalf32.chatgpt.site/. The public Supabase publishable key in `dist/app.js` is intentionally client-side; access to journal data and screenshots is restricted by Row Level Security policies in `supabase/migrations/20261013000000_trade_notes.sql`. Never place a Supabase secret or service-role key in this repository or browser code.

## Development

Serve `dist/` with any static file server, for example `python -m http.server 4173 --directory dist`, then visit `http://127.0.0.1:4173/`. The GitHub Pages URL must be on the Supabase Auth redirect allow list for email-confirmation links. Existing password sign-in works on both hosts, but each host stores its own browser session.

## Existing journal data

On the first authenticated visit in the original browser, the app imports any `trade-notes:v1:*` data from that browser's local storage into the signed-in Supabase account, uploading screenshots to private Storage. It keeps the original local data and attempts to save a separate pre-cloud backup in local storage. Sign in from the browser that contains the existing trades before switching devices. Subsequent devices load the cloud journal.

## Data model

- `journal_trades`: one JSON document per trade, owned by `user_id`. Manual stock executions are currently stored in its `data.fills` array with stable fill IDs and source keys.
- `journal_setups`: editable setup names, owned by `user_id`.
- `trade-images` Storage bucket: private screenshots under `<user_id>/<trade_id>/<image_id>.jpg`; the browser uses time-limited signed URLs for display.

Trade JSON now includes `assetClass` (`gold`, `stock`, `option`, `crypto`) and optional `tradeStyle` (`swing`, `day`, `position`) for stocks/options. Existing records without `assetClass` remain readable and are classified in the UI by symbol; they are not rewritten until edited. See [docs/journal-schema.md](docs/journal-schema.md) for the format and future Hermes integration boundary. The Insights “ส่งออก JSON” control downloads a private copy of all entries and setups, without signed image URLs; treat the export as sensitive personal data.

The Tsuki writer is in `supabase/migrations/20261015000000_tsuki_writer.sql` and `hermes-mcp/server.mjs`. It writes to the same `data.fills` array the current app displays, with a separate private receipt table for deduplication. On 2026-10-14 the migration was applied to the Trade Notes Supabase project, one expiring owner-bound token was issued in the private Hermes `trader` profile, and the active Trade logs prompts were switched from Sheets to Trade Notes. SQL rollback scenarios, MCP discovery, a live authenticated no-write RPC check, and a `PING` response passed. A real Telegram slip has not yet been observed end to end; see [docs/tsuki-workflow.md](docs/tsuki-workflow.md) for the contract and remaining verification step. The older `20261014000000_journal_fills.sql` ledger proposal is **not** part of this deployment and must not be applied without a separate data migration.
