// Benchmark tasks. Each task is a small project, a prompt, a hidden test the
// agent never sees, and a reference solution used by `run.mjs --selfcheck` to
// prove the hidden test fails before and passes after a correct change.

const pkg = (name) => JSON.stringify({ name, version: "1.0.0", private: true, scripts: { test: "node --test" } }, null, 2) + "\n";
const r = String.raw;

// ---------- 1. bug fix in one file ----------
const lru = {
  name: "lru-bugfix",
  prompt: "Users report that our LRU cache (src/lru.js) sometimes evicts entries that were just read, and that updating an existing key can throw out another entry even though the cache is not growing. Fix it.",
  files: {
    "package.json": pkg("lru"),
    "src/lru.js": `class LRU {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    return this.map.get(key);
  }

  set(key, value) {
    if (this.map.size >= this.capacity) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, value);
  }

  has(key) {
    return this.map.has(key);
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { LRU };
`,
    "test/lru.test.js": `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { LRU } = require("../src/lru");

test("stores and returns values", () => {
  const c = new LRU(2);
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("zz"), undefined);
});

test("never grows beyond capacity", () => {
  const c = new LRU(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.size, 2);
});
`,
  },
  hidden: () => ({
    "__hidden.test.js": `const assert = require("node:assert/strict");
const { LRU } = require("./src/lru");
const c = new LRU(2);
c.set("a", 1); c.set("b", 2);
assert.equal(c.get("a"), 1);
c.set("c", 3);
assert.ok(c.has("a"), "a was just read and must survive");
assert.ok(!c.has("b"));
const d = new LRU(2);
d.set("a", 1); d.set("b", 2); d.set("a", 9);
assert.equal(d.size, 2);
assert.ok(d.has("b"), "updating a key must not evict another");
assert.equal(d.get("a"), 9);
assert.equal(d.get("missing"), undefined);
const e = new LRU(1);
e.set("x", 1); e.set("y", 2);
assert.ok(!e.has("x")); assert.equal(e.get("y"), 2);
`,
  }),
  solution: {
    "src/lru.js": `class LRU {
  constructor(capacity) { this.capacity = capacity; this.map = new Map(); }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) this.map.delete(this.map.keys().next().value);
    this.map.set(key, value);
  }
  has(key) { return this.map.has(key); }
  get size() { return this.map.size; }
}
module.exports = { LRU };
`,
  },
};

