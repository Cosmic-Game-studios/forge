// Hard task 2: an interpreter for a subset of JavaScript. The hidden test runs
// about 50 programs and compares each result with what Node itself computes.
const r = String.raw;

export default {
  name: "js-interpreter",
  prompt: "Implement the interpreter described in README.md in src/ (entry point src/interpreter.js). Results must be exactly what JavaScript itself would compute for the same program. Do not use eval, the Function constructor, or the vm module.",
  files: {
    "package.json": '{\n  "name": "js-interpreter",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "test": "node --test" }\n}\n',
    "README.md": r`# js-interpreter

An interpreter for a subset of JavaScript, written from scratch (tokenizer,
parser, evaluator).

    const { run } = require("./src/interpreter");
    run("let x = 2; x * 21")          // -> 42
    run("const f = n => n + 1; f(1)") // -> 2

## run(source)

Executes the program and returns the value of its last statement when that is
an expression statement (otherwise undefined). Values are ordinary JavaScript
values: numbers, strings, booleans, null, undefined, arrays, plain objects, and
functions.

## The language

Semantics are exactly JavaScript's (non-strict where it matters).

- Literals: numbers (1, 2.5), strings in single or double quotes with the
  escapes \n \t \\ \' \", true, false, null, undefined
- Array literals [1, 2], object literals { a: 1, "b": 2 }
- Variables: let, const (block scoped; assigning to a const throws a TypeError),
  reading an undeclared variable throws a ReferenceError
- Assignment as an expression: = += -=, to variables, obj.key, obj["key"], arr[i]
- Operators: + - * / %, unary - and !, typeof, < <= > >= === !==, && || ??,
  the conditional a ? b : c, and parentheses - all with JavaScript's precedence,
  associativity and type conversion ("a" + 1 is "a1")
- Member access: obj.key, obj["key"], arr[i], str[i], .length of arrays and
  strings, and the array method push
- Functions: declarations (hoisted), function expressions, arrow functions with
  an expression or a block body, closures, recursion, calls of any expression
- Statements: blocks { }, if / else, while, for (init; test; update), return,
  break, continue; a for loop with let gives each iteration its own binding
- // line comments
- Statements end with a semicolon; the last one may omit it

There is no this, new, class, try, switch, ++ or --, spread, destructuring,
template literal or regular expression.

## Errors

- Invalid syntax throws a SyntaxError
- Reading an undeclared variable throws a ReferenceError
- Assigning to a const, or calling something that is not a function, throws a TypeError

## Rules

Do not use eval, new Function / Function(...), or the vm, child_process or
worker_threads modules anywhere in src/.
`,
    "src/interpreter.js": 'function run(source) {\n  throw new Error("not implemented");\n}\n\nmodule.exports = { run };\n',
    "test/interpreter.test.js": r`const { test } = require("node:test");
const assert = require("node:assert/strict");
const { run } = require("../src/interpreter");

test("arithmetic", () => {
  assert.equal(run("1 + 2 * 3"), 7);
});
`,
  },
  hidden: r`const { run: score } = require("./__score");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const PROGRAMS = [
  "1 + 2 * 3",
  "(1 + 2) * 3 - 4 / 2",
  "7 % 3 + -2",
  "2 + 3 * 4 - 6 / 3 % 2",
  "-(2 + 3) * -2",
  "\"a\" + 1 + 2",
  "1 + 2 + \"a\"",
  "'it\\'s' + \"\\n\" + \"x\\ty\\\\z\"",
  "\"a\\tb\\\\c\\\"d\".length",
  "let x = 5; x += 3; x * 2",
  "let a; let b; a = b = 4; a + b",
  "let u; u",
  "const a = [1, 2, 3]; a.push(4); a.length + a[0] + a[3]",
  "let o = { a: 1, b: { c: [10, 20] } }; o.b.c[1] + o[\"a\"]",
  "let o = {}; o.x = 3; o[\"y\"] = 4; o.x * o.y",
  "const m = [[1, 2], [3, 4]]; m[1][0] = 30; m[1][0] * m[0][1]",
  "const o = { \"long key\": 1, n: 2 }; o[\"long key\"] + o.n + \"abc\"[1] + \"abc\".length",
  "1 < 2 && 2 <= 2 && 3 > 2 && 3 >= 3 && 1 === 1 && 1 !== 2",
  "[null ?? \"d\", 0 || \"x\", 0 ?? \"x\", \"\" && 5, 1 && 2, null || undefined]",
  "false ? 1 : true ? 2 : 3",
  "typeof 1 + typeof \"s\" + typeof null + typeof undefined + typeof (() => 1) + typeof [] + typeof true",
  "[!0, !1, !\"\", !!\"0\", !![], !!null, !!{}]",
  "!true || false && true",
  "1 + 2 < 4 === true",
  "[\"a\" < \"b\", \"n=\" + 1.5, \"10\" < \"9\", 10 < 9, 1 === \"1\"]",
  "[1 / 0, -1 / 0, 0.1 + 0.2, 5 / 2, 0 / 0, \"3\" * \"4\", \"x\" - 1]",
  "const a = {}; const b = a; [a === b, a === {}, [] === []]",
  "function fib(n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); } fib(15)",
  "function counter() { let c = 0; return function () { c += 1; return c; }; } const k = counter(); k(); k(); k()",
  "const add = (a, b) => a + b; const inc = x => x + 1; inc(add(2, 3))",
  "const f = (n) => { let s = 0; for (let i = 0; i <= n; i += 1) { s += i; } return s; }; f(100)",
  "let i = 0; let s = 0; while (true) { i += 1; if (i > 10) break; if (i % 2 === 0) continue; s += i; } s",
  "function map(a, f) { const r = []; for (let i = 0; i < a.length; i += 1) r.push(f(a[i])); return r; } map([1, 2, 3], x => x * x)",
  "const r = later(2); function later(x) { return x * 10; } r",
  "let x = 1; { let x = 2; } function g() { let x = 3; return x; } x + g()",
  "const fs = []; for (let i = 0; i < 3; i += 1) { fs.push(() => i); } fs[0]() + fs[1]() * 10 + fs[2]() * 100",
  "let a = 1; // one\n// two\na + 1",
  "function sign(n) { if (n > 0) { return \"pos\"; } else if (n < 0) { return \"neg\"; } else { return \"zero\"; } } sign(-5) + sign(0) + sign(3)",
  "function f() {} function g() { return; } [f(), g()]",
  "let total = 0; function add(n) { total += n; } add(5); add(6); total",
  "(function (x) { return x * 2; })(21) + ((a) => a + 1)(1)",
  "const o = { n: 2, twice: function (x) { return x * 2; }, deep: { f: y => y + 1 } }; o.twice(o.n) + o.deep.f(1) + o[\"twice\"](1)",
  "function make(n) { return n === 0 ? () => 0 : () => 1 + make(n - 1)(); } make(20)()",
  "let n = 10; let steps = 0; while (n > 0) { n -= 3; steps += 1; } [n, steps]",
  "let found = -1; const a = [4, 8, 15, 16]; for (let i = 0; i < a.length; i += 1) { if (a[i] > 10) { found = i; break; } } found",
  "function outer() { const xs = []; for (let i = 0; i < 3; i += 1) { for (let j = 0; j < 3; j += 1) { if (j === 1) continue; if (i === 2) break; xs.push(i * 10 + j); } } return xs; } outer()",
  "const compose = (f, g) => x => f(g(x)); const h = compose(x => x + 1, x => x * 2); [h(5), compose(h, h)(1)]",
  "function gcd(a, b) { while (b !== 0) { const t = b; b = a % b; a = t; } return a; } [gcd(48, 18), gcd(17, 5)]",
  "const memo = {}; function f(n) { if (n < 2) return n; if (memo[n] !== undefined) return memo[n]; memo[n] = f(n - 1) + f(n - 2); return memo[n]; } f(60)",
  "let x = 10; function shadow(x) { x += 1; return x; } [shadow(1), x]",
  "const a = [1, 2]; const b = a; b.push(3); let s = \"\"; for (let i = 0; i < a.length; i += 1) { s += a[i] + \",\"; } s",
  "let x = 0; const side = () => { x += 1; return true; }; false && side(); true || side(); null ?? side(); x",
  "function sort(a) { for (let i = 1; i < a.length; i += 1) { const v = a[i]; let j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j -= 1; } a[j + 1] = v; } return a; } sort([5, 2, 9, 1, 5, 6])",
  "if (1 > 2) { 1; } else { 2; } let z = 3; z",
  "const o = { a: 1 }; o.b; [o.b, o.a, [1][5], \"s\"[9]]",
];
const ERRORS = ["let = 5", "y + 1", "const c = 1; c = 2; c", "(1 + ", "let q = 1; q();", "function (", "1 +* 2", "{ let inner = 1; } inner"];

function show(v, depth = 0) {
  if (depth > 6) return "...";
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "function") return "<function>";
  if (Array.isArray(v)) return "[" + Array.from(v, (x) => show(x, depth + 1)).join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).map((k) => k + ":" + show(v[k], depth + 1)).join(",") + "}";
  return String(v);
}
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith(".js") ? [fs.readFileSync(path.join(dir, e.name), "utf8")] : []));
}

const cases = PROGRAMS.map((src) => [src.slice(0, 70), () => {
  const expected = show(vm.runInNewContext(src, {}, { timeout: 2000 }));
  assert.equal(show(require("./src/interpreter").run(src)), expected);
}]);
for (const src of ERRORS) cases.push(["error: " + src, () => {
  let name = "none";
  try { vm.runInNewContext(src, {}, { timeout: 2000 }); } catch (e) { name = e.name; }
  let got = "none";
  try { require("./src/interpreter").run(src); } catch (e) { got = e && e.name; }
  assert.equal(got, name);
}]);
cases.push(["does not use eval, Function or vm", () => {
  const bad = /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|require\(\s*["'](node:)?(vm|child_process|worker_threads)["']\s*\)/;
  assert.ok(!sources("src").some((s) => bad.test(s)), "forbidden construct in src/");
}, 6]);
score(cases);
`,
  solution: {
    "src/interpreter.js": 'const vm = require("node:vm");\nfunction run(source) {\n  return vm.runInNewContext(source, {}, { timeout: 2000 });\n}\nmodule.exports = { run };\n',
  },
};
