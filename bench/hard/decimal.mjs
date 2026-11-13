// Hard task 3: arbitrary-precision decimal arithmetic on strings, without BigInt.
// The hidden test checks several hundred random operations against BigInt.
const r = String.raw;

const ORACLE = r`function parse(s) {
  const neg = s.startsWith("-");
  const [int, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const n = BigInt(int + frac);
  return { n: neg ? -n : n, scale: frac.length };
}
function format(n, scale) {
  const neg = n < 0n;
  let digits = (neg ? -n : n).toString().padStart(scale + 1, "0");
  let int = digits.slice(0, digits.length - scale);
  let frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  const text = frac ? int + "." + frac : int;
  return neg && /[1-9]/.test(text) ? "-" + text : text;
}
function align(a, b) {
  const x = parse(a), y = parse(b), scale = Math.max(x.scale, y.scale);
  return [x.n * 10n ** BigInt(scale - x.scale), y.n * 10n ** BigInt(scale - y.scale), scale];
}
function add(a, b) { const [x, y, s] = align(a, b); return format(x + y, s); }
function sub(a, b) { const [x, y, s] = align(a, b); return format(x - y, s); }
function mul(a, b) { const x = parse(a), y = parse(b); return format(x.n * y.n, x.scale + y.scale); }
function cmp(a, b) { const [x, y] = align(a, b); return x < y ? -1 : x > y ? 1 : 0; }
function div(a, b, scale) {
  const x = parse(a), y = parse(b);
  if (y.n === 0n) throw new RangeError("division by zero");
  const num = x.n * 10n ** BigInt(scale + y.scale), den = y.n * 10n ** BigInt(x.scale);
  let q = num / den;
  const rem = num - q * den, abs = (v) => (v < 0n ? -v : v);
  if (2n * abs(rem) >= abs(den)) q += (num < 0n) !== (den < 0n) ? -1n : 1n;
  return format(q, scale);
}
`;