// ---------- 2. API change across files ----------
const datesLib = (name, invalid) => r`function ${name}(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
  if (!m) ${invalid}
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) ${invalid}
  return { year, month, day };
}

module.exports = { ${name} };
`;
const rename = {
  name: "rename-across-files",
  prompt: "Rename `parseDate` in lib/dates.js to `parseIsoDate`, and change it to throw a TypeError for invalid input instead of returning null. Update every caller so that its own behaviour stays exactly as it is today (same return values for valid and for invalid input). The package entry point src/index.js must export `parseIsoDate` instead of `parseDate`.",
  files: {
    "package.json": pkg("dates"),
    "lib/dates.js": datesLib("parseDate", "return null;"),
    "src/invoice.js": `const { parseDate } = require("../lib/dates");

/** Year an invoice is due, or null when the date is unusable. */
function dueYear(invoice) {
  const d = parseDate(invoice.due);
  return d ? d.year : null;
}

module.exports = { dueYear };
`,
    "src/report/age.js": `const dates = require("../../lib/dates");

/** Age in whole years at the end of nowYear; -1 for an unusable birth date. */
function age(birth, nowYear) {
  const d = dates.parseDate(birth);
  if (!d) return -1;
  return nowYear - d.year;
}

module.exports = { age };
`,
    "src/filters.js": `const { parseDate: pd } = require("../lib/dates");

/** Keep only the strings that are valid ISO dates. */
function validDates(list) {
  return list.filter((s) => pd(s) !== null);
}

module.exports = { validDates };
`,
    "src/index.js": `module.exports = {
  ...require("./invoice"),
  ...require("./report/age"),
  ...require("./filters"),
  parseDate: require("../lib/dates").parseDate,
};
`,
    "test/dates.test.js": `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseDate } = require("../lib/dates");

test("parses ISO dates", () => {
  assert.deepEqual(parseDate("2024-02-03"), { year: 2024, month: 2, day: 3 });
});

test("rejects other input", () => {
  assert.equal(parseDate("03.02.2024"), null);
  assert.equal(parseDate("2024-13-01"), null);
});
`,
  },
  hidden: () => ({
    "__hidden.test.js": `const assert = require("node:assert/strict");
const api = require("./src");
assert.equal(typeof api.parseIsoDate, "function");
assert.equal(api.parseDate, undefined);
assert.equal(require("./lib/dates").parseDate, undefined);
assert.throws(() => api.parseIsoDate("nope"), TypeError);
assert.throws(() => api.parseIsoDate("2024-13-01"), TypeError);
assert.deepEqual(api.parseIsoDate("2024-02-03"), { year: 2024, month: 2, day: 3 });
assert.equal(api.dueYear({ due: "2025-01-02" }), 2025);
assert.equal(api.dueYear({ due: "x" }), null);
assert.equal(api.age("2000-01-01", 2024), 24);
assert.equal(api.age("", 2024), -1);
assert.deepEqual(api.validDates(["2024-01-01", "bad", "2023-12-31"]), ["2024-01-01", "2023-12-31"]);
`,
  }),
  solution: {
    "lib/dates.js": datesLib("parseIsoDate", 'throw new TypeError("invalid date");'),
    "src/invoice.js": `const { parseIsoDate } = require("../lib/dates");
function dueYear(invoice) { try { return parseIsoDate(invoice.due).year; } catch { return null; } }
module.exports = { dueYear };
`,
    "src/report/age.js": `const dates = require("../../lib/dates");
function age(birth, nowYear) { try { return nowYear - dates.parseIsoDate(birth).year; } catch { return -1; } }
module.exports = { age };
`,
    "src/filters.js": `const { parseIsoDate } = require("../lib/dates");
function validDates(list) { return list.filter((s) => { try { parseIsoDate(s); return true; } catch { return false; } }); }
module.exports = { validDates };
`,
    "src/index.js": `module.exports = { ...require("./invoice"), ...require("./report/age"), ...require("./filters"), parseIsoDate: require("../lib/dates").parseIsoDate };
`,
  },
};

// ---------- 3. feature with edge cases ----------
const slugBase = r`    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");`;
const slug = {
  name: "slug-max-length",
  prompt: "Add an optional second argument `options` to `slugify` in src/slug.js. With `options.maxLength` the slug is at most that many characters long. It is cut at a word boundary (words are the parts between '-') whenever at least one whole word fits, and it never ends with '-'. If even the first word is longer than maxLength, that word is cut hard. Without the option the behaviour is unchanged.",
  files: {
    "package.json": pkg("slug"),
    "src/slug.js": `function slugify(text) {
  return String(text)
${slugBase}
}

module.exports = { slugify };
`,
    "test/slug.test.js": `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { slugify } = require("../src/slug");

test("basic slugs", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Crème brûlée!  "), "creme-brulee");
  assert.equal(slugify("a--b"), "a-b");
});
`,
  },
  hidden: () => ({
    "__hidden.test.js": `const assert = require("node:assert/strict");
const { slugify } = require("./src/slug");
assert.equal(slugify("Hello World"), "hello-world");
assert.equal(slugify("  Crème brûlée!  "), "creme-brulee");
assert.equal(slugify("Hello World Again", { maxLength: 100 }), "hello-world-again");
assert.equal(slugify("Hello World Again", { maxLength: 17 }), "hello-world-again");
assert.equal(slugify("Hello World Again", { maxLength: 16 }), "hello-world");
assert.equal(slugify("Hello World Again", { maxLength: 11 }), "hello-world");
assert.equal(slugify("Hello World Again", { maxLength: 10 }), "hello");
assert.equal(slugify("Hello World Again", { maxLength: 6 }), "hello");
assert.equal(slugify("Hello World Again", { maxLength: 5 }), "hello");
assert.equal(slugify("Hello World Again", { maxLength: 3 }), "hel");
assert.equal(slugify("a b c", { maxLength: 4 }), "a-b");
assert.equal(slugify("a b c", { maxLength: 2 }), "a");
assert.equal(slugify("Hello World", {}), "hello-world");
`,
  }),
  solution: {
    "src/slug.js": `function slugify(text, options = {}) {
  let s = String(text)
${slugBase}
  const max = options.maxLength;
  if (max && s.length > max) {
    if (s[max] === "-") s = s.slice(0, max);
    else {
      const i = s.lastIndexOf("-", max - 1);
      s = i > 0 ? s.slice(0, i) : s.slice(0, max);
    }
  }
  return s;
}
module.exports = { slugify };
`,
  },
};

