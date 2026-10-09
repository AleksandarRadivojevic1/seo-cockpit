# Deploying seo-cockpit on the Pi

Two containers: a Python **collector** that writes `seo.db` on a daily schedule,
and a Next.js **dashboard** that reads it. They share one directory; only the
collector writes to it.

Target: Raspberry Pi 5 (arm64) at `192.168.1.156`, folded into the existing
`~/server/docker-compose.yml`.

---

## 1. Storage: nothing to move

Measured against the real device (Pi 5 4 GB, 2026-07-26), so this is not an
estimate.

| | size | free |
| --- | --- | --- |
| SD card `/` (`mmcblk0p2`) | 57 G | **41 G** |
| NVMe `/media/library` | 458 G | 299 G |
| Docker root dir | `/var/lib/docker` (on the SD) | — |

What seo-cockpit costs:

| item | size |
| --- | --- |
| dashboard image | ~1.37 GB (carries chromium, see below) |
| collector image | ~270 MB |
| Docker build cache after building both | ~1.9 GB (reclaimable) |
| `seo.db` today | 140 KB |

**Leave Docker's `data-root` where it is.** ~2.5 GB against 41 GB free is
noise, and relocating it to the media NVMe would mix a service store into the
media volume for no benefit.

**The database needs no special placement either.** All three sites together
produce **~15.5 rows/day at ~321 bytes/row including index and page overhead —
about 5 KB/day, or 2 MB/year.** `seo.db` is 140 KB after 80 days. At twenty
sites it would still be low tens of MB per year. SD write wear at 5 KB/day is
not a consideration; it lives in the repo checkout on `/` and that is fine.

The only housekeeping worth doing is reclaiming the build cache afterwards:

```bash
docker builder prune -f          # frees ~1.7 GB of the ~1.9 GB
```

### Memory during the build

The Pi has 4 GB with ~2.1 GB available while the existing stack (Home
Assistant, Grafana, InfluxDB, Node-RED, …) is running, plus 2 GB of zram swap.
A Next build fits, but there is not a lot of headroom. If `next build` is
OOM-killed, cap the heap rather than stopping other services:

```bash
docker compose build --build-arg NODE_OPTIONS=--max-old-space-size=1536 seo-cockpit-dashboard
```

### Chromium in the dashboard image

The dashboard image installs the Debian `chromium` package (available for arm64
on bookworm — verified 2026-07-27). **Measured cost: the image goes 403 MB →
1.37 GB**, so budget ~970 MB. `du /usr/lib/chromium` reports only 330 MB and is
misleading — it omits the dependency tree (gtk, pango, cairo, mesa, x11).

A rebuild also leaves the previous image orphaned (~1.4 GB) and adds ~2 GB of
build cache, so a deploy costs ~4 GB until reclaimed:

```bash
docker image prune -f && docker builder prune -f   # after a successful deploy
```
It is a **runtime** dependency, not a build tool: `/site/<slug>/report/pdf`
prints the live report page to a PDF so the client gets a downloaded file
rather than the browser's print dialog, which no web API can bypass.

It is spawned as a subprocess, not through Puppeteer or Playwright — those
would vendor a second copy of the same browser. Each render is one short-lived
process using roughly 200–300 MB, and the report is produced by hand a couple
of times a month, so it does not compete with the collector's nightly run.

---

## 1b. Database backups

`seo.db` is the only irreplaceable thing here. GSC serves ~16 months and no
amount of re-running can recover a day that was never collected, so losing the
file loses measurement permanently — and silently, since every page would just
render its empty state.

The collector snapshots it after every run, keeping the **14 most recent** days:

- **Target: `/media/library/backups/seo-cockpit`** on the NVMe drive, mounted
  into the collector at `/backups`. A different physical device from the SD
  card by design — a copy beside the original survives a bad `rm`, but not a
  dead card, and card failure is the likelier way to lose a Pi's storage.
