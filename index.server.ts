import type {
  PluginHookAgent,
  PluginHookContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import { clearAttention } from "./server/attention";
import { detectLimitStop, type TimelineItem, type TurnOutcome } from "./server/limit";
import { findLimitNotice, resetFromClock } from "./server/notice";
import { describeUsage, findExhaustion, resetFromUsage } from "./server/usage";

// Fixed text. Nothing from the transcript or the provider error is ever sent.
const RESUME_PROMPT =
  "Your previous turn stopped because the provider usage limit was reached. " +
  "The limit has now reset. Continue where you left off. " +
  "If the task was already complete, reply briefly that it is done and do nothing else.";

const MINUTE = 60_000;
const RESUME_DELAY_AFTER_RESET_MS = 2 * MINUTE;
// Paseo caches provider usage for five minutes; re-check once after that expires.
const STALE_USAGE_RECHECK_MS = 6 * MINUTE;
// Longest wait we accept. Covers weekly limits; anything later is treated as unknown.
const MAX_WAIT_MS = 8 * 24 * 60 * MINUTE;
// A 5-hour window can reset at most five times in 24 hours; one more allows a weekly reset.
// Each limit is already resumed only once; this cap is a backstop against runaway loops.
const MAX_RESUMES_PER_AGENT_PER_DAY = 6;
const DAEMON_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

type PaseoApi = PluginHookContext["paseo"];

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  label: string;
}