export default {
  name: "big-decimal",
  prompt: "Implement the decimal arithmetic library described in README.md in src/decimal.js. Numbers can be hundreds of digits long and every result must be exact, so JavaScript numbers are not enough - and BigInt is not allowed.",
  files: {
    "package.json": '{\n  "name": "big-decimal",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "test": "node --test" }\n}\n',
    "README.md": r`# big-decimal

Exact decimal arithmetic on strings, for amounts that do not fit a JavaScript number.

    const d = require("./src/decimal");
    d.add("0.1", "0.2")            // "0.3"
    d.mul("-1.5", "4")             // "-6"
    d.div("1", "3", 5)             // "0.33333"
    d.cmp("2.50", "2.5")           // 0

## Numbers

Input: an optional "-", one or more digits, and optionally "." followed by one
or more digits. Leading and trailing zeros are allowed ("007.500", "-0.0").
There is no exponent notation and no limit on length.

Output is always normalized:

- no leading zeros in the integer part (but at least one digit: "0.5")
- no trailing zeros after the decimal point, and no trailing "."
- zero is "0", never "-0"

## Functions

- add(a, b), sub(a, b), mul(a, b): exact results
- div(a, b, scale): a / b rounded to scale digits after the decimal point
  (scale is an integer >= 0), ties rounded away from zero (0.125 -> 0.13,
  -0.125 -> -0.13), then normalized. Division by zero throws a RangeError.
- cmp(a, b): -1, 0 or 1

## Rules

Do not use BigInt (neither the function nor literals like 10n) anywhere in src/.
Converting whole numbers to JavaScript numbers loses digits and is not a solution.
`,
    "src/decimal.js": 'function add(a, b) {\n  throw new Error("not implemented");\n}\n\nfunction sub(a, b) {\n  throw new Error("not implemented");\n}\n\nfunction mul(a, b) {\n  throw new Error("not implemented");\n}\n\nfunction div(a, b, scale) {\n  throw new Error("not implemented");\n}\n\nfunction cmp(a, b) {\n  throw new Error("not implemented");\n}\n\nmodule.exports = { add, sub, mul, div, cmp };\n',
    "test/decimal.test.js": r`const { test } = require("node:test");
const assert = require("node:assert/strict");
const d = require("../src/decimal");

test("small numbers", () => {
  assert.equal(d.add("1", "2"), "3");
});
`,
  },
  hidden:
    r`const { run } = require("./__score");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const oracle = (() => {
` +
    ORACLE +
    r`  return { add, sub, mul, div, cmp };
})();

let seed = 20261113;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const digits = (n) => Array.from({ length: n }, () => rnd(10)).join("");
function number(maxInt, maxFrac) {
  let s = digits(1 + rnd(maxInt));
  if (rnd(3)) s += "." + digits(1 + rnd(maxFrac));
  if (rnd(8) === 0) s = "000" + s;
  return (rnd(3) === 0 ? "-" : "") + s;
}
const d = () => require("./src/decimal");
const cases = [];
for (const op of ["add", "sub", "mul", "cmp"]) {
  for (let g = 0; g < 8; g++) {
    const pairs = Array.from({ length: 8 }, () => (g < 2 ? [number(6, 4), number(6, 4)] : [number(60, 30), number(60, 30)]));
    if (g === 7) pairs.push(...pairs.map(([a]) => [a, a]), ...pairs.map(([a]) => [a, a.startsWith("-") ? a.slice(1) : "-" + a]));
    cases.push([op + " group " + (g + 1), () => { for (const [a, b] of pairs) assert.equal(d()[op](a, b), oracle[op](a, b), op + "(" + a + ", " + b + ")"); }]);
  }
}
for (let g = 0; g < 10; g++) {
  const triples = Array.from({ length: 8 }, () => {
    let b = number(g < 3 ? 4 : 30, g < 3 ? 3 : 15);
    if (/^-?0*(\.0*)?$/.test(b)) b = "7";
    return [number(g < 3 ? 5 : 50, g < 3 ? 3 : 20), b, rnd(g < 3 ? 6 : 40)];
  });
  cases.push(["div group " + (g + 1), () => { for (const [a, b, s] of triples) assert.equal(d().div(a, b, s), oracle.div(a, b, s), "div(" + a + ", " + b + ", " + s + ")"); }]);
}
const fixed = [
  ["add", "-0.0", "0", "0"], ["add", "0.1", "0.2", "0.3"], ["sub", "1", "1.000", "0"], ["sub", "0.5", "1", "-0.5"], ["mul", "-0", "5", "0"], ["mul", "0.001", "1000", "1"],
  ["add", "999999999999999999999999999999.9", "0.1", "1000000000000000000000000000000"], ["sub", "1000000000000000000000", "0.000000000000000000001", "999999999999999999999.999999999999999999999"],
  ["mul", "007.500", "2", "15"], ["add", "-5", "5.0", "0"],
];
cases.push(["normalization", () => { for (const [op, a, b, want] of fixed) assert.equal(d()[op](a, b), want, op + "(" + a + ", " + b + ")"); }, 2]);
cases.push(["division rounding", () => {
  assert.equal(d().div("1", "3", 5), "0.33333");
  assert.equal(d().div("2", "3", 2), "0.67");
  assert.equal(d().div("-1", "8", 2), "-0.13");
  assert.equal(d().div("1", "8", 2), "0.13");
  assert.equal(d().div("10", "4", 0), "3");
  assert.equal(d().div("-0.004", "1", 2), "0");
  assert.equal(d().div("100", "0.25", 0), "400");
  assert.equal(d().div("1", "7", 60), oracle.div("1", "7", 60));
}, 2]);
cases.push(["division by zero", () => { assert.throws(() => d().div("1", "0.00", 2), RangeError); assert.throws(() => d().div("0", "-0", 0), RangeError); }]);
cases.push(["very long numbers", () => {
  const a = "-" + "9".repeat(400) + "." + "9".repeat(200), b = "1".repeat(300) + ".000" + "7".repeat(150);
  for (const op of ["add", "sub", "mul"]) assert.equal(d()[op](a, b), oracle[op](a, b), op);
  assert.equal(d().div(a, b, 100), oracle.div(a, b, 100));
}, 2]);
cases.push(["does not use BigInt", () => {
  const src = fs.readdirSync("src").filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join("src", f), "utf8")).join("\n");
  assert.ok(!/BigInt|\b\d+n\b/.test(src), "BigInt found in src/");
}, 6]);
run(cases);
`,
  solution: { "src/decimal.js": ORACLE + "module.exports = { add, sub, mul, div, cmp };\n" },
};