- **`SEO_BACKUP_DIR` unset disables backups.** There is no fallback path on
  purpose: the only default available would be the SD card, and a backup that
  dies with its original is worse than none because it looks like protection.
- Snapshots use SQLite's **online backup API**, not `cp`. Copying a live
  database can capture a page mid-write and produce a file that opens fine and
  is subtly corrupt. This also needs no `sqlite3` binary — the Pi has none.
- A backup failure never fails the collection run; it is logged and the run
  still reports `success`. Same isolation rule as the CWV fetch.

Verify after a deploy:

```bash
docker exec seo-cockpit-collector printenv SEO_BACKUP_DIR   # must print /backups
ls -la /media/library/backups/seo-cockpit                   # seo-<date>.db
```

### Restoring a snapshot

The snapshots are plain SQLite databases, so there is nothing to unpack. Run
these on the Pi as `acko`, not with `sudo`: the restored file must stay owned
by the host uid both containers run as (see "Container user" in section 4).

```bash
cd ~/server

# 1. Stop the collector, so no scheduled or run-now collection writes seo.db
#    partway through the copy.
docker compose stop seo-cockpit-collector

# 2. Keep the current file, then copy a snapshot over it. A leftover
#    seo.db-journal belongs to the old file and must not be replayed onto the
#    restored one.
ls -la /media/library/backups/seo-cockpit/        # seo-<date>.db, 14 most recent
cp seo-cockpit/data/seo.db seo-cockpit/data/seo.db.before-restore-$(date +%F-%H%M%S)
cp /media/library/backups/seo-cockpit/seo-<date>.db seo-cockpit/data/seo.db
rm -f seo-cockpit/data/seo.db-journal

# 3. Start the collector again.
docker compose start seo-cockpit-collector

# 4. Restart the dashboard too.
docker compose restart seo-cockpit-dashboard
```

**Step 4 is not optional.** `getDb()` (`app/lib/db.ts`) opens one read-only
connection per path and keeps it for the life of the process, and that handle
goes on serving the pre-restore data, which looks exactly like a restore that
did nothing. Measured with better-sqlite3 on 2026-10-09: an open handle kept
reading the old rows whether the snapshot went in by `mv` or by `cp` over the
file, while a fresh handle read the restored ones.

**Then refill the gap.** A snapshot stops at the day it was taken, and the
nightly run only re-fetches its last 5 days (plus the 3-day GSC lag), so any
older days between the snapshot and now stay missing. A backfill re-fetches 90
days; the upserts are idempotent, so it only fills holes:

```bash
docker compose run --rm seo-cockpit-collector \
  python -m seocockpit.schedule run --backfill
```

Core Web Vitals and the query × page snapshot are point-in-time, so the days
in between can't be recovered for those; only the Search Console tables can.
The same backfill fills the hole left by any outage longer than a week (a
outage that kept the Pi down 2026-09-22 → 10-06 left 2026-09-20 → 09-28
missing on every site).

---

## 1c. Dashboard-added sites (`config/`)

The dashboard's **Add site** form lets you register a Search Console property
without editing `sites.yaml` and redeploying. It writes a single file,
`config/user-sites.json`, which the collector merges with the `sites.yaml`
seed sites on every run.

```bash
mkdir -p ~/server/seo-cockpit/config
# owned like data/ — the dashboard container (running as your host uid) writes it
chown ${SEO_COCKPIT_UID:-1000}:${SEO_COCKPIT_GID:-1000} ~/server/seo-cockpit/config
```

- **The dashboard mounts `config/` read-write; the collector mounts it
  read-only.** This is a *different* directory from `data/` on purpose: it is
  the only thing the dashboard writes, so the `seo.db` mount stays read-only
  and the invariant in section 3 is untouched.
- `SEO_USER_SITES_PATH` (default `/config/user-sites.json`) points both
  containers at the file. A missing file just means no dashboard-added sites —
  the feature is dormant until you add one.
