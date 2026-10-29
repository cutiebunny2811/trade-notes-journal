import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../dist/app.js', import.meta.url)), 'utf8');
const html = readFileSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../dist/gridgeist.css', import.meta.url)), 'utf8');
const pageSource = app.slice(app.indexOf('function journalPageSlice('), app.indexOf('function updateAssetFields('));
const fetchSource = app.slice(app.indexOf('async function fetchAllRows('), app.indexOf('function dataUrlBlob('));
const imageSource = app.slice(app.indexOf('async function signedImageUrls('), app.indexOf('async function prepareRemoteTrade('));

test('journal pages bound the visible list and allow direct jumps', () => {
  const context = {};
  runInNewContext(`const JOURNAL_PAGE_SIZE=10;${pageSource};this.slice=journalPageSlice`, context);
  const rows = Array.from({ length: 1005 }, (_, index) => index);
  const first = context.slice(rows, 1);
  assert.deepEqual([...first.items], rows.slice(0, 10));
  assert.equal(first.pageCount, 101);
  const middle = context.slice(rows, 77);
  assert.deepEqual([...middle.items], rows.slice(760, 770));
  assert.equal(context.slice(rows, 999).page, 101);
  assert.equal(context.slice([], 4).page, 1);
  assert.match(html, /id="pageNumber" type="number"/);
  assert.match(css, /#tradeList\{max-height:none;overflow:visible\}/);
});

test('cloud loader fetches every batch beyond the default 1000-row limit', async () => {
  const rows = Array.from({ length: 1005 }, (_, index) => ({ id: index }));
  const ranges = [];
  const query = { select() { return this; }, order() { return this; }, async range(start, end) {
    ranges.push([start, end]);
    return { data: rows.slice(start, end + 1), error: null };
  } };
  const context = { cloud: { from() { return query; } } };
  runInNewContext(`${fetchSource};this.fetchAllRows=fetchAllRows`, context);
  const result = await context.fetchAllRows('journal_trades', 'id,data,updated_at', false);
  assert.equal(result.length, 1005);
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
});

test('private image URLs are signed in bounded batches', async () => {
  const paths = Array.from({ length: 205 }, (_, index) => `private/${index}.jpg`);
  const batches = [];
  const context = { cloud: { storage: { from() { return { async createSignedUrls(batch) {
    batches.push(batch.length);
    return { data: batch.map(path => ({ path, signedUrl: `signed:${path}`, error: null })), error: null };
  } }; } } } };
  runInNewContext(`${imageSource};this.signedImageUrls=signedImageUrls`, context);
  const rows = paths.map(path => ({ data: { imagePaths: [path] } }));
  const urls = await context.signedImageUrls(rows);
  assert.deepEqual(batches, [100, 100, 5]);
  assert.equal(urls.get(paths[204]), `signed:${paths[204]}`);
});
