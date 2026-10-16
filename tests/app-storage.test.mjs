import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const app = readFileSync(fileURLToPath(new URL("../dist/app.js", import.meta.url)), "utf8");
const saveSource = app.slice(app.indexOf("function save(){"), app.indexOf("\nfunction cloudError"));

test("cloud-backed local cache excludes every image and a quota error cannot misreport a cloud save", () => {
  const values = new Map();
  const localStorage = {
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const context = { localStorage, STORAGE: { trades: "trades", setups: "setups" },
    trades: [{ id: "one", images: ["data:image/jpeg;base64,huge"], imagePaths: ["private/one.jpg"] }],
    setups: ["Breakout"], cloudReady: true };
  runInNewContext(`${saveSource}\nsave();`, context);
  const cached = JSON.parse(values.get("trades"));
  assert.equal(Object.hasOwn(cached[0], "images"), false);
  assert.deepEqual(cached[0].imagePaths, ["private/one.jpg"]);

  localStorage.setItem = () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };
  assert.doesNotThrow(() => runInNewContext(`${saveSource}\nsave();`, context));
  assert.equal(values.has("trades"), false);
});
