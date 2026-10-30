// Provider-agnostic detection of a turn that stopped at a renewable usage limit, plus
// parsing of the reset time the provider's own notice states. Pure functions, no I/O.
//
// Codex, Gemini and other CLIs word their limits differently from Claude, and some end
// the turn as an ordinary reply instead of failing it. The phrases below come from the
// community research behind babo-jeonguk/paseo-usage-auto-resume and the plugins it
// credits (panrafal/paseo-plugins chat-resume, keefeere/paseo-continuity), all MIT.
//
// Two rules keep this conservative:
// - A notice is short. Long text that merely mentions a limit is ordinary output.
// - Billing stops (prepaid balance, workspace credits) never renew on a clock, so their
//   phrases exclude the text from being a limit at all.

import { resetFromClock } from "./notice.ts";

export interface TimelineItem {
  type: string;
  text?: string;
  message?: string;
  level?: string;
}

export interface TurnOutcome {
  kind: string;
  error?: { message: string; code?: string };
}

export interface LimitStop {
  /** Reset instant stated by the provider, or null when the notice has none. */
  resetsAtMs: number | null;
  /** Where the notice was found, for the log and the resume's limit identity. */
  source: string;
}

/** Phrases providers use when a subscription usage window or rate limit stopped the turn. */
const LIMIT_PATTERNS = [
  /you(?:['’])?ve (?:hit|reached|exhausted) your (?:usage |session |weekly |daily |5-hour |five-hour )?(?:limit|quota)/i,
  /(?:usage|session|5-hour|five-hour|weekly|daily|rate) limit (?:has been )?(?:reached|exceeded|hit)/i,
  /usage_limit_(?:reached|exceeded)/i,
  /rate_limit_(?:exceeded|error|reached)/i,
  /quota (?:has been )?(?:reached|exceeded|exhausted)/i,
  /resource[_ ]exhausted/i,
  /too many requests/i,
];

/** Context overflow and billing stops never renew on a clock, so they are not usage limits. */
const NOT_A_LIMIT = [
  /context[ _-](?:length|window)/i,
  /(?:prompt|input) is too long/i,
  /maximum context/i,
  /too many (?:input )?tokens/i,
  /insufficient[_ ]quota|credit balance|out of (?:usage )?credits|billing|payment[_ ]required|prepaid|prepay/i,
  /credit_balance_exhausted|insufficient (?:funds|credits)/i,
];

/** Provider notices open with the limit statement; prose that quotes one does not. */
const OPENING = [
  /^you(?:['’])?ve (?:hit|reached|exhausted)\b/i,
  /^your [a-z0-9 -]{0,40}(?:limit|quota)\b/i,
];

/** Provider notices are short. */
const NOTICE_MAX_CHARS = 800;

/** Codes that name a renewable limit; a bare HTTP 429 can also mean a billing stop. */
const LIMIT_CODES = new Set([
  "rate_limit",
  "rate_limit_exceeded",
  "rate_limit_error",
  "usage_limit_reached",
  "usage_limit_exceeded",
]);

/** Codes that name a stop that never renews on a clock. */
const NOT_A_LIMIT_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "billing_error",
  "payment_required",
  "context_length_exceeded",
]);

function isLimitText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > NOTICE_MAX_CHARS) return false;
  if (NOT_A_LIMIT.some((pattern) => pattern.test(trimmed))) return false;
  return LIMIT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** The final assistant text: only a closing message can be the notice, so an answer that
 *  merely discusses limits is not confused with one. Item boundaries are line breaks. */
function closingAssistantText(timeline: readonly TimelineItem[]): string | null {
  let end = timeline.length;
  while (end > 0 && timeline[end - 1]?.type === "assistant_message") end--;
  const run = timeline.slice(end);
  if (run.length === 0) return null;
  return run.map((item) => item.text ?? "").join("\n");
}

/** Items after the last user message are the turn that just ended. */
function latestTurn(timeline: readonly TimelineItem[]): readonly TimelineItem[] {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.type === "user_message") return timeline.slice(index + 1);
  }
  return timeline;
}

/**
 * Detects a turn stopped by a usage or rate limit, whatever the provider. Canceled turns,
 * ordinary failures and billing stops are null. A limit is returned even without a reset
 * time, so callers can confirm against usage data; `resetsAtMs` is null when the notice
 * states none.
 */
