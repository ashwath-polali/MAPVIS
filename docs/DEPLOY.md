# Putting MAPVIS somewhere that is not a laptop

Everything here is free. The one paid thing anybody will ever need is a domain, and only when a
nice address matters more than a `vercel.app` one.

---

## What runs where

| | | |
|---|---|---|
| the app and the api | Vercel Hobby, region `pdx1` | free |
| documents, accounts, anchors, jobs | Neon Postgres, `us-west-2` | free, 0.5 GB |
| every png | Backblaze B2, `mapvis-atc` | free, 10 GB, no card |
| claude and SAM | a machine you link | free, it is the cli you already pay for |

**Portland and Oregon on purpose.** Vercel's default function region is Washington DC, and Neon lives
in `us-west-2`. Left alone, every single query would cross the country and come back. `vercel.json`
pins `pdx1`, which is the same metro as the database.

---

## The whole api is one function

`api/index.mjs` is nine lines. `server/api.mjs` is a plain node `(req, res)` handler and stays that
way, so there is nothing to split into thirty serverless functions and nothing vercel-shaped to
unpick later. That is the portability rule in `PLATFORM.md` paying off: **no Vercel KV, no Vercel
Postgres, no Vercel Blob, ever.** Moving host is a config file.

---

## Deploying

1. **Import the repo** at vercel.com. It reads `vercel.json` and needs no answers.
2. **Set the environment variables**, all eight, exactly as they are in `.env`:

   ```
   DATABASE_URL  DATABASE_POOLED_URL
   S3_ENDPOINT  S3_REGION  S3_BUCKET  S3_ACCESS_KEY_ID  S3_SECRET_ACCESS_KEY
   KEY_VAULT_SECRET
   ```

   **`MAPVIS_SOLO` and `MAPVIS_LOCAL_RELAY` must NOT be set.** Solo mode treats an unauthenticated
   request as one named account, which is exactly right on one laptop and a wide open door on a
   host. They live in `.env`, which is gitignored and never uploaded, so the default is safe. Setting
   them by hand is the only way to get this wrong.

3. **Deploy**, then hit `/api/me`. `{"user":null}` means the database answered.

Neon's compute suspends after 5 minutes idle, so the first request after a quiet spell takes about a
second while it wakes. It wakes itself; nothing has to be pressed.

---

## Linking your machine

The club account holds no keys. It reaches claude through a machine you link, which is how ATC gets
claude without anybody buying a subscription.

1. In account settings, make a relay token. It is shown once.
2. On the laptop, in `.env`:

   ```
   MAPVIS_URL=https://<your-deployment>
   MAPVIS_RELAY_TOKEN=<the token>
   ```

3. `npm run relay`

It polls for questions, runs the local `claude` cli, and posts answers back. It never sees a map or a
key. Close the laptop and the platform notices within 90 seconds and degrades: the router features
send the author's own words straight to pixellab, and the purely-claude features say they need a key.
Nothing hangs waiting for a machine that went to sleep.

**After graduation**, set the account's claude provider to `key`, paste one, and the machine link is
severed for that service. A dropdown, not a migration.

---

## Things that will not work on a host, and what happens instead

**The `claude` cli.** A server cannot shell out to a per-user cli. That is what the whole provider
split exists for, and it is the harder half of why hosting was never just a deploy.

**SAM propose.** It needs a local python and a 375 MB checkpoint. It rides the same relay, and
without one you draw the mask by hand, which `MAPS.md` measures as better anyway: 0.69 px mean
boundary error by hand against 4.18 px derived.

**Writing to `work/`.** A serverless filesystem is read-only except `/tmp`, so scratch points there
automatically. Nothing is expected to survive a request, because the store is what survives.

That last one has a consequence worth knowing: the suffix walk that finds a free library name used to
ask the folder, and on a host the folder is empty every time. It asks the database as well now, or
every generation would pick the base name and overwrite whatever already held it.

---

## The keepalive

`.github/workflows/keepalive.yml` runs `doctor` against both stores every three days from GitHub's
runners. It is monitoring that happens to keep things warm, so a failure emails rather than being
discovered in November.

It also handles the trap in its own design: GitHub disables a scheduled workflow after 60 days of no
commits, which would switch off the thing keeping the databases awake. The job appends a dated line
to `.github/heartbeat.txt` once a month and pushes, so it keeps itself alive.

---

## Costs, honestly

Free, with two edges worth knowing before they arrive rather than after.

**Vercel Hobby forbids commercial use.** School and free use is fine. The day MAPVIS is sold it is
$20/mo or a different host, and because of the portability rule that is a billing toggle.

**B2's egress is free up to three times what you store.** At a couple of GB stored that is several
GB a month of downloads, which is plenty until the game is serving bundles to whole classes. When it
is, published bundles go behind a CDN, and they already ship `Cache-Control: immutable` for exactly
that day.