- **A hand edit that breaks the JSON pauses adding and removing.** The
  dashboard shows the parse error instead of treating the file as empty (and
  writing back a list without every site it held). Every dashboard write first
  copies the current file to `user-sites.json.bak`, so the version before the
  last change is always one `cp` away.
- **Removing a site retires it; it does not delete it.** The collector marks
  every site no longer in the config `active = 0` on its next run: it leaves
  the overview and its page 404s, but its history stays. Adding the same
  property again restores it. A retired site's slug stays reserved for that
  property.
- **"Run collection now" is limited to one run per 10 minutes.** A trigger that
  lands within 10 minutes of the last finished run (nightly or manual) is
  logged and dropped, since each run costs several minutes of PageSpeed calls.
- **A newly added site starts collecting on the next nightly run** (03:00 UTC)
  and backfills ~90 days of history on that first run. Until then the overview
  lists it under "Awaiting collection".
- **The add-site form checks Search Console access up front.** The dashboard
  still holds no Google credentials, so it validates against a list the
  collector publishes: `data/accessible-properties.json`, the service account's
  `sites().list()`, refreshed at the start of every run. A property the account
  cannot read is rejected in the form — with a "did you mean `sc-domain:…`?"
  hint when you typed the wrong form (URL-prefix vs domain) of a property it
  *can* read. If the list has not been published yet (fresh deploy, no run
  since), the check soft-allows and the first run confirms access as before.
- **Just granted access? Use "Refresh access list".** The button on the add
  form writes `config/refresh-properties.json`; the collector's watcher (~15s)
  republishes the list without a full collection, so the new property passes
  the check without waiting for the nightly run.

Verify after a deploy:

```bash
docker exec seo-cockpit-dashboard printenv SEO_USER_SITES_PATH  # /config/user-sites.json
docker exec seo-cockpit-collector printenv SEO_USER_SITES_PATH  # same value
# The accessible-property paths differ per container (same host file, different
# mount point) — this is deliberate, exactly like SEO_DB_PATH:
docker exec seo-cockpit-dashboard printenv SEO_ACCESSIBLE_PROPERTIES_PATH  # /data/accessible-properties.json
docker exec seo-cockpit-collector printenv SEO_ACCESSIBLE_PROPERTIES_PATH  # /app/data/accessible-properties.json
docker exec seo-cockpit-dashboard printenv SEO_REFRESH_TRIGGER_PATH        # /config/refresh-properties.json
docker exec seo-cockpit-collector printenv SEO_REFRESH_TRIGGER_PATH        # same value
```

> As with every variable here, adding `SEO_USER_SITES_PATH`,
> `SEO_ACCESSIBLE_PROPERTIES_PATH`, `SEO_REFRESH_TRIGGER_PATH` and the `config/`
> mount to `compose.snippet.yml` does nothing on its own — the same lines must
> be pasted into the live `~/server/docker-compose.yml`, and the directory
> created. Diff the snippet against the live file after editing (see section 4).
> No new mount is needed for the accessible-property list: it lives in the
> existing `data/` volume (collector-write, dashboard-read).

---

## 1d. Client share links (`clients.deimos.agency`)

