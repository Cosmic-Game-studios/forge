// Hard task 5: a small library with six seeded bugs in five files. Five are
// reported as symptoms; the sixth (addWeekly is not all-or-nothing) is only
// visible to someone who compares the code with the README.
const r = String.raw;

const time = (bug) => r`/** "9:05" -> 545 (minutes since midnight). */
function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text));
  if (!m) throw new Error("bad time: " + text);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) throw new Error("bad time: " + text);
  return hours * 60 + minutes;
}

/** 545 -> "9:05" */
function formatTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h + ":" + ${bug ? "m" : 'String(m).padStart(2, "0")'};
}

module.exports = { parseTime, formatTime };
`;

const interval = (bug) => r`/** Do two { start, end } ranges (in minutes) share any time? */
function overlaps(a, b) {
  return a.start ${bug ? "<=" : "<"} b.end && b.start ${bug ? "<=" : "<"} a.end;
}

module.exports = { overlaps };
`;

const recurrence = (bug) => r`/** "2026-01-30" + 7 -> "2026-02-06" */
function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Every 7th day from 'from' up to 'until'. */
function weekly(from, until) {
  const dates = [];
  for (let d = from; d ${bug ? "<" : "<="} until; d = addDays(d, 7)) dates.push(d);
  return dates;
}

module.exports = { addDays, weekly };
`;

const calendar = (bug) => r`const { parseTime, formatTime } = require("./time");
const { overlaps } = require("./interval");
const { weekly } = require("./recurrence");

class Calendar {
  constructor() {
    this.events = [];
  }

  /** event: { title, room, date: "YYYY-MM-DD", start: "9:00", end: "10:30" } */
  add(event) {
    const start = parseTime(event.start);
    const end = parseTime(event.end);
    if (end <= start) throw new Error("an event must end after it starts");
    const item = { title: event.title, room: event.room, date: event.date, start, end };
    const clash = this.events.find((e) => e.room === item.room && e.date === item.date && overlaps(e, item));
    if (clash) throw new Error('conflict with "' + clash.title + '"');
    this.events.push(item);
    return item;
  }

  /** Adds the event on its date and every seventh day after it, up to 'until'. */
  addWeekly(event, until) {
${
  bug
    ? `    const made = [];
    for (const date of weekly(event.date, until)) made.push(this.add({ ...event, date }));
    return made;`
    : `    const before = this.events.length;
    try {
      return weekly(event.date, until).map((date) => this.add({ ...event, date }));
    } catch (err) {
      this.events.length = before;
      throw err;
    }`
}
  }

  /** The events of one day, for display. */
  day(date) {
    return this.events
      .filter((e) => e.date === date)
      .map((e) => ({ title: e.title, room: e.room, ${bug ? "" : "start: e.start, "}time: formatTime(e.start) + "-" + formatTime(e.end) }))
      .sort((a, b) => ${bug ? "(a.time < b.time ? -1 : a.time > b.time ? 1 : 0)" : "a.start - b.start"} || a.room.localeCompare(b.room))${bug ? "" : "\n      .map(({ start, ...shown }) => shown)"};
  }
}

module.exports = { Calendar };
`;

const report = (bug) => r`const WORKDAY_MINUTES = 8 * 60;
${bug ? "const totals = {};\n" : ""}
/** Booked minutes per room on one day, and the share of an eight-hour day in percent. */
function utilisation(calendar, date) {${bug ? "" : "\n  const totals = {};"}
  for (const e of calendar.events) {
    if (e.date !== date) continue;
    totals[e.room] = (totals[e.room] || 0) + (e.end - e.start);
  }
  return Object.keys(totals)
    .sort()
    .map((room) => ({ room, minutes: totals[room], share: Math.round((totals[room] / WORKDAY_MINUTES) * 100) }));
}

module.exports = { utilisation };
`;

const files = (bug) => ({
  "src/time.js": time(bug),
  "src/interval.js": interval(bug),
  "src/recurrence.js": recurrence(bug),
  "src/calendar.js": calendar(bug),
  "src/report.js": report(bug),
});

