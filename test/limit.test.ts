import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLimitStop, parseResetAtMs } from "../server/limit.ts";

const now = Date.parse("2026-10-16T12:00:00Z");
const assistant = (text: string) => ({ type: "assistant_message", text });
const user = (text: string) => ({ type: "user_message", text });
const errorItem = (message: string) => ({ type: "error", message });
const failed = (message: string, code?: string) => ({ kind: "failed", error: { message, code } });
const completed = { kind: "completed" };

const CODEX_NOTICE =
  "You've hit your usage limit. Upgrade your plan or add credits to continue, or try again at Oct 20th, 2026 9:48 PM";

test("detects a codex usage-limit failure with its stated reset", () => {
  const stop = detectLimitStop(failed(CODEX_NOTICE), [], now, "UTC");
  assert.deepEqual(stop, { resetsAtMs: Date.parse("Oct 20, 2026 9:48 PM"), source: "turn error" });
});

test("reads a relative wait", () => {
  const stop = detectLimitStop(failed("You've hit your usage limit. Try again in 2 hours 13 minutes."), [], now, "UTC");
  assert.equal(stop?.resetsAtMs, now + (2 * 3600 + 13 * 60) * 1000);
});

test("reads a compact relative wait", () => {
  const stop = detectLimitStop(failed("Too many requests, please try again in 6h53m44s"), [], now, "UTC");
  assert.equal(stop?.resetsAtMs, now + (6 * 3600 + 53 * 60 + 44) * 1000);
});

test("reads claude's legacy epoch suffix", () => {
  const stop = detectLimitStop(failed("Claude AI usage limit reached|1792200000"), [], now, "UTC");
  assert.equal(stop?.resetsAtMs, 1792200000 * 1000);
});

test("trusts a provider code over wording", () => {
  const stop = detectLimitStop(failed("HTTP 429: rate limit reached. Try again at 2026-10-16T18:00:00Z", "rate_limit"), [], now, "UTC");
  assert.equal(stop?.resetsAtMs, Date.parse("2026-10-16T18:00:00Z"));
});

test("detects a limit without a stated reset, for usage confirmation", () => {
  const stop = detectLimitStop(failed("429 RESOURCE_EXHAUSTED: You've hit your daily quota."), [], now, "UTC");
  assert.deepEqual(stop, { resetsAtMs: null, source: "turn error" });
});

test("detects a limit notice that closes a completed turn", () => {
  const timeline = [user("keep going"), assistant("You've hit your daily quota. It will reset at 6:03 AM (Asia/Seoul).")];
  const stop = detectLimitStop(completed, timeline, now, "UTC");
  // 12:00 UTC is 21:00 in Seoul, so the next 6:03 AM there is 21:03 UTC the same day.
  assert.deepEqual(stop, { resetsAtMs: Date.parse("2026-10-16T21:03:00Z"), source: "limit notice" });
});

test("reads a limit from an error item of the last turn", () => {
  const timeline = [user("keep going"), errorItem("usage_limit_reached: resets 3pm (Asia/Seoul)"), assistant("Stopped.")];
  const stop = detectLimitStop(completed, timeline, now, "UTC");
  // 12:00 UTC is 21:00 in Seoul, so the next 3pm there is 06:00 UTC the next day.
  assert.deepEqual(stop, { resetsAtMs: Date.parse("2026-10-17T06:00:00Z"), source: "error item" });
});

test("ignores prose that quotes a limit phrase", () => {
  const timeline = [assistant('The CLI prints "You\'ve hit your session limit · resets 5:50pm (America/Los_Angeles)" when limited.')];
  assert.equal(detectLimitStop(completed, timeline, now, "UTC"), null);
});

test("ignores a limit phrase from an earlier turn", () => {
  const timeline = [errorItem("usage_limit_reached: resets 3pm (Asia/Seoul)"), user("what happened?"), assistant("We ran out of budget.")];
  assert.equal(detectLimitStop(completed, timeline, now, "UTC"), null);
});

test("ignores billing stops that never renew on a clock", () => {
  assert.equal(
    detectLimitStop(failed("Your workspace is out of credits. Ask your workspace owner to refill in order to continue."), [], now, "UTC"),
    null,
  );
  assert.equal(detectLimitStop(failed("Credit balance is too low. Please add funds to continue."), [], now, "UTC"), null);
  assert.equal(detectLimitStop(failed("Insufficient credits", "insufficient_quota"), [], now, "UTC"), null);
});

test("ignores context-length errors", () => {
  assert.equal(
    detectLimitStop(failed("Prompt is too long: maximum context length is 200000 tokens"), [], now, "UTC"),
    null,
  );
});

test("ignores a canceled turn and an ordinary failure", () => {
  assert.equal(detectLimitStop({ kind: "canceled" }, [], now, "UTC"), null);
  assert.equal(detectLimitStop(failed("Connection reset by peer"), [], now, "UTC"), null);
});

test("refuses a reset time that is long past", () => {
  const december = Date.parse("2026-12-01T12:00:00Z");
  assert.equal(parseResetAtMs("Try again at Oct 20th, 2026 9:48 PM", december, "UTC"), null);
});