export function detectLimitStop(
  outcome: TurnOutcome,
  timeline: readonly TimelineItem[],
  nowMs: number,
  daemonTimeZone: string,
): LimitStop | null {
  if (outcome.kind === "canceled") return null;
  if (outcome.kind === "failed" && outcome.error) {
    const code = outcome.error.code?.toLowerCase() ?? "";
    if (NOT_A_LIMIT_CODES.has(code)) return null;
    if (LIMIT_CODES.has(code) && !NOT_A_LIMIT.some((pattern) => pattern.test(outcome.error!.message))) {
      return { resetsAtMs: parseResetAtMs(outcome.error.message, nowMs, daemonTimeZone), source: "turn error" };
    }
  }

  // Most authoritative first: the turn's own failure, then system items, then a closing reply.
  const turn = latestTurn(timeline);
  const texts: { text: string; source: string }[] = [];
  if (outcome.kind === "failed" && outcome.error) texts.push({ text: outcome.error.message, source: "turn error" });
  for (const item of turn) {
    if (item.type === "error") texts.push({ text: item.message ?? "", source: "error item" });
    else if (item.type === "notification" && item.level !== "info") {
      texts.push({ text: item.message ?? "", source: "notification" });
    }
  }
  const closing = closingAssistantText(turn);
  if (closing !== null) texts.push({ text: closing, source: "limit notice" });

  let unmatchedLimit: LimitStop | null = null;
  for (const { text, source } of texts) {
    if (!isLimitText(text)) continue;
    // An agent's prose can quote a limit phrase, so a closing reply must open with one.
    if (source === "limit notice" && !OPENING.some((pattern) => pattern.test(text.trim()))) continue;
    const resetsAtMs = parseResetAtMs(text, nowMs, daemonTimeZone);
    if (resetsAtMs !== null) return { resetsAtMs, source };
    unmatchedLimit ??= { resetsAtMs: null, source };
  }
  return unmatchedLimit;
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
};

const UNIT = "(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smh])";

/**
 * The renewal instant a notice states, or null when it states none. Formats follow the
 * providers' own output: an epoch, a relative wait, an ISO timestamp, a clock time with
 * or without a named zone, or a dated phrase such as "try again at Oct 9th, 2026 4:13 AM".
 */
export function parseResetAtMs(text: string, nowMs: number, daemonTimeZone: string): number | null {
  const reset =
    epochResetAtMs(text) ??
    relativeResetAtMs(text, nowMs) ??
    absoluteResetAtMs(text, nowMs, daemonTimeZone);
  // A reset that is more than moments old was not meant for this turn.
  if (reset === null || reset < nowMs - 10 * 60_000) return null;
  return reset;
}

/** Claude's legacy `Claude AI usage limit reached|1759300000`. */
function epochResetAtMs(text: string): number | null {
  const epoch = /\|(\d{10,13})\b/.exec(text);
  if (!epoch) return null;
  const value = Number(epoch[1]);
  return value < 1e12 ? value * 1_000 : value;
}

function relativeResetAtMs(text: string, nowMs: number): number | null {
  const marker = /(?:try again|resets?|retry|available again|renews?)\s+(?:in|after)\s+/i.exec(text);
  if (!marker) return null;
  // Only the duration right after the marker ("2 hours 13 minutes", "6h53m44s"); later
  // digits, such as a request ID, are not part of it.
  const duration = new RegExp(`^(?:\\s*(?:,|and)?\\s*\\d+(?:\\.\\d+)?\\s*${UNIT}(?![a-z]))+`, "i").exec(
    text.slice(marker.index + marker[0].length),
  );
  if (!duration) return null;
  const units = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT}`, "gi");
  let totalMs = 0;
  for (let match = units.exec(duration[0]); match; match = units.exec(duration[0])) {
    totalMs += Number(match[1]) * (UNIT_MS[match[2]!.toLowerCase()] ?? 0);
  }
  return totalMs > 0 ? nowMs + totalMs : null;
}

function absoluteResetAtMs(text: string, nowMs: number, daemonTimeZone: string): number | null {
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?\b/i.exec(text);
  if (iso) {
    const parsed = Date.parse(iso[0]);
    if (Number.isFinite(parsed)) return parsed;
  }
  const clock = clockResetAtMs(text, nowMs, daemonTimeZone);
  if (clock !== null) return clock;
  // Dated phrases, e.g. Codex weekly: "try again at Oct 9th, 2026 4:13 AM" in the
  // daemon's zone. Date.parse rejects ordinal suffixes, so they are stripped.
  const dated = /(?:resets?|renews?|try again|available again)(?:\s+(?:at|on|after))?\s+([^\n.(]{4,80})/i.exec(text);
  if (dated) {
    const parsedMs = Date.parse(dated[1]!.trim().replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1"));
    if (Number.isFinite(parsedMs)) return parsedMs;
  }
  return null;
}

/** "resets 3pm (Asia/Seoul)", "try again at 6:03 AM": the next such wall-clock time. */
function clockResetAtMs(text: string, nowMs: number, daemonTimeZone: string): number | null {
  const clock =
    /(?:resets?|renews?|try again|available again)(?:\s+(?:at|after|until))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(
      text,
    );
  if (!clock) return null;
  let hour = Number(clock[1]) % 12;
  if (clock[3]!.toLowerCase() === "pm") hour += 12;
  const minute = Number(clock[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return resetFromClock({ kind: "clock", hour, minute, timeZone: clock[4]?.trim() ?? null }, nowMs, daemonTimeZone);
}
