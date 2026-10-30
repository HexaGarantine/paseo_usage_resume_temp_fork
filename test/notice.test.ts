import assert from "node:assert/strict";
import { test } from "node:test";
import { findLimitNotice, resetFromClock } from "../server/notice.ts";
import { resetFromUsage } from "../server/usage.ts";

const assistant = (text: string) => ({ type: "assistant_message", text });
const tool = { type: "tool_call" };
const NOTICE = "You've hit your session limit · resets 5:50pm (America/Los_Angeles)";

test("finds the notice as the whole final message", () => {
  assert.deepEqual(findLimitNotice([tool, assistant(NOTICE)]), {
    kind: "session", hour: 17, minute: 50, timeZone: "America/Los_Angeles",
  });
});

test("finds the notice as the last line after other text", () => {
  const timeline = [tool, assistant("Phase 8 is committed. I'm waiting for the review.\n"), assistant(NOTICE)];
  assert.equal(findLimitNotice(timeline)?.kind, "session");
});

// Regression for issue #1: items do not end with a newline, so a separate notice item
// glued onto the previous reply used to hide the notice.
test("treats an item boundary as a line break when the previous reply has no newline", () => {
  const timeline = [tool, assistant("Phase 8 is committed. I'm waiting for the review."), assistant(NOTICE)];
  assert.equal(findLimitNotice(timeline)?.kind, "session");
});

test("ignores the notice when work followed it", () => {
  assert.equal(findLimitNotice([assistant(NOTICE), tool]), null);
});

test("ignores the notice quoted inside a sentence", () => {
  assert.equal(findLimitNotice([assistant(`The CLI prints "${NOTICE}" when limited.`)]), null);
});

test("ignores the notice when it is not the last line", () => {
  assert.equal(findLimitNotice([assistant(`${NOTICE}\nAnyway, here is the plan.`)]), null);
});

test("reads weekly notices and whole hours", () => {
  const notice = findLimitNotice([assistant("You’ve hit your weekly limit · resets 9am (America/Los_Angeles)")]);
  assert.deepEqual(notice, { kind: "weekly", hour: 9, minute: 0, timeZone: "America/Los_Angeles" });
});

test("computes the reset in the notice's time zone, whatever the daemon's", () => {
  const notice = { kind: "session", hour: 17, minute: 50, timeZone: "America/Los_Angeles" };
  // 16:50 in Los Angeles (daylight time, UTC-7) is 23:50 UTC.
  const now = Date.parse("2026-09-26T23:50:00Z");
  assert.equal(resetFromClock(notice, now, "UTC"), Date.parse("2026-09-27T00:50:00Z"));
  assert.equal(resetFromClock(notice, now, "Asia/Tokyo"), Date.parse("2026-09-27T00:50:00Z"));
});

test("rolls over to tomorrow once the reset time has passed", () => {
  const notice = { kind: "session", hour: 17, minute: 50, timeZone: "America/Los_Angeles" };
  const now = Date.parse("2026-09-27T01:30:00Z");
  assert.equal(resetFromClock(notice, now, "UTC"), Date.parse("2026-09-28T00:50:00Z"));
});

test("keeps a reset that passed moments ago", () => {
  const notice = { kind: "session", hour: 17, minute: 50, timeZone: "America/Los_Angeles" };
  const now = Date.parse("2026-09-27T00:55:00Z");
  assert.equal(resetFromClock(notice, now, "UTC"), Date.parse("2026-09-27T00:50:00Z"));
});

test("handles zones east of UTC", () => {
  const notice = { kind: "session", hour: 17, minute: 50, timeZone: "Asia/Tokyo" };
  // Tokyo is UTC+9 all year.
  const now = Date.parse("2026-09-26T06:00:00Z");
  assert.equal(resetFromClock(notice, now, "America/Los_Angeles"), Date.parse("2026-09-26T08:50:00Z"));
});

test("honours a daylight-saving change before the reset", () => {
  // Los Angeles leaves daylight time at 02:00 on 1 November 2026; 9am is then UTC-8.
  const notice = { kind: "session", hour: 9, minute: 0, timeZone: "America/Los_Angeles" };
  const now = Date.parse("2026-11-01T06:00:00Z");
  assert.equal(resetFromClock(notice, now, "UTC"), Date.parse("2026-11-01T17:00:00Z"));
});

test("uses the daemon's zone when the notice names none", () => {
  const notice = { kind: "session", hour: 17, minute: 50, timeZone: null };
  const now = Date.parse("2026-09-26T14:50:00Z");
  assert.equal(resetFromClock(notice, now, "UTC"), Date.parse("2026-09-26T17:50:00Z"));
});

test("refuses an unknown time zone", () => {
  const notice = { kind: "session", hour: 17, minute: 50, timeZone: "Mars/Olympus_Mons" };
  assert.equal(resetFromClock(notice, Date.now(), "UTC"), null);
});

test("prefers the matching usage window's reset time", () => {
  const now = Date.parse("2026-09-26T14:50:00Z");
  const usage = [{ providerId: "claude", windows: [
    { id: "five_hour", usedPct: 97, resetsAt: "2026-09-26T15:50:00Z" },
    { id: "weekly", usedPct: 40, resetsAt: "2026-09-30T10:00:00Z" },
  ] }];
  assert.equal(resetFromUsage(usage, "claude", "session", now, 8 * 86400_000), Date.parse("2026-09-26T15:50:00Z"));
  assert.equal(resetFromUsage(usage, "claude", "weekly", now, 8 * 86400_000), Date.parse("2026-09-30T10:00:00Z"));
  assert.equal(resetFromUsage(usage, "claude", "extra usage", now, 8 * 86400_000), null);
});
