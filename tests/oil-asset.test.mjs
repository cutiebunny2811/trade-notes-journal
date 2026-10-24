import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../dist/app.js', import.meta.url)), 'utf8');
const html = readFileSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)), 'utf8');
const assets = app.slice(app.indexOf('const ASSETS = ['), app.indexOf('const emotionLabels'));
const classification = app.slice(app.indexOf('function tradeAsset('), app.indexOf('function scopedTrades('));

test('oil can be selected and filtered without changing existing asset classes', () => {
  assert.match(html, /data-market="oil"[^>]*>น้ำมัน<\/button>/);
  assert.match(html, /<option value="oil">น้ำมัน \/ OIL<\/option>/);
  const context = {};
  runInNewContext(`${assets}\n${classification}\nthis.tradeAsset = tradeAsset; this.assetLabel = assetLabel;`, context);
  assert.equal(context.tradeAsset({ assetClass: 'oil', symbol: 'CL' }), 'oil');
  assert.equal(context.tradeAsset({ symbol: 'USOIL' }), 'oil');
  assert.equal(context.tradeAsset({ symbol: 'XTIUSD' }), 'oil');
  assert.equal(context.tradeAsset({ symbol: 'XAUUSD' }), 'gold');
  assert.equal(context.tradeAsset({ symbol: 'AAPL' }), 'stock');
  assert.equal(context.assetLabel('oil'), 'น้ำมัน');
});
