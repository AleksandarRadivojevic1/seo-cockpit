# seo-cockpit agents

Three LLM agents, run by [Paperclip](https://paperclip.ing/), that turn
seo-cockpit's numbers into SEO work. They sit on top of the cockpit and change
nothing inside it.

```
 collector (daily 03:00 UTC)     dashboard                     Paperclip (you = board)
 GSC, CWV, autocomplete  -->  seo.db  -->  /api/agent/digest  -->  SEO Analyst (weekly, Flash)
                                                                     | proposes <=3 actions/site
                                                                     v
                                                          you approve / reject
                                                                     |
                                    agents/tools/page_facts.py  -->  SEO Strategist (on approval, Argon)
                                                                     | brief + baseline
                                                                     v
                                                          you ship it on the site
                                                                     |
                                     28+ days later  -------------->  Analyst measures it (?track=)

                                     monthly  ---------------------->  Demand Scout (Flash)
                                                                       proposes seeds + SerpApi plan
```

## The five rules everything here keeps

1. **The collector stays the only writer of `seo.db`.** Agents read the
   digest and write tickets. They never run collector commands.
2. **Numbers come from the digest, copied, never recomputed.** The digest is
   built from `buildReportData`, the function the client report uses, so a
   ticket cannot cite a number the client's PDF disagrees with.
3. **`null` means not measured.** Same rule as the dashboard. An agent that
   writes a null as `0`, "flat" or "no traffic" is wrong.
4. **Nothing metered and nothing client-facing runs without you.** SerpApi
   credits, `sites.yaml` changes, site edits and client reports all wait for
   the board.
5. **Wake on assignment, not on a timer.** The only timers are two routines
   (weekly review, monthly scout). An idle heartbeat costs tokens to find
   nothing.

## What each agent does

| Agent | Model | Wakes when | Reads | Writes |
|---|---|---|---|---|
| [SEO Analyst](seo-analyst.md) | `gemini-3.8-flash` | Weekly routine ticket; a `measure` ticket | Digest for every site, open and shipped `seo-action` tickets | A weekly briefing, at most 3 proposed actions per site, measurements of shipped work |
| [SEO Strategist](seo-strategist.md) | `gemini-4-argon` (medium thinking) | You assign it an approved action | That site's digest, `page_facts.py` output for the target page | A ready-to-ship brief in the client's language, plus a baseline |
| [Demand Scout](demand-scout.md) | `gemini-3.8-flash` | Monthly routine ticket | Digests, `collector/sites.yaml`, free autocomplete | A proposed `sites.yaml` diff and a SerpApi plan you run yourself |

Why Argon only for the Strategist: it is the one step where judgment and
writing quality show up in a client's search result. The Analyst and the Scout
sort and summarize numbers that are already computed, which Flash does well at
a fraction of the price.

## Setup

### 1. Deploy the digest

The digest ships with the dashboard. After deploying this branch, check it from
the Pi:

```sh
curl -su "acko:$SEO_DASHBOARD_PASSWORD" "http://127.0.0.1:8091/api/agent/digest?site=optika-cajs" | head -c 600
```

It sits behind the dashboard's Basic auth like every other admin path. With
`SEO_INTERNAL_HOSTS` set, as it is once share links are deployed, it is also
a 404 on `clients.deimos.agency` even with valid credentials. Loopback always
counts as internal, so agents on the Pi reach it either way. Give the agents
the credential through `~/.netrc` on the machine they run on, so it never
appears in a prompt or a ticket:

```
machine 127.0.0.1 login acko password <SEO_DASHBOARD_PASSWORD>
```

```sh
chmod 600 ~/.netrc
curl -sn "http://127.0.0.1:8091/api/agent/digest" | head -c 200   # what the agents run
```

### 2. Gemini credentials

Use a **paid Gemini API key** (`GEMINI_API_KEY`), not your Google AI Pro
login: Argon is not available on the Pro plan through the API, and an API key
gives Paperclip exact per-token costs to enforce budgets against.

### 3. Paperclip company

Create one company, **Deimos SEO**.

- **Mission:** Grow non-brand search traffic for every Deimos site, and prove
  it with before/after numbers.
- **Board:** you. Keep hiring gated by board approval (the default).

Create the three agents. All use the `gemini_local` adapter, with `cwd` set to
the seo-cockpit checkout on the Pi and `instructionsFilePath` pointing at the
file in this folder:

| Agent | `model` | `instructionsFilePath` | Monthly budget |
|---|---|---|---|
| SEO Analyst | `gemini-3.8-flash` | `agents/seo-analyst.md` | $3 |
| SEO Strategist | `gemini-4-argon` | `agents/seo-strategist.md` | $5 |
| Demand Scout | `gemini-3.8-flash` | `agents/demand-scout.md` | $2 |

Budgets are about 2-3x the expected spend (see Costs) so a normal month never
pauses an agent, and a runaway loop always does. Paperclip warns at 80% and
pauses at 100%.

Turn **off** scheduled heartbeats for all three. Add two routines:

| Routine | When | Creates a ticket for |
|---|---|---|
| Weekly SEO review | Mondays 08:00 UTC | SEO Analyst, title `Weekly review <ISO week>` |
| Monthly demand scout | Monthly, 08:30 UTC (a Monday, if the schedule allows) | Demand Scout, title `Demand scout <YYYY-MM>` |

08:00 UTC lands an hour after the collector's Monday digest, so the week's data
is in.

### 4. Ticket labels

The agents find each other's work through labels. If your Paperclip version
has no labels, put them in the title instead, e.g.
`[seo-action][site:optika-cajs][needs-approval] Rewrite title for "tečnost za sočiva"`.
The instructions accept either form. Create these:

| Label | Meaning |
|---|---|
| `seo-action` | A proposed or approved piece of SEO work. |
| `site:<slug>` | Which site, e.g. `site:optika-cajs`. |
| `needs-approval` | Waiting for you. |
| `ready-to-ship` | The Strategist's brief is done; you ship it. |
| `shipped` | You shipped it. Add the date in a comment: `Shipped: 2026-11-03`. |
| `measured` | The Analyst has measured the result. |

## Your weekly 15 minutes

1. Monday: read the Analyst's briefing ticket.
2. For each proposed action: assign it to the SEO Strategist (approve) or close
   it with a one-line reason. The reason matters: the Analyst reads closed
   tickets and stops proposing what you rejected.
3. When a brief is `ready-to-ship`: make the change on the site, then label the
   ticket `shipped` and comment the date.
4. Monthly: review the Scout's `sites.yaml` diff, commit what you agree with,
   and run its SerpApi plan yourself with `--dry-run` first.

## Costs

Per month, at Google's published rates. Assumes 3 sites, weekly reviews and
8 approved briefs a month.

| | Oct-Nov 2026 | Dec 2026 | Jan 2027+ |
|---|---|---|---|
| SEO Analyst (Flash, ~13k in / 4k out per run) | $0.11 | $0.11 | $0.21 |
| SEO Strategist (Argon, ~9k in / 7k out per brief) | $0.70 | $1.39 | $1.39 |
| Demand Scout (Flash) | $0.07 | $0.07 | $0.14 |
| **Total** | **~$0.90** | **~$1.60** | **~$1.75** |

Argon doubles on 2026-12-01 and Flash on 2027-01-01. Output pricing includes
thinking tokens.

The Strategist reads `page_facts.py` output, about 2-3k tokens, instead of
the raw page. Reading raw HTML (often 30-150k tokens) would cost about $0.20
per brief now and $0.40 after December, more than double the whole budget
above.

## What the agents cannot know yet: search volume

No free source gives keyword volume. Autocomplete gives breadth and an order,
and Trends gives a rising signal above a volume floor. The digest says so in
its `semantics` block, and the agents are told not to estimate volume.

If you want real volume numbers, add DataForSEO's Google Ads search volume as
a third `DemandSource` in `collector/seocockpit/demand.py`. The interface and
the `volume` column already exist for it. It costs $0.06 per task of up to
1,000 keywords in standard mode, so the whole portfolio is cents a month.
Expect many Serbian long-tail terms to come back null or very low: Google Ads
withholds low-volume figures, and that is a real answer, not a failure.