export default function contribute(server: PluginServerContext) {
  const pending = new Map<string, Pending>();
  const resumedLimits = new Set<string>();
  const resumeTimes = new Map<string, number[]>();

  function cancel(agentId: string, reason: string) {
    const entry = pending.get(agentId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(agentId);
    console.log(`[${agentId}] cancelled ${entry.label}: ${reason}`);
  }

  function schedule(agentId: string, delayMs: number, label: string, run: () => Promise<void>) {
    cancel(agentId, "replaced");
    const timer = setTimeout(() => {
      pending.delete(agentId);
      run().catch((error) => console.error(`[${agentId}] ${label} failed:`, error));
    }, delayMs);
    pending.set(agentId, { timer, label });
    console.log(`[${agentId}] scheduled ${label} at ${new Date(Date.now() + delayMs).toISOString()}`);
  }

  function scheduleResume(agent: PluginHookAgent, paseo: PaseoApi, limitId: string, resetsAtMs: number) {
    const now = Date.now();
    if (resetsAtMs - now > MAX_WAIT_MS) {
      console.log(`[${agent.id}] ${limitId} resets more than ${MAX_WAIT_MS / (24 * 60 * MINUTE)} days away; not resuming`);
      return;
    }
    const limitKey = `${agent.id}:${limitId}:${resetsAtMs}`;
    if (resumedLimits.has(limitKey)) {
      console.log(`[${agent.id}] already resumed once for ${limitId}; not repeating`);
      return;
    }
    const recent = (resumeTimes.get(agent.id) ?? []).filter((time) => now - time < 24 * 60 * MINUTE);
    if (recent.length >= MAX_RESUMES_PER_AGENT_PER_DAY) {
      console.log(`[${agent.id}] daily resume cap reached; not scheduling`);
      return;
    }

    const delayMs = Math.max(0, resetsAtMs - now) + RESUME_DELAY_AFTER_RESET_MS;
    schedule(agent.id, delayMs, `resume after ${limitId} reset`, async () => {
      const ref = paseo.agents.ref(agent.id);
      await ref.refresh();
      const busy = ref.status === "running" || ref.status === "initializing";
      if (busy || ref.status === "closed" || ref.archivedAt || ref.activeTurn || ref.pendingPermissions?.length) {
        console.log(`[${agent.id}] skipped resume: agent is ${ref.status ?? "unavailable"}`);
        return;
      }
      resumedLimits.add(limitKey);
      resumeTimes.set(agent.id, [...recent, Date.now()]);
      // Otherwise the unread limit notice suppresses the notification for the resumed turn.
      if (ref.current()?.requiresAttention && !clearAttention(agent.id)) {
        console.log(`[${agent.id}] could not clear the unread flag; the resumed turn may not notify`);
      }
      await ref.send(RESUME_PROMPT);
      console.log(`[${agent.id}] resumed`);
    });
  }

  async function readUsage(agent: PluginHookAgent, paseo: PaseoApi) {
    const { providers } = await paseo.providers.listUsage();
    console.log(`[${agent.id}] usage: ${describeUsage(providers, agent.provider)}`);
    return providers;
  }

  async function checkUsageAfterFailure(agent: PluginHookAgent, paseo: PaseoApi, isRecheck: boolean) {
    const providers = await readUsage(agent, paseo);
    const exhaustion = findExhaustion(providers, agent.provider, Date.now(), MAX_WAIT_MS);
    if (exhaustion) {
      scheduleResume(agent, paseo, exhaustion.limitId, exhaustion.resetsAtMs);
    } else if (!isRecheck) {
      schedule(agent.id, STALE_USAGE_RECHECK_MS, "usage re-check", () =>
        checkUsageAfterFailure(agent, paseo, true),
      );
    }
  }

  async function onTurnEnded(
    agent: PluginHookAgent,
    outcome: TurnOutcome,
    timeline: readonly TimelineItem[],
    paseo: PaseoApi,
  ) {
    // Claude Code reports a usage limit as an ordinary final message, not as an error,
    // so the notice is the primary signal. It must be the last line of the final text.
    const notice = findLimitNotice(timeline);
    const now = Date.now();
    // Other providers word their limits differently; some end the turn as an ordinary
    // reply, some fail it. detectLimitStop covers both, whatever the provider.
    const stop = notice ? null : detectLimitStop(outcome, timeline, now, DAEMON_TIME_ZONE);
    if (!notice && !stop) {
      // A failed turn with no recognized notice can still be a limit: confirm with usage data.
      if (outcome.kind === "failed") await checkUsageAfterFailure(agent, paseo, false);
      return;
    }

    const providers = await readUsage(agent, paseo);
    const resetsAtMs = notice
      ? // Structured data beats the notice's clock time.
        (resetFromUsage(providers, agent.provider, notice.kind, now, MAX_WAIT_MS) ??
          resetFromClock(notice, now, DAEMON_TIME_ZONE))
      : // A stated reset time is the provider's own; usage data may still reveal a later
        // limit that must clear first, so the later of the two wins.
        (() => {
          const exhaustion = findExhaustion(providers, agent.provider, now, MAX_WAIT_MS);
          const stated = stop!.resetsAtMs;
          if (exhaustion && stated !== null) return Math.max(exhaustion.resetsAtMs, stated);
          return exhaustion?.resetsAtMs ?? stated;
        })();
    const limitId = notice ? `${notice.kind} limit` : `${agent.provider} ${stop!.source}`;

    if (resetsAtMs === null) {
      console.log(`[${agent.id}] limit stop, but no usable reset time yet; will re-check usage once`);
      schedule(agent.id, STALE_USAGE_RECHECK_MS, "usage re-check", () =>
        checkUsageAfterFailure(agent, paseo, true),
      );
      return;
    }
    scheduleResume(agent, paseo, limitId, resetsAtMs);
  }

  // Any new turn, whether from the user or elsewhere, means the agent is no longer waiting.
  server.on("agent.turn_started", ({ agent }) => cancel(agent.id, "a new turn started"));
  server.on("agent.archived", ({ agent }) => cancel(agent.id, "agent archived"));

  server.on("agent.turn_ended", async ({ agent, outcome }, { paseo }) => {
    if (outcome.kind === "canceled") return;
    try {
      // Since Paseo 0.14 the hook's own timeline is always empty; fetch the tail instead.
      const page = await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 20 });
      const timeline = page.entries.map((entry) => entry.item);
      console.log(`[${agent.id}] turn ${outcome.kind} (${agent.provider}, ${timeline.length} timeline items)`);
      await onTurnEnded(agent, outcome, timeline, paseo);
    } catch (error) {
      console.error(`[${agent.id}] limit check failed:`, error);
    }
  });

  return () => {
    for (const agentId of [...pending.keys()]) cancel(agentId, "plugin stopped");
  };
}
