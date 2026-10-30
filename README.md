# paseo-usage-resume

A server-only [Paseo](https://paseo.sh) plugin that resumes an agent after it stops at a
provider usage limit, once the limit has reset.

## How it works

When an agent's turn ends, the plugin checks why it stopped:

- **Claude** reports a usage limit as an ordinary final message, for example
  `You've hit your session limit · resets 5:50pm (America/Los_Angeles)`. The plugin acts only when
  that notice is the last line of the agent's final message and matches exactly. The reset time
  comes from Paseo's usage data for the matching window. Without it, the plugin converts the
  notice's clock time from the time zone the notice names, so it works on daemons in any zone.
- **Other providers** word their limits differently, and some end the turn as an ordinary reply
  instead of failing it. The plugin therefore also reads the turn's failure text, the turn's
  error and notification items, and its closing reply, looking for the limit phrasings providers
  use (`You've hit your usage limit`, `usage limit reached`, `quota exceeded`,
  `RESOURCE_EXHAUSTED`, `Too many requests`, ...). A notice that states its own reset time —
  `resets in 2 hours 13 minutes`, `try again at Oct 20th, 2026 9:48 PM`, `resets 3pm (Asia/Seoul)`,
  an ISO timestamp, or Claude's legacy epoch suffix — is resumed at that time even when Paseo has
  no usage source for the provider. A notice without a stated reset is confirmed against Paseo's
  usage data: the plugin acts only if a usage window for that provider is at 100%, and re-checks
  once after Paseo's five-minute usage cache expires.
- Providers that fail the turn without any recognized notice are still checked against Paseo's
  usage data alone, and resumed when a window is at 100%.

Billing and context stops are never resumed: a prepaid balance or workspace credits that ran out
does not renew on a clock, and their phrases (`insufficient_quota`, `credit balance`,
`out of credits`, context-length errors) exclude a text from being a limit notice.

Two minutes after the reset, it sends the agent a fixed prompt:

> Your previous turn stopped because the provider usage limit was reached. The limit has now
> reset. Continue where you left off. If the task was already complete, reply briefly that it is
> done and do nothing else.

Before sending it, the plugin marks the agent as read. Paseo notifies only when an agent goes
from read to unread, so without this an unopened limit notice would keep the resumed turn from
notifying when it finishes. The plugin API has no call for this, so the plugin sends the same
request the app sends when an agent is opened, over its existing daemon connection.

## Safeguards

- The prompt is fixed text. Nothing from the transcript or the provider error is sent.
- Each limit is resumed once, with a backstop of six resumes per agent per day.
- A pending resume is cancelled when a new turn starts or the agent is archived.
- Just before sending, the agent must be idle, with no active turn or pending permission request.
- Without a usable reset time, or with a reset more than eight days away, it does nothing.
- Notices are short texts that open with the limit statement, so an answer that merely discusses
  or quotes a limit does not trigger a resume.
- No runtime dependencies, network calls, or shell commands of its own.

## Limitations

- Pending resumes live in memory; a plugin reload or daemon restart drops them.
- Marking the agent as read relies on Paseo's internal plugin connection format, which a
  Paseo update could change. If it breaks, the resume still happens but may not notify.
- Credit balances are ignored, since a zero prepaid balance is normal.
- A weekly notice that names a date rather than a time is not matched by the strict Claude
  notice; the generic detector's dated phrases still cover such resets for other providers.
- The generic limit phrasings are a heuristic distilled from real provider notices (see the
  comment in `server/limit.ts` for their sources). A provider that words a limit unusually
  still needs Paseo usage data to be resumed, and a provider Paseo reports no usage for is
  resumed only when its own notice states the reset time.
- Matching an agent to its usage entry is by provider ID only; an agent signed in with a
  different account than the one Paseo's usage source reports is not distinguished.

## Install

Plugins must be enabled on the daemon (**Settings → Plugins → Enable plugins**). The plugin
runs as trusted, unsandboxed code on that daemon, so install it only from a source you control.

```bash
paseo plugin install github:mdbraber/paseo-usage-resume
paseo plugin ls                          # expect: running
paseo plugin logs paseo-usage-resume     # one line per finished turn, plus usage numbers
```

Install it on every daemon that runs agents you want resumed. Clients that only connect to a
daemon do not need it.

## Deploy to several daemons

`scripts/deploy.sh` copies the plugin to each host over SSH (plain `tar`, no `rsync` needed) and
installs or reloads it there. The local daemon is reloaded in place.

```bash
scripts/deploy.sh                      # hosts from scripts/deploy.local
scripts/deploy.sh host-a host-b        # only these
```

`scripts/deploy.local` is not tracked by Git. It sets the default hosts and SSH options:

```bash
HOSTS=(local host-a host-b)
SSH_OPTS=(-o BatchMode=yes -i ~/.ssh/deploy_key)
```

Plugins must already be enabled on each daemon; the script never changes that setting.

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin reload paseo-usage-resume
```
