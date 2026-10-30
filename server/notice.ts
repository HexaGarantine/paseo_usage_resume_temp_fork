// Detects Claude Code's usage-limit notice, e.g.
//   "You've hit your session limit · resets 5:50pm (America/Los_Angeles)"
// Pure functions, no I/O.

export interface TimelineItem {
  type: string;
  text?: string;
}

export interface LimitNotice {
  /** "session", "weekly", "opus weekly", ... as written in the notice. */
  kind: string;
  hour: number;
  minute: number;
  timeZone: string | null;
}

// The whole line must be the notice. Anything the agent quoted mid-sentence does not match.
const NOTICE =
  /^You['’]ve hit your ([a-z0-9 ]+?) limit\s*[·∙•-]\s*resets (\d{1,2})(?::(\d{2}))?\s*([ap]m)(?:\s*\(([A-Za-z0-9_+\-/]+)\))?$/i;

/**
 * Returns the notice when it is the last line of the agent's final text, i.e. the
 * assistant messages after the last item of any other kind. Returns null otherwise.
 */
export function findLimitNotice(timeline: readonly TimelineItem[]): LimitNotice | null {
  let start = timeline.length;
  while (start > 0 && timeline[start - 1]?.type === "assistant_message") start--;
  // Item boundaries are line breaks: a separate notice item stays its own line even
  // when the previous reply does not end with a newline.
  const finalText = timeline
    .slice(start)
    .map((item) => item.text ?? "")
    .join("\n");
  const lastLine = finalText.trim().split("\n").pop()?.trim() ?? "";

  const match = NOTICE.exec(lastLine);
  if (!match) return null;
  const [, kind, hourText, minuteText, meridiem, timeZone] = match;
  const hour12 = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0);
  return { kind: kind!.toLowerCase(), hour, minute, timeZone: timeZone ?? null };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock time of an instant in an IANA time zone. */
function wallClock(ms: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetMs(ms: number, timeZone: string): number {
  const clock = wallClock(ms, timeZone);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time occurs in a zone. Day overflow rolls into the next month. */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Apply the offset twice so a daylight-saving change between the guess and the answer is honoured.
  const first = asUtc - offsetMs(asUtc, timeZone);
  return asUtc - offsetMs(first, timeZone);
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Next occurrence of the notice's clock time in the time zone the notice names,
 * or in the daemon's time zone when it names none. Returns null for an unknown zone.
 */
export function resetFromClock(
  notice: LimitNotice,
  nowMs: number,
  daemonTimeZone: string,
): number | null {
  const timeZone = notice.timeZone ?? daemonTimeZone;
  if (!isValidTimeZone(timeZone)) return null;
  const today = wallClock(nowMs, timeZone);
  let reset = zonedToUtc(today.year, today.month, today.day, notice.hour, notice.minute, timeZone);
  // A reset that passed moments ago is still the right one; older means tomorrow.
  if (reset < nowMs - 10 * 60_000) {
    reset = zonedToUtc(today.year, today.month, today.day + 1, notice.hour, notice.minute, timeZone);
  }
  return reset;
}
