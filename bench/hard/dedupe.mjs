// Hard task 4: make a quadratic (and worse) algorithm fast without changing a
// single result. The trap is transitivity: duplicates form chains.
const r = String.raw;

const SLOW = r`/** Digits only, without leading zeros: "+49 (0) 30-12" and "0049030 12" are different, "030 12" and "30-12" the same. */
function normPhone(phone) {
  return String(phone || "").replace(/\D/g, "").replace(/^0+/, "");
}

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/** Two records are the same person when they share an email address or a phone number. */
function same(a, b) {
  const ea = normEmail(a.email), eb = normEmail(b.email);
  if (ea && ea === eb) return true;
  const pa = normPhone(a.phone), pb = normPhone(b.phone);
  return Boolean(pa) && pa === pb;
}

/**
 * Groups of duplicate records, as arrays of indexes into records.
 * Each group is sorted, groups are ordered by their first index,
 * and records without a duplicate are left out.
 */
function findDuplicates(records) {
  let groups = records.map((_, i) => [i]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        if (groups[a].some((i) => groups[b].some((j) => same(records[i], records[j])))) {
          groups[a] = groups[a].concat(groups[b]);
          groups.splice(b, 1);
          changed = true;
          b--;
        }
      }
    }
  }
  return groups
    .filter((g) => g.length > 1)
    .map((g) => g.sort((x, y) => x - y))
    .sort((g, h) => g[0] - h[0]);
}

module.exports = { findDuplicates, same, normPhone, normEmail };
`;

const FAST = r`function normPhone(phone) {
  return String(phone || "").replace(/\D/g, "").replace(/^0+/, "");
}
function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}
function same(a, b) {
  const ea = normEmail(a.email), eb = normEmail(b.email);
  if (ea && ea === eb) return true;
  const pa = normPhone(a.phone), pb = normPhone(b.phone);
  return Boolean(pa) && pa === pb;
}
function findDuplicates(records) {
  const parent = records.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const firstByKey = new Map();
  records.forEach((rec, i) => {
    for (const key of [normEmail(rec.email) && "e:" + normEmail(rec.email), normPhone(rec.phone) && "p:" + normPhone(rec.phone)]) {
      if (!key) continue;
      if (firstByKey.has(key)) parent[find(i)] = find(firstByKey.get(key));
      else firstByKey.set(key, i);
    }
  });
  const groups = new Map();
  records.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });
  return [...groups.values()].filter((g) => g.length > 1).sort((g, h) => g[0] - h[0]);
}
module.exports = { findDuplicates, same, normPhone, normEmail };
`;

export default {
  name: "dedupe-performance",
  prompt: "findDuplicates in src/dedupe.js takes many minutes on our customer exports of 100,000 records. Make it fast - well under two seconds for 100,000 records - without changing its results in any way: same groups, same order, for every input. The other exported functions must keep working as they do.",
  files: {
    "package.json": '{\n  "name": "dedupe",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "test": "node --test" }\n}\n',
    "src/dedupe.js": SLOW,
    "test/dedupe.test.js": r`const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findDuplicates } = require("../src/dedupe");

test("same email, different case", () => {
  const records = [{ email: "a@x.io" }, { email: "b@x.io" }, { email: " A@X.IO " }];
  assert.deepEqual(findDuplicates(records), [[0, 2]]);
});
`,
  },
  hidden:
    r`const { run } = require("./__score");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const reference = (() => {
  const module = { exports: {} };
` +
    FAST +
    r`  return module.exports;
})();

let seed = 4711;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const PHONE_STYLES = [(d) => d, (d) => "0" + d, (d) => "00" + d, (d) => "+" + d.slice(0, 2) + " (" + d.slice(2, 4) + ") " + d.slice(4), (d) => d.slice(0, 3) + "-" + d.slice(3), (d) => " " + d + " "];
const EMAIL_STYLES = [(e) => e, (e) => e.toUpperCase(), (e) => "  " + e, (e) => e[0].toUpperCase() + e.slice(1) + " "];
function dataset(n, emails, phones) {
  return Array.from({ length: n }, (_, i) => {
    const rec = { id: i };
    const kind = rnd(10);
    if (kind < 7) rec.email = EMAIL_STYLES[rnd(4)]("user" + rnd(emails) + "@example.com");
    else if (kind === 7) rec.email = "";
    if (rnd(10) < 6) rec.phone = PHONE_STYLES[rnd(6)](String(1000000 + rnd(phones)));
    else if (rnd(4) === 0) rec.phone = rnd(2) ? "" : "000";
    return rec;
  });
}
const mine = () => require("./src/dedupe");
const cases = [];
for (let g = 0; g < 8; g++) {
  const sets = Array.from({ length: 6 }, () => dataset(5 + rnd(70), 4 + rnd(40), 4 + rnd(40)));
  cases.push(["random records, group " + (g + 1), () => { for (const set of sets) assert.deepEqual(mine().findDuplicates(set), reference.findDuplicates(set)); }]);
}
cases.push(["chains are one group", () => {
  const recs = [{ email: "a@x" }, { email: "z@x", phone: "5" }, { email: "A@x", phone: "7" }, { phone: "007" }, { phone: "0-5", email: "q@x" }, { email: "q@x " }, { email: "solo@x" }];
  assert.deepEqual(mine().findDuplicates(recs), [[0, 2, 3], [1, 4, 5]]);
}]);
cases.push(["empty fields never match", () => {
  assert.deepEqual(mine().findDuplicates([{ email: "", phone: "" }, { email: " ", phone: "000" }, {}, { email: null, phone: undefined }, { phone: "0" }]), []);
  assert.deepEqual(mine().findDuplicates([]), []);
}]);
cases.push(["input is not modified, helpers still exported", () => {
  const recs = dataset(40, 8, 8), copy = JSON.stringify(recs);
  mine().findDuplicates(recs);
  assert.equal(JSON.stringify(recs), copy);
  assert.equal(mine().same({ phone: "030 12" }, { phone: "30-12" }), true);
  assert.equal(mine().normPhone("+49 (0) 30"), "49030");
  assert.equal(mine().normEmail(" A@b "), "a@b");
}]);
for (const [n, weight] of [[20000, 2], [100000, 4]]) {
  cases.push([n + " records in under 3 seconds, same result", () => {
    const recs = dataset(n, Math.round(n * 0.7), Math.round(n * 0.7));
    fs.writeFileSync("__big.json", JSON.stringify(recs));
    const script = 'const recs = JSON.parse(require("fs").readFileSync("__big.json", "utf8")); const t = Date.now(); const out = require("./src/dedupe").findDuplicates(recs); process.stdout.write(JSON.stringify({ ms: Date.now() - t, out }));';
    const res = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20000, maxBuffer: 1 << 28 }));
    assert.deepEqual(res.out, reference.findDuplicates(recs));
    assert.ok(res.ms < 3000, "took " + res.ms + " ms");
  }, weight]);
}
run(cases);
`,
  solution: { "src/dedupe.js": FAST },
};
