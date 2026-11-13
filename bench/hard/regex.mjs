// Hard task 1: write a backtracking regex engine. The hidden test compares it
// with JavaScript's own RegExp on about 80 pattern/input pairs.
const r = String.raw;

export default {
  name: "regex-engine",
  prompt: "Implement the regular expression engine described in README.md in src/regex.js. It must behave exactly like JavaScript's own regular expressions for the supported syntax, and it must not use RegExp to do the matching.",
  files: {
    "package.json": '{\n  "name": "regex-engine",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "test": "node --test" }\n}\n',
    "README.md": r`# regex-engine

A regular expression engine written from scratch.

    const { match } = require("./src/regex");
    match("(\\w+)@(\\w+)", "mail bob@example now")
    // -> { index: 5, groups: ["bob@example", "bob", "example"] }
    match("x", "abc")   // -> null

## match(pattern, input)

Finds the leftmost match of pattern in input, with the same result JavaScript's
RegExp (no flags) would give: new RegExp(pattern).exec(input).

Returns null when there is no match, otherwise an object

- index: where the match starts in input
- groups: an array; groups[0] is the matched text, groups[n] the text of the
  n-th capturing group, or undefined when that group did not take part.

## Supported syntax

- literal characters, and escaped ones: \. \\ \/ \+ \* \? \( \) \[ \] \{ \} \| \^ \$ \t \n
- . (any character except a line break)
- character classes [abc], ranges [a-z], negation [^abc], escapes inside classes
- \d \D \w \W \s \S, also inside classes
- anchors ^ and $, word boundaries \b and \B
- groups ( ), non-capturing groups (?: ), alternation |
- quantifiers * + ? {n} {n,} {n,m}, and their lazy forms *? +? ?? {n,m}?
- backreferences \1 to \9
- lookahead (?= ) and negative lookahead (?! )

Semantics are those of JavaScript, including the less obvious ones: alternatives
are tried left to right, quantifiers are greedy unless lazy, a backreference to
a group that did not take part matches the empty string, and captures made
inside a repeated group are cleared at the start of each repetition.

## Rules

- Do not use RegExp (constructor or function) anywhere in src/. The engine must
  do the matching itself. Regex literals for small helper checks are fine.
- An invalid pattern (for example an unclosed group) throws a SyntaxError.
`,
    "src/regex.js": 'function match(pattern, input) {\n  throw new Error("not implemented");\n}\n\nmodule.exports = { match };\n',
    "test/regex.test.js": r`const { test } = require("node:test");
const assert = require("node:assert/strict");
const { match } = require("../src/regex");

test("literal", () => {
  assert.deepEqual(match("abc", "xxabcxx"), { index: 2, groups: ["abc"] });
  assert.equal(match("abc", "ab"), null);
});
`,
  },
  hidden: r`const { run } = require("./__score");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const CASES = [
  ["abc", "xxabcxx"], ["a.c", "abc a-c"], ["a*", "baaa"], ["a+", "baaa"], ["ab?c", "ac abc"], ["a{2}", "aaa"], ["a{2,}", "caaaa"], ["a{1,2}", "aaa"], ["a{0}b", "ab"],
  ["^abc", "abcabc"], ["abc$", "abcabc"], ["^$", ""], ["^a|b$", "cb"], ["a|ab", "ab"], ["(a|ab)(c|bcd)", "abcd"], ["(a)(b)?", "ac"], ["(a*)+", "aa"], ["(a*)*", "b"],
  ["[abc]+", "xxbcaxx"], ["[^abc]+", "abcxyzabc"], ["[a-f0-9]+", "zz1f9az"], ["[\\d.]+", "v1.25.3"], ["[a\\-z]+", "a-z-b"], ["[\\]]", "a]"], ["[.]", "a.b"], ["[^\\d\\s]+", "12 ab"],
  ["\\d+", "abc123def"], ["\\w+", "  hello_world42  "], ["\\s+", "a \t\nb"], ["\\D+", "12ab34"], ["\\W+", "ab!?cd"], ["\\S+", "  xy z"],
  ["\\bfoo\\b", "a foo b"], ["\\bfoo\\b", "afoo foob"], ["\\Bfoo", "afoo"], ["\\b", "  ab"],
  ["a.*c", "abcabc"], ["a.*?c", "abcabc"], ["a+?", "aaa"], ["a??b", "ab"], ["a{2,3}?", "aaaa"], ["<.+?>", "<a><b>"], ["<.+>", "<a><b>"],
  ["(\\w+)@(\\w+)\\.com", "mail bob@example.com now"], ["(a)|(b)", "b"], ["(?:ab)+", "ababab"], ["(?:a|b)+c", "ababc"], ["((a)|(b))+", "ab"], ["(a(b(c)))", "abc"],
  ["(a)\\1", "aa"], ["(\\w)\\1", "hello"], ["(a|b)\\1", "abba"], ["(a)?\\1b", "b"],
  ["a(?=b)", "acab"], ["a(?!b)", "abac"], ["(?=(a+))a*b\\1", "baaabac"], ["\\d+(?!\\d|px)", "12px 345em"],
  ["^(?:(\\d+)\\.)?(\\d+)$", "10.5"], ["^(?:(\\d+)\\.)?(\\d+)$", "7"], ["x*", "aaa"], ["", "abc"], ["\\.", "a.b"], ["a\\+b", "a+b"], ["\\\\", "a\\b"], ["\\/", "a/b"],
  ["[A-Z][a-z]+", "hello World"], ["(\\d{3})-(\\d{4})", "call 555-1234"], ["colou?r", "color colour"], ["^\\s*$", "   "], ["^\\s*$", " x "],
  ["(a+)+b", "aaaaaaaaaaaaaaaac"], ["a|b|c", "xxc"], ["(?:)", "x"], ["\\t", "a\tb"], ["\\n", "a\nb"], ["a.c", "a\nc"], ["$", "abc"], ["(?:a{2}){2}", "aaaaa"],
  ["(x+x+)+y", "xxxxxxxxxxy"], ["(?:(a)|b)+", "ab"], ["(a)(?!\\1)", "aab"], ["(\\d+)\\s*([+*])\\s*(\\d+)", "sum: 12 * 34"],
];

const show = (v) => JSON.stringify(v, (k, x) => (x === undefined ? "<undefined>" : x));
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith(".js") ? [fs.readFileSync(path.join(dir, e.name), "utf8")] : []));
}

const cases = CASES.map(([pattern, input]) => [
  pattern + " on " + JSON.stringify(input),
  () => {
    const { match } = require("./src/regex");
    const m = new RegExp(pattern).exec(input);
    const expected = m ? { index: m.index, groups: [...m] } : null;
    assert.equal(show(match(pattern, input)), show(expected));
  },
]);
cases.push(["invalid patterns throw a SyntaxError", () => {
  const { match } = require("./src/regex");
  for (const bad of ["(ab", "a)", "[abc", "*a"]) assert.throws(() => match(bad, "x"), (e) => e instanceof SyntaxError || (e && e.name === "SyntaxError"), bad);
}]);
cases.push(["does not use RegExp", () => assert.ok(!sources("src").some((s) => /\bRegExp\s*\(/.test(s.replace(/\/\/.*$/gm, ""))), "RegExp used in src/"), 6]);
run(cases);
`,
  // Not a real solution: the native engine behind the required interface. It proves
  // the hidden test is consistent; only the "does not use RegExp" check must fail.
  solution: {
    "src/regex.js": 'function match(pattern, input) {\n  const m = new RegExp(pattern).exec(input);\n  return m ? { index: m.index, groups: [...m] } : null;\n}\nmodule.exports = { match };\n',
  },
  solutionScore: [84, 90],
};