// ---------- 4. small change in a large file ----------
const RESOURCES = ["users", "teams", "projects", "tasks", "comments", "labels", "invoices", "payments", "products", "carts", "coupons", "shipments", "addresses", "reviews", "tickets", "agents", "articles", "tags", "files", "folders", "events", "venues", "sessions", "tokens", "webhooks", "reports", "exports", "imports", "alerts", "rules"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const single = (s) => s.replace(/ies$/, "y").replace(/s$/, "");
function routesFile(fixed) {
  const out = [`// HTTP handlers. Each takes (req, db) and returns { status, body }.\n\nconst notFound = () => ({ status: 404, body: { error: "not_found" } });\nconst badRequest = (message) => ({ status: 400, body: { error: "bad_request", message } });\n`];
  const block = (res) => `
// ---- ${res} ----

function list${cap(res)}(req, db) {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;
  const items = db.${res}.slice(offset, offset + limit);
  return { status: 200, body: { items, total: db.${res}.length } };
}

function get${cap(single(res))}(req, db) {
  const item = db.${res}.find((x) => x.id === req.params.id);
  if (!item) return notFound();
  return { status: 200, body: item };
}

function create${cap(single(res))}(req, db) {
  if (!req.body || typeof req.body.name !== "string") return badRequest("name is required");
  const item = { id: String(db.${res}.length + 1), name: req.body.name };
  db.${res}.push(item);
  return { status: 201, body: item };
}
`;
  const orders = `
// ---- orders ----

function listOrders(req, db) {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;
  const items = db.orders.slice(offset, offset + limit);
  return { status: 200, body: { items, total: db.orders.length } };
}

function getOrder(req, db) {
  const order = db.orders.find((o) => o.id === req.params.id);${fixed ? "\n  if (!order) return notFound();" : ""}
  const total = order.lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  return { status: 200, body: { id: order.id, total, lines: order.lines.length } };
}
`;
  RESOURCES.forEach((res, i) => {
    out.push(block(res));
    if (i === 16) out.push(orders);
  });
  const names = RESOURCES.flatMap((res) => [`list${cap(res)}`, `get${cap(single(res))}`, `create${cap(single(res))}`]).concat(["listOrders", "getOrder"]);
  out.push(`\nmodule.exports = {\n${names.map((n) => `  ${n},`).join("\n")}\n};\n`);
  return out.join("");
}
const routes = {
  name: "large-file-edit",
  prompt: "In src/routes.js the handler for GET /orders/:id crashes when the order does not exist. Make it return { status: 404, body: { error: \"not_found\" } } in that case. Change nothing else in the file.",
  files: {
    "package.json": pkg("routes"),
    "src/routes.js": routesFile(false),
    "test/routes.test.js": `const { test } = require("node:test");
const assert = require("node:assert/strict");
const routes = require("../src/routes");

test("lists users", () => {
  const res = routes.listUsers({ query: {} }, { users: [{ id: "1", name: "a" }] });
  assert.equal(res.body.total, 1);
});
`,
  },
  hidden: (files) => ({
    "__orig_routes.js": files["src/routes.js"],
    "__hidden.test.js": `const assert = require("node:assert/strict");
const fs = require("node:fs");
const routes = require("./src/routes");
const db = { orders: [{ id: "7", lines: [{ price: 2, qty: 3 }, { price: 1, qty: 1 }] }], users: [] };
assert.deepEqual(routes.getOrder({ params: { id: "nope" } }, db), { status: 404, body: { error: "not_found" } });
assert.deepEqual(routes.getOrder({ params: { id: "7" } }, db), { status: 200, body: { id: "7", total: 7, lines: 2 } });
assert.equal(routes.getUser({ params: { id: "1" } }, db).status, 404);
assert.equal(Object.keys(routes).length, ${RESOURCES.length * 3 + 2});
const before = fs.readFileSync("__orig_routes.js", "utf8").split("\\n");
const after = fs.readFileSync("src/routes.js", "utf8").split("\\n");
const a = new Set(after), b = new Set(before);
const changed = after.filter((l) => !b.has(l)).length + before.filter((l) => !a.has(l)).length;
assert.ok(changed <= 8, "the rest of the file must stay as it was (" + changed + " lines differ)");
`,
  }),
  solution: { "src/routes.js": routesFile(true) },
};

// ---------- 5. bug whose cause is in another file than the failing test ----------
const cartTest = `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cartTotal } = require("../src/cart");

test("total includes rounded tax", () => {
  assert.equal(cartTotal([{ price: 9.99, qty: 1 }], { taxRate: 0.19 }), 11.89);
});

test("discount is applied before tax", () => {
  assert.equal(cartTotal([{ price: 50, qty: 2 }], { taxRate: 0.1, discount: 0.5 }), 55);
});

test("empty cart", () => {
  assert.equal(cartTotal([], { taxRate: 0.19 }), 0);
});
`;
const cart = {
  name: "cross-file-bug",
  prompt: "`npm test` fails in this project. Find the cause and fix it. Do not change the tests.",
  files: {
    "package.json": pkg("cart"),
    "src/rounding.js": `/** Round a money amount to whole cents. */
function roundCents(amount) {
  return Math.floor(amount * 100) / 100;
}

module.exports = { roundCents };
`,
    "src/tax.js": `const { roundCents } = require("./rounding");

/** Tax on a net amount, in whole cents. */
function taxFor(net, rate) {
  return roundCents(net * rate);
}

module.exports = { taxFor };
`,
    "src/cart.js": `const { roundCents } = require("./rounding");
const { taxFor } = require("./tax");

/** A discount of 0.5 means half price; the discount applies to the net amount only. */
function applyDiscount(net, discount = 0) {
  return net - net * discount;
}

function cartTotal(items, { taxRate = 0, discount = 0 } = {}) {
  const net = applyDiscount(items.reduce((sum, i) => sum + i.price * i.qty, 0), discount);
  return roundCents(net + taxFor(net, taxRate));
}

module.exports = { cartTotal, applyDiscount };
`,
    "test/cart.test.js": cartTest,
  },
  hidden: (files) => ({
    "__orig_cart.test.js": files["test/cart.test.js"],
    "__hidden.test.js": `const assert = require("node:assert/strict");
const fs = require("node:fs");
const { cartTotal } = require("./src/cart");
const { roundCents } = require("./src/rounding");
const { taxFor } = require("./src/tax");
assert.equal(fs.readFileSync("test/cart.test.js", "utf8").replace(/\\r/g, ""), fs.readFileSync("__orig_cart.test.js", "utf8").replace(/\\r/g, ""), "tests must be unchanged");
assert.equal(cartTotal([{ price: 9.99, qty: 1 }], { taxRate: 0.19 }), 11.89);
assert.equal(cartTotal([{ price: 50, qty: 2 }], { taxRate: 0.1, discount: 0.5 }), 55);
assert.equal(cartTotal([], { taxRate: 0.19 }), 0);
assert.equal(roundCents(1.8981), 1.9);
assert.equal(roundCents(2.344), 2.34);
assert.equal(roundCents(0.126), 0.13);
assert.equal(taxFor(100, 0.07), 7);
assert.equal(taxFor(9.99, 0.19), 1.9);
`,
  }),
  solution: {
    "src/rounding.js": `function roundCents(amount) { return Math.round(amount * 100) / 100; }
module.exports = { roundCents };
`,
  },
};

// ---------- 6. implement from a written spec ----------
const intervals = {
  name: "implement-from-spec",
  prompt: "Implement the two functions in src/intervals.js as specified in README.md.",
  files: {
    "package.json": pkg("intervals"),
    "README.md": `# intervals

Intervals are arrays \`[start, end]\` of numbers with start < end.

## merge(list)

Returns a new list in which overlapping intervals are combined, sorted by start.
Intervals that only touch (\`[1, 2]\` and \`[2, 3]\`) are combined too. The input is not modified.

## subtract(list, cut)

Returns a new, merged and sorted list covering everything in \`list\` that is not inside the interval \`cut\`.
Pieces of zero length are dropped. The input is not modified.

    subtract([[1, 10]], [3, 5])  ->  [[1, 3], [5, 10]]
`,
    "src/intervals.js": `function merge(list) {
  throw new Error("not implemented");
}

function subtract(list, cut) {
  throw new Error("not implemented");
}

module.exports = { merge, subtract };
`,
    "test/intervals.test.js": `const { test } = require("node:test");
const assert = require("node:assert/strict");
const intervals = require("../src/intervals");

test("exports", () => {
  assert.equal(typeof intervals.merge, "function");
  assert.equal(typeof intervals.subtract, "function");
});
`,
  },
  hidden: () => ({
    "__hidden.test.js": `const assert = require("node:assert/strict");
const { merge, subtract } = require("./src/intervals");
const input = [[5, 6], [1, 3], [2, 4]];
assert.deepEqual(merge(input), [[1, 4], [5, 6]]);
assert.deepEqual(input, [[5, 6], [1, 3], [2, 4]], "input must not be modified");
assert.deepEqual(merge([[1, 2], [2, 3]]), [[1, 3]]);
assert.deepEqual(merge([]), []);
assert.deepEqual(merge([[1, 10], [2, 3]]), [[1, 10]]);
assert.deepEqual(subtract([[1, 10]], [3, 5]), [[1, 3], [5, 10]]);
assert.deepEqual(subtract([[5, 8], [1, 3]], [2, 6]), [[1, 2], [6, 8]]);
assert.deepEqual(subtract([[1, 3]], [0, 5]), []);
assert.deepEqual(subtract([[1, 3]], [3, 4]), [[1, 3]]);
assert.deepEqual(subtract([[1, 3], [2, 6]], [1, 2]), [[2, 6]]);
const keep = [[1, 3]];
subtract(keep, [2, 9]);
assert.deepEqual(keep, [[1, 3]]);
`,
  }),
  solution: {
    "src/intervals.js": `function merge(list) {
  const out = [];
  for (const [s, e] of [...list].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
function subtract(list, [s, e]) {
  const out = [];
  for (const [a, b] of merge(list)) {
    if (b <= s || a >= e) out.push([a, b]);
    else {
      if (a < s) out.push([a, s]);
      if (e < b) out.push([e, b]);
    }
  }
  return out;
}
module.exports = { merge, subtract };
`,
  },
};

export const TASKS = [lru, rename, slug, routes, cart, intervals];