export default {
  name: "bug-hunt",
  prompt: "Users of this room-booking library (see README.md) reported five problems: (1) in the day view, morning meetings appear after later ones; (2) back-to-back meetings in the same room are rejected as conflicts; (3) a weekly series is missing its last occurrence when it ends exactly on the `until` date; (4) the utilisation report shows higher numbers every time it is opened; (5) five past nine is displayed as 9:5. Fix them. The library has never been reviewed against its README, so also check that it does what README.md documents, and fix what does not.",
  files: {
    "package.json": '{\n  "name": "rooms",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "test": "node --test" }\n}\n',
    "README.md": r`# rooms

Room bookings for one office.

    const { Calendar, utilisation } = require("./src");
    const cal = new Calendar();
    cal.add({ title: "Standup", room: "A", date: "2026-03-02", start: "9:00", end: "9:15" });
    cal.day("2026-03-02");   // [{ title: "Standup", room: "A", time: "9:00-9:15" }]

## Calendar

- add(event) books a room. Times are "H:MM" or "HH:MM". An event must end after
  it starts. Two events in the same room on the same day must not share any
  time; an event may start at the minute another one ends. A conflict throws an
  Error naming the other event, and nothing is booked.
- addWeekly(event, until) books the event on its date and every seventh day
  after that, up to and including until ("YYYY-MM-DD"). It returns the booked
  events. It is all or nothing: if any occurrence conflicts, the error is
  thrown and none of the occurrences stays booked.
- day(date) returns that day's events as { title, room, time }, ordered by
  start time and then by room. time looks like "9:05-10:30".

## utilisation(calendar, date)

Returns one entry per room that is booked on that day, ordered by room name:
{ room, minutes, share } where share is the booked part of an eight-hour day in
percent, rounded. Calling it does not change anything; the same call always
gives the same answer.
`,
    "src/index.js": 'module.exports = {\n  ...require("./calendar"),\n  ...require("./report"),\n  ...require("./time"),\n};\n',
    ...files(true),
    "test/calendar.test.js": r`const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Calendar } = require("../src");

test("books an event and rejects a real conflict", () => {
  const cal = new Calendar();
  cal.add({ title: "Review", room: "A", date: "2026-03-02", start: "10:00", end: "11:00" });
  assert.throws(() => cal.add({ title: "Clash", room: "A", date: "2026-03-02", start: "10:30", end: "11:30" }), /conflict with "Review"/);
  assert.equal(cal.events.length, 1);
});

test("same time in another room is fine", () => {
  const cal = new Calendar();
  cal.add({ title: "One", room: "A", date: "2026-03-02", start: "10:00", end: "11:00" });
  cal.add({ title: "Two", room: "B", date: "2026-03-02", start: "10:00", end: "11:00" });
  assert.equal(cal.day("2026-03-02").length, 2);
});
`,
  },
  hidden: r`const { run } = require("./__score");
const assert = require("node:assert/strict");
const lib = () => require("./src");
const ev = (title, room, date, start, end) => ({ title, room, date, start, end });
const D = "2026-03-02";

run([
  ["day view is ordered by start time", () => {
    const cal = new (lib().Calendar)();
    cal.add(ev("late", "A", D, "14:00", "15:00")); cal.add(ev("noon", "A", D, "12:00", "13:00")); cal.add(ev("early", "A", D, "9:00", "10:00")); cal.add(ev("first", "B", D, "8:30", "9:00"));
    assert.deepEqual(cal.day(D).map((e) => e.title), ["first", "early", "noon", "late"]);
  }],
  ["day view: ties by room, exact shape", () => {
    const cal = new (lib().Calendar)();
    cal.add(ev("b", "B", D, "9:00", "10:00")); cal.add(ev("a", "A", D, "9:00", "10:00")); cal.add(ev("other day", "A", "2026-03-03", "9:00", "10:00"));
    assert.deepEqual(cal.day(D), [{ title: "a", room: "A", time: "9:00-10:00" }, { title: "b", room: "B", time: "9:00-10:00" }]);
  }],
  ["back-to-back meetings are allowed", () => {
    const cal = new (lib().Calendar)();
    cal.add(ev("one", "A", D, "9:00", "10:00")); cal.add(ev("two", "A", D, "10:00", "11:00")); cal.add(ev("zero", "A", D, "8:00", "9:00"));
    assert.equal(cal.events.length, 3);
  }],
  ["real overlaps are still rejected, and nothing is booked", () => {
    const cal = new (lib().Calendar)();
    cal.add(ev("one", "A", D, "9:00", "10:00"));
    for (const [s, e] of [["9:59", "10:30"], ["8:00", "9:01"], ["9:15", "9:45"], ["8:00", "11:00"], ["9:00", "10:00"]]) assert.throws(() => cal.add(ev("x", "A", D, s, e)), /conflict with "one"/);
    assert.equal(cal.events.length, 1);
    assert.throws(() => cal.add(ev("bad", "B", D, "10:00", "10:00")));
    assert.throws(() => cal.add(ev("bad", "B", D, "25:00", "26:00")));
  }],
  ["weekly series includes the until date", () => {
    const cal = new (lib().Calendar)();
    const made = cal.addWeekly(ev("sync", "A", "2026-01-23", "9:00", "9:30"), "2026-02-13");
    assert.deepEqual(made.map((e) => e.date), ["2026-01-23", "2026-01-30", "2026-02-06", "2026-02-13"]);
    assert.equal(cal.addWeekly(ev("short", "B", "2026-01-23", "9:00", "9:30"), "2026-02-12").length, 3);
    assert.equal(cal.addWeekly(ev("single", "C", "2026-01-23", "9:00", "9:30"), "2026-01-23").length, 1);
  }],
  ["weekly series is all or nothing", () => {
    const cal = new (lib().Calendar)();
    cal.add(ev("blocker", "A", "2026-02-06", "9:15", "9:45"));
    assert.throws(() => cal.addWeekly(ev("sync", "A", "2026-01-23", "9:00", "9:30"), "2026-02-13"), /conflict with "blocker"/);
    assert.equal(cal.events.length, 1);
    assert.deepEqual(cal.day("2026-01-23"), []);
  }, 2],
  ["utilisation is stable across calls", () => {
    const cal = new (lib().Calendar)();
    cal.add(ev("one", "B", D, "9:00", "11:00")); cal.add(ev("two", "A", D, "13:00", "13:45")); cal.add(ev("three", "B", D, "11:00", "12:00")); cal.add(ev("other", "C", "2026-03-03", "9:00", "17:00"));
    const want = [{ room: "A", minutes: 45, share: 9 }, { room: "B", minutes: 180, share: 38 }];
    assert.deepEqual(lib().utilisation(cal, D), want);
    assert.deepEqual(lib().utilisation(cal, D), want);
    assert.deepEqual(lib().utilisation(new (lib().Calendar)(), D), []);
    assert.deepEqual(lib().utilisation(cal, "2026-03-03"), [{ room: "C", minutes: 480, share: 100 }]);
  }],
  ["times are formatted with two-digit minutes", () => {
    assert.equal(lib().formatTime(545), "9:05");
    assert.equal(lib().formatTime(600), "10:00");
    assert.equal(lib().formatTime(0), "0:00");
    assert.equal(lib().parseTime("9:05"), 545);
    const cal = new (lib().Calendar)();
    cal.add(ev("x", "A", D, "9:05", "10:07"));
    assert.equal(cal.day(D)[0].time, "9:05-10:07");
  }],
  ["day view order with single-digit minutes and hours", () => {
    const cal = new (lib().Calendar)();
    cal.add(ev("c", "A", D, "10:05", "10:10")); cal.add(ev("b", "A", D, "9:50", "10:00")); cal.add(ev("a", "A", D, "9:05", "9:10")); cal.add(ev("d", "A", D, "23:00", "23:59"));
    assert.deepEqual(cal.day(D).map((e) => e.title), ["a", "b", "c", "d"]);
  }],
]);
`,
  solution: files(false),
};