A client gets a link like `https://clients.deimos.agency/share/<token>`. It
opens their report (their site's language, SR / EN switch, PDF download) and a
read-only **Live data** tab, and nothing else: on that address every other path
is a 404, and the token alone decides which site is shown.

- **Create a link** on the site's page ("Share with client"). The URL is shown
  **once**: only a hash of its token is stored (`config/share-links.json`), so a
  lost link is revoked and replaced, never recovered.
- **List and revoke** links at `/sites/links`. Links never expire. Removing a
  site stops its links too.
- **`SEO_INTERNAL_HOSTS`** lists the `Host` values that get the admin app (still
  behind the password): `192.168.1.156:8091,piserver.local:8091,localhost:8091`.
  **If your own dashboard suddenly shows "Not found", you reached it under a
  host that isn't listed** (e.g. `piserver:8091`): add it to the compose file and
  the live file, then recreate the dashboard.
- **The tunnel** (`seo-cockpit-tunnel`, `cloudflare/cloudflared:2026.9.3`) dials
  out to Cloudflare; the Pi opens no inbound port. Its public hostname
  `clients.deimos.agency` → `http://seo-cockpit-dashboard:3000` is set in
  Cloudflare (Zero Trust → Networks → Tunnels → `seo-cockpit`).
- **`SEO_TUNNEL_TOKEN`** is the tunnel's run token. Copy it from that tunnel's
  page in the Cloudflare dashboard into `~/server/.env`; never paste it anywhere
  else. Add the `seo-cockpit-tunnel` service to the live compose file only after
  the token is set: its `:?` stops `docker compose` for the whole stack until
  then.

Verify after a deploy:

```bash
docker logs seo-cockpit-tunnel 2>&1 | grep -i "registered tunnel connection"
curl -s -o /dev/null -w '%{http_code}\n' https://clients.deimos.agency/          # 404
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8091/                   # 401
```

---

## 2. Secrets

Two credentials, and they are different things:

- **Service-account JSON** — Search Console access. Mounted read-only.
- **`GOOGLE_API_KEY`** — PageSpeed Insights *and* Chrome UX Report.

```bash
mkdir -p ~/server/seo-cockpit/collector/secrets
# copy the key from your machine, e.g.:
#   scp collector/secrets/<name>.json \
#     acko@piserver.local:~/server/seo-cockpit/collector/secrets/service-account.json
chmod 600 ~/server/seo-cockpit/collector/secrets/service-account.json
```

The filename must match `service_account_path` in `collector/sites.yaml`
(currently `secrets/service-account.json`, resolved relative to the working
directory, which the compose file sets to `/app`).

Put the API key and the dashboard password in `~/server/.env` next to your
compose file:

```
GOOGLE_API_KEY=<the key>
SEO_DASHBOARD_PASSWORD=<a long random password>
```

**`SEO_DASHBOARD_PASSWORD` puts the whole dashboard behind HTTP Basic auth**
(user `acko`, or `SEO_DASHBOARD_USER`). It can add and remove sites and trigger
runs, and port 8091 is published on every interface, so without it anyone on
the LAN can use it. The compose service refuses to start without the variable,
but as with every variable here, it only reaches the container if the live
compose file references it. Verify after a deploy:

```bash
docker logs seo-cockpit-dashboard 2>&1 | grep '\[auth\]'   # "Basic auth enabled for user ..."
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8091/   # 401
```

The report PDF keeps working behind auth: the PDF route hands its headless
chromium a token derived from the password, accepted only for reading the
report page, so the password itself never appears on chromium's command line.

> **The key's API allowlist must include BOTH the PageSpeed Insights API and
> the Chrome UX Report API.** This bit us once already: `fetch_cwv` calls CrUX
> first, and a CrUX 403 *raises* rather than degrading to "no data", so a key
> missing CrUX produces **zero** CWV snapshots while everything else looks
> fine. Verify before deploying:
>
> ```bash
> curl -s "https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=$GOOGLE_API_KEY" \
>   -H 'Content-Type: application/json' -d '{"origin":"https://web.dev"}' | head -20
> ```
>
> A 403 with `API_KEY_SERVICE_BLOCKED` means CrUX is not enabled on the key.

Neither Dockerfile `COPY`s secrets, and `.dockerignore` excludes
`collector/secrets/` and `collector/data/` from the build context entirely, so
they cannot end up in an image layer.

---

## 3. Why the database stays in `journal_mode=delete`

Deferred from Task 11d and decided here, because it is inseparable from the
mount strategy.

The dashboard mounts `collector/data` **read-only**. That is a real safety
property: the dashboard container physically cannot corrupt the collector's
database, regardless of any bug in the app.

WAL would forfeit it. **Opening a SQLite database read-only still requires
creating the `-shm` sidecar file, so a WAL database on a read-only mount fails
outright.** Verified rather than assumed:

```
WAL   + read-only directory -> SQLITE_READONLY_DIRECTORY: attempt to write a readonly database
delete + read-only directory -> OK
```

That holds even after the WAL has been fully checkpointed away and only the
`.db` file remains — it is the *open*, not pending WAL content, that needs to
write.

The usual argument for WAL is that a writer blocks readers under `delete`. Two
measured facts make that a non-problem here:

1. **The collector's transactions are short.** Each upsert does one
   `executemany` followed by its own `commit` (`collector/seocockpit/db.py`) —
   a few hundred rows per table per site. No transaction spans the run.
2. **The reader already waits.** `better-sqlite3` applies a default
   `busy_timeout` of **5000 ms**, confirmed on the live connection. A page load
   during a commit waits milliseconds; it does not error.

**Decision: keep `journal_mode=delete`, keep the dashboard mount read-only.**

Revisit only if the collector ever grows a long-running transaction, or if a
second writer appears. If you do switch to WAL, the dashboard's mount must
become read-write at the same time — the two changes are one change.

---

## 4. Deploy

### Layout

```
~/server/seo-cockpit/
  src/       git checkout — code only, and the docker build context
  data/      seo.db. PERSISTENT, deliberately OUTSIDE the checkout
  secrets/   service-account.json, chmod 600. Same reasoning.
  config/    user-sites.json (dashboard-added sites). PERSISTENT. See 1c.
```

`data/`, `secrets/` and `config/` sit beside the checkout rather than inside it
so a re-clone or a hard reset cannot destroy collected history or added sites.
The repo gitignores `collector/data` anyway, so the database was never
version-controlled.

```bash
cd ~/server/seo-cockpit
git clone https://github.com/AleksandarRadivojevic1/seo-cockpit.git src
mkdir -p config              # dashboard writes user-sites.json here (see 1c)
# thereafter:  git -C ~/server/seo-cockpit/src pull --ff-only
```

### Fold in the services

Append the two services from `src/deploy/compose.snippet.yml` to
`~/server/docker-compose.yml` under its existing `services:` key (which already
holds `homeassistant`, `mosquitto`, `influxdb`, `grafana`, `nodered`, `ntfy`,
`changedetection`, `homepage`, `wireguard`, `matter-server`).

**Back up and validate — this file runs the whole house:**

```bash
cd ~/server
cp docker-compose.yml docker-compose.yml.bak-$(date +%F-%H%M%S)
sed -n '/^  seo-cockpit-collector:/,$p' seo-cockpit/src/deploy/compose.snippet.yml \
  >> docker-compose.yml
docker compose config >/dev/null && echo OK || echo "INVALID — restore the backup"
```

Confirm the append changed nothing existing:

```bash
diff docker-compose.yml.bak-* docker-compose.yml | grep '^<' || echo "additions only"
```

### Container user

Both services run as `${SEO_COCKPIT_UID:-1000}:${SEO_COCKPIT_GID:-1000}`,
overriding the uids baked into the images. `data/` and `secrets/` are owned by
the login account (uid 1000 on this Pi), and the collector must be able to
write `seo.db`. Chowning `data/` to the image's 10001 would work too, but would
leave the database owned by a uid with no host account — needing `sudo` to back
up or inspect. Set `SEO_COCKPIT_UID`/`GID` in `~/server/.env` if your account
is not 1000 (`id -u`).

**Port 8091 was verified free on 2026-07-26.** For reference, what is already
published: 80 (homepage), 1883 (mosquitto), 1880 (nodered), 3000 (grafana),
5000 (changedetection), 8086 (influxdb), 8090 (ntfy), 51820/udp (wireguard).
Note 3000 is taken by Grafana — that is fine, the dashboard only uses 3000
*inside* its container and publishes on 8091.

Re-check before bringing it up, in case the stack has changed:

```bash
ss -ltnp | grep 8091 || echo "8091 free"
```

If it is taken, change the host side of the port mapping (and the Homepage tile
in step 6).

```bash
docker compose build seo-cockpit-collector seo-cockpit-dashboard
docker compose up -d seo-cockpit-collector seo-cockpit-dashboard
docker compose ps
docker builder prune -f
```

A Pi 5 handles the Next build natively; no emulation or swap tuning is needed.

---

## 5. First backfill (Task 15)

The scheduler only runs incrementals. Seed history with a **one-shot** container
rather than changing the long-running service:

```bash
docker compose run --rm seo-cockpit-collector \
  python -m seocockpit.schedule run --backfill
```

Then verify real rows landed. **`sqlite3` is not installed on this Pi**, and it
does not need to be — the collector image already carries Python, whose
`sqlite3` module reads the file directly:

```bash
cd ~/server
docker compose run --rm seo-cockpit-collector python - <<'PY'
import sqlite3
db = sqlite3.connect("file:/app/data/seo.db?mode=ro", uri=True)
for row in db.execute(
    "SELECT site, COUNT(*), MIN(date), MAX(date) FROM totals_daily GROUP BY site"
):
    print("totals ", row)
for row in db.execute(
    "SELECT site, status, rows_written, error FROM collection_runs"
    " ORDER BY started_at DESC LIMIT 5"
):
    print("run    ", row)
for row in db.execute(
    "SELECT COUNT(*), COUNT(lh_performance) FROM cwv_snapshots"
):
    print("cwv rows / with lighthouse:", row)
for row in db.execute("SELECT COUNT(*), COUNT(DISTINCT country) FROM country_daily"):
    print("country rows / countries:", row)
PY
```

Expect `status=success` for all three sites, a non-zero Lighthouse count, and
non-zero country rows. (Install `sqlite3` with `sudo apt install sqlite3` if you
would rather query it directly — nothing here depends on it.)

> A run can legitimately report `success` while recording a `cwv:` error
> separately — Task 11d isolates CWV failures so a flaky PageSpeed call never
> costs you Search Console data. A `cwv: HTTP Error 403` alongside a successful
> run means the API key, not the collection, needs attention.

> GSC has a ~3-day finalisation lag (`LAG_DAYS = 3`), so the newest date will
> trail today by several days. That is correct, not a failure — the dashboard's
> freshness badge accounts for it.

Then load `http://piserver.local:8091` (or `http://192.168.1.156:8091`) and
confirm all three sites render.

---

## 6. Homepage tile

Homepage's config lives at `~/server/homepage`. Add to its `services.yaml`:

```yaml
- SEO Cockpit:
    href: http://192.168.1.156:8091
    description: GSC + Core Web Vitals cockpit
    icon: mdi-chart-line
```

Use the IP rather than `piserver.local` — the tile is rendered in *your*
browser, and mDNS resolution is less reliable across clients than the LAN
address.

---

## 7. Troubleshooting

**Dashboard exits immediately.** `SEO_DB_PATH` is unset or the file is missing.
`lib/db.ts` opens with `fileMustExist: true` and throws a clear message. The
database only exists after the collector's first run — run the backfill first.

**Health panel says "Not running" while the cards look fresh.** That is the
panel working. It is schedule-aware: it checks whether a run *happened* in the
expected slot, not how old the data is. `COLLECTOR_SCHEDULE_HOUR` and
`COLLECTOR_GRACE_HOURS` in compose must match the collector's real schedule
(03:00 UTC, 2h grace) or it will misreport.

**"Sačuvaj kao PDF" fails, or downloads nothing.** Check the dashboard logs for
`[report-pdf] render failed`. Two known causes, both silent in different ways:

- *No chromium.* `resolveChromium()` throws naming `CHROMIUM_PATH`. The image
  installs it at `/usr/bin/chromium` and sets that variable; an image built
  before 2026-07-27 predates it and needs a rebuild.
- *Unwritable `HOME`.* The compose `user:` override runs the container as a
  bare host uid with no `/etc/passwd` entry, so `HOME` is `/`. Chromium's
  crashpad handler cannot create its database there and takes the browser down
  with it — while **still exiting 0 and writing no PDF**, which is why the code
  checks for the file rather than trusting the exit code. `lib/report/pdf.ts`
  points `HOME` at a scratch directory to prevent this; if it recurs, that is
  where to look, not at the compose file.

**"Run collection now" says requested, but nothing runs.** If a run finished
in the last 10 minutes, that is the cooldown (see 1c). The collector logs
`manual collection trigger ... ignored`.

**Collector dependencies are pinned.** The image installs
`collector/requirements.lock`, not `requirements.txt`, so a rebuild gets the
same versions every time; the lock was first generated from what the deployed
image was running on 2026-10-09. To change a dependency, edit
`requirements.txt` and regenerate the lock with the command in its header.
`pytest` lives in `requirements-dev.txt` and stays out of the image.

**Everything is UTC on purpose.** The APScheduler trigger is pinned to UTC; both
services set `TZ=UTC`. Before that pin, the trigger silently used the host's
Europe/Belgrade and fired at 01:00 UTC.

**Permission denied writing `seo.db`.** The compose `user:` override is not
taking effect, or your account is not uid 1000. Check with `id -u` and set
`SEO_COCKPIT_UID`/`SEO_COCKPIT_GID` in `~/server/.env` to match. Verify what the
container actually runs as:

```bash
docker compose run --rm seo-cockpit-collector id
```

**Radar/country panels empty.** `lh_*` and `country_daily` are populated only by
runs made after Task 11d. Re-run the backfill.

**Every route 500s with `ERROR 318203710` / `ERR_DLOPEN_FAILED`.** Full message
in `docker logs seo-cockpit-dashboard`:

```
/lib/aarch64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found
(required by /app/node_modules/better-sqlite3/prebuilds/linux-arm64.node)
```

better-sqlite3's arm64 **prebuild** is linked against GLIBC 2.38 while
`node:24-slim` (bookworm) provides 2.36, so the module installs cleanly and
then fails to load at request time. The Dockerfile sets
`npm_config_build_from_source=true` to compile it against the glibc actually
present. If this reappears, that env var has been lost or the base image
changed.

**This class of bug cannot be caught on an x86 build host** — there the
matching prebuild loads fine and every local test passes. Anything touching a
native module has to be exercised on the Pi.

---

## 8. Access from outside the LAN

**Use the existing WireGuard, not a port forward.** The dashboard's only
protection is one shared HTTP Basic auth login over plain HTTP, which is fine
on the LAN and inside the tunnel but not on the open internet, where it would
put every client's commercial data one guessed or sniffed password away.

WireGuard is already running on this Pi with a handful of peers, and
`ALLOWEDIPS` is unset — so the linuxserver default `0.0.0.0/0, ::/0` applies
and LAN routes through the tunnel. Confirmed working
2026-07-26: with `wg0` up, `http://192.168.1.156:8091` loads from off-LAN
exactly as it does at home.

```bash
sudo wg-quick up wg0     # then browse to http://192.168.1.156:8091
sudo wg show             # "allowed ips: 0.0.0.0/0, ::/0" is what makes it work
```

If a client ever needs their own link — as opposed to you presenting it — do
**not** port-forward. That needs auth in front of the app (Cloudflare Tunnel +
Cloudflare Access is the natural fit) and per-site scoping first, so client A
cannot see client B's data.
