# MAPVIS as a platform

The build document for turning MAPVIS from a tool that runs on one laptop into something anyone can
sign into. Started 2026-08-26. The *why* lives in `AdventureGame/docs/MAPVIS-PLATFORM.md`; this file
is the *how*, and it is where decisions get recorded as they are made.

Read `AdventureGame/docs/VINE-AND-GRAPE.md` before touching anchors. Section 2.5 of the plan document
is a contract handed here by the game side, not a suggestion.

---

## The stack, and why every piece of it is free

| | free tier, verified 2026-08-26 | what lives there | headroom |
|---|---|---|---|
| Neon Postgres | 0.5 GB/project, 100 CU-hr/mo, 5 GB egress, autosuspend at 5 min | map documents, anchors, accounts, jobs, ledger | ~1,500 maps |
| Backblaze B2 | 10 GB permanent, **no credit card**, egress free to 3x stored | every PNG, published bundles | ~1,600 maps with libraries |
| Vercel Hobby | 300 s function max, 100 GB transfer, 1M invocations | the app and the API | past any school scale |

Neon's half-gigabyte is enough because the big things are not in it. See the storage split below.

**B2 rather than Cloudflare R2, and the reason is the signup, not the product.** R2 is the better
object store on paper: its egress is unconditionally free where B2's is free up to three times what
you store. But enabling R2 forces a credit card on file even for the free tier, despite Cloudflare's
own product page saying otherwise, and a card was a line Ash drew. B2's 10 GB is permanent and needs
no card.

This costs nothing to get wrong. `server/store/blobs.mjs` speaks the **S3 API and nothing else**, which
B2, R2, S3 and MinIO all implement, so the provider is four lines in `.env`. That is deliberate: the
one thing that must never happen is coming back to rewrite storage because a free tier changed.

**Two standing rules that keep this free and keep it portable.**

1. **No Vercel-only primitive.** No Vercel KV, no Vercel Postgres, no Vercel Blob. Plain Node handlers
   against Neon and R2. The host then becomes a deploy config rather than a rewrite, which matters
   because Vercel Hobby forbids commercial use and MAPVIS may one day be sold. That day it is $20/mo
   or a different host, and either is a Tuesday afternoon.
2. **Published bundles are immutable and cached.** A full hub load is around 200 files. R2's 10M
   monthly reads would notice that; Cloudflare's CDN in front of an immutable version-scoped path does
   not, because the second fetch never reaches R2.

---

## The storage split

Three stores, and naming the split is the point. This is `MAPVIS-PLATFORM.md` §2.6 resolved.

**Documents go to Neon.** Map metadata, the placements, the anchors, accounts, jobs, the usage ledger.
`server/db/schema.sql` is the whole of it.

**Bytes go to R2.** Every PNG.

```
maps/<mapId>/planes.png                              lvl, occ and cut as r, g, b
maps/<mapId>/{scene,levels,occluders,cut}.png
maps/<mapId>/library/<name>.png                      a still
maps/<mapId>/library/<name>/<i>.png                  frames
maps/<mapId>/states/<item>/<face>/<heading>/<i>.png
publish/<slug>/v<N>/...                              immutable, cdn-cached
```

**Study logs stay on the Neon the game already uses.** Different project, different concern, not this
repo's problem. Listed so nobody merges it in.

### Why not Mongo

The only argument for it was that a map document is deeply nested. Once the mask planes move out to
R2, the nested part is the placements array and JSONB holds that fine. Everything that actually needs
querying is relational: a user owning maps, an anchor unique within a map, a publish version, a key
vault, a spend ledger. Mongo makes those worse. A second database vendor is a second connection, a
second backup story and a second thing to keep alive, for no gain. Decided 2026-08-26.

### The planes, measured, and the real reason they move

`mask.ts` `serialize()` packs three byte planes into one base64 field. Measured on the hub with
`server/db/measure-planes.mjs`, which round-trips the result before believing it:

```
map hub  688x640  440,320 px
  doc.json today             1850.1 KB   (gz      17.2 KB)
    of which base64 m        1720.0 KB
    of which everything       130.1 KB   (gz       8.2 KB)
  planes.png                    9.5 KB
  ratio                   13.3x smaller
  round-trip mismatches   0  (lossless)
```

1,720 KB of base64 becomes a 9.5 KB PNG, lossless. But note the `gz` column: gzipped, the whole
document is already 17.2 KB, so **on the wire this saves almost nothing**, and Postgres would TOAST the
base64 down to something similar. Size was never the real argument and any plan resting on it was
resting on nothing.

**The real argument is write amplification.** `editor.ts:3707` autosaves every 4 seconds while the map
is dirty, and `saveLocal()` ships the entire serialized document every time. That is up to 900 saves
an hour, each one rewriting a 1.85 MB row. Against Neon's 0.5 GB free tier, where storage includes
recent history, an hour of editing writes 1.6 GB. The free tier would not survive one session.

So Phase 1 is not a storage swap. It needs **dirty-part saves**: planes go to R2 only when the cut or
the levels changed, the placements jsonb is written only when a placement changed, and an unchanged
part is not written at all. Retrofitting that later means retrofitting it into every call site that
mutates the document, so it belongs here.

### The library stopped being a directory walk

`libraryItems()` inferred each item's shape by probing the filesystem: is there a `dirs.json`, then is
there a `0.png`, then is there an `effect.json`, and `pngSize()` opened a file descriptor per item to
read 24 bytes of IHDR. On the hub that is 71 probes per listing, which against object storage would be
71 network round trips. `library_items` writes the shape down instead, and the listing is one select.

### Four hidden directories that do not migrate

`.ask/`, `.style/` and `.propose/` exist only because the `claude` CLI needs a **file path** to hand
its `Read` tool. When a planner takes an image in a request body, all three are dead code. `.stage/`
is a local atomic-swap trick that object storage makes redundant, since a PUT is already atomic and
the swap becomes a transaction on the library row.

`.prev/` is the exception and it is a real feature, not scratch: an in-place edit rewrites the item and
`z` puts the pixels back. It becomes `library_versions`, capped at 8 the way `PREV_MAX` capped it.

---

## The anchor contract

The seam between MAPVIS, the game and the Python API, and the one thing here that cannot be
improvised, because getting it wrong means migrating every map that already exists.

`MapEvent` already exists at `src/core/mask.ts:133` and the game already honours it at
`PmapScene.tsx:392`. Three things are missing and each has a specific cost.

**`label` is doing two jobs.** It is the only string on an event today, so it is both what the player
reads on the door prompt and the only thing code could address. Renaming a door for the player would
silently break a member's Python. `name` and `label` are separate columns.

**There is no `to_anchor`.** A door reloads the target map and drops the player at that map's single
global `spawn`. The Panther's Maw is three rooms with two-way doors, so Hall→Chart and Alcove→Chart
would land on the same tile. That is a bug already waiting in content nobody has built yet, and it is
one column to prevent versus a migration to fix.

**Nothing binds an anchor to a placement.** If `coach_post` is where an NPC stands and the author drags
the NPC, the anchor should follow. `placement_id` does that, and it is what "a name survives editing"
has to mean in practice.

**A slug is globally unique.** Not per owner. This is forced rather than chosen: a door writes
`to: "panther-maw"` as a bare string with no owner in it, so two people cannot both own `hub`.

Export writes **both** `anchors[]` and the existing `events[]` derived from the doors, so no bundle
that works today stops working and the game migrates on its own clock.

---

## The key model

Each account carries two provider settings, each one of `key`, `relay` or `none`.

The club account ships `relay/relay`: no keys stored, wired to a linked machine that runs the `claude`
CLI and SAM locally. Its settings page says "wired to a linked machine" rather than showing an error.
Switching either provider to `key` and pasting one severs the machine link for that service. That is
the graduation path and it is a dropdown, not a migration.

Everyone else is `key` or `none`, and `none` degrades rather than breaking:

| feature | no PixelLab | no Claude |
|---|---|---|
| cut, levels, walk test, placing, export, publish | works | works |
| `translate` (your words into a prompt) | dead | **falls through: raw text goes straight to PixelLab** |
| `asset-plan` (endpoint, size, camera, prompt) | dead | falls through to defaults plus raw text |
| `style-card` (reads the painting) | works | denied, or fill the card by hand |
| `effect-plan`, `fx-review`, `obj-review` | dead | denied, you choose yourself |
| every `asset-gen`, `character-gen`, `anim`, `state` | **dead** | works |
| SAM propose | n/a | relay only, else draw it by hand |

The fall-through path does not exist today. Every generation goes ask → Claude → prompt → PixelLab with
no bypass, so this is new code at four call sites rather than a config flag.

Keys are `aes-256-gcm` ciphertext in `users.claude_key_enc` / `pixellab_key_enc`, never selected into a
response, never sent to a browser.

---

## Jobs, and why they come before hosting

Four endpoints block the request while they wait: `translate`, `style-card`, `asset-plan`,
`effect-plan`. `api.mjs:5648` spawns the `claude` CLI and holds the socket for up to five minutes.
That is fragile on any host at any price. A dropped connection loses work that already cost money, and
there is no progress, no resume and no clean stop.

MAPVIS **already** uses the right pattern for PixelLab generation: POST creates a job, returns an id,
the client polls. The planners never got it. Finishing that pattern is what the `jobs` table is for,
and it also replaces the `LIVE` and `WAITING` maps that sit in module scope at `api.mjs:5546` and
break the moment there is more than one server process.

Once nothing needs a long-lived request, nothing needs a long-lived server, and free serverless stops
being a compromise. The "do it correctly" requirement and the "absolutely free" requirement turn out
to be the same requirement.

---

## Phases

- [x] **0. The remote.** `github.com/ashwath-polali/MAPVIS-next`, private. 42 commits, 2,293 files,
      including `work/hub/doc.json` and the export bundle that had never been committed.
- [x] **1. Storage.** **Gate passed 2026-08-26.** `node server/db/gate.mjs hub` turns the disk
      fallback off and the api still answers with the document, 94 placements, the door, the 71-item
      library, real png bytes and the painting, all out of Neon and B2. The hub is 1.17 MB in object
      storage, so 10 GB holds roughly 8,500 maps.

      Four commands exist now and are the ones to reach for: `doctor.mjs` says whether anything is
      unwired, `migrate.mjs` applies schema, `import-work.mjs <slug>` moves a folder in,
      `verify-map.mjs <slug>` proves a round trip is lossless, `gate.mjs <slug>` proves the map does
      not need this laptop.

      **Writes followed.** The listing comes from the database now, so anything generation wrote to
      disk and did not push would simply vanish from the library. Every library write ends at one of
      four functions, so those four push to the store before responding: `saveStatic`, `swapFolder`,
      and the two places `saveFrames` is finished off by `trimSet`. Deleting drops from both.
      `verify-map.mjs` walks that path with a real png and checks it lists, round-trips and deletes.

      Disk did not go away and should not: it is where the collision loops, the `.stage` swap and
      `.prev` still run, all of it already tested. It is scratch, and the store is truth by the time
      a request ends, which is also what lets a hosted server work with an ephemeral disk.

      Still on disk and still to move: the export writer, states, and `.prev`.

      **The browser was still winning, and that was the real bug.** `restoreLocal()` ran first and
      `restoreDoc()` was documented as "read when this browser has nothing", so a map in a database
      was never actually read from it and two browsers would diverge silently. The document now
      carries `savedAt` from the server's own clock, the browser records the same number beside its
      copy, and **the newer one wins**. Offline edits still win when they are genuinely newer, which
      is the case that made the old order look correct.
- [ ] **2. Anchors.** Editor naming UI, `to_anchor`, placement binding, the listing endpoint, export
      writing both shapes.
- [ ] **3. Accounts.** Auth, sessions, ownership, providers, key vault, ledger, a functional my-maps
      list that is not yet designed.
- [ ] **4. Jobs and degraded routing.** Every long call becomes a row. The four fall-through paths.
      The relay daemon.
- [ ] **5. Deploy.** Vercel plus Neon plus R2 on a domain.
- [ ] **6. UI.** Ash steers this one. Held to the MAPVIS UI law: not a default-looking React page.
- [x] **7a. Publish and the read API.** **Landed 2026-08-26, early, because export was already
      being moved off disk and the two are the same act.**

      Pressing export now also writes an immutable version to `publish/<slug>/v<N>/` and records it.
      Nothing ever rewrites a version, so re-exporting cannot break a class mid-session, a game build
      can pin a version it was tested against, and every byte ships `immutable` so a cdn serves the
      second fetch and the free read budget is never touched twice for the same file. `map.json`
      picks up `anchors[]` from the database on the way through and keeps `events[]` beside it.

      `/api/v1` is the only surface anything outside MAPVIS may call, versioned in the path from the
      first line, read-only, addressed by slug:

      | | |
      |---|---|
      | `GET /api/v1/maps` | the registry the game has never had. A door names a target by slug and nothing could answer whether it exists |
      | `GET /api/v1/maps/:slug/anchors` | names only, small enough to fetch on every keystroke. This is what gives python autocomplete and an author-time error instead of a silent no-op |
      | `GET /api/v1/maps/:slug` | the manifest: map.json plus every file with its size, hash and url |
      | `GET /api/v1/maps/:slug/versions` | every published version |
      | `GET /api/v1/maps/:slug/file/:v/*` | the bytes, cached forever, cors open |

      `verify-api.mjs` checks what works and what must be refused: climbing out of a version, a
      version that does not exist, an empty filename, a map nobody published, and any write at all.

      Still to come here: the game reading `/api/v1` instead of `public/maps-painted/`.

---

## Open

- Where a published bundle is served from once the game reads the platform: R2 behind a custom domain
  is the shape, the domain is not bought.
- What a shared club account does when it runs out mid-map. The ledger exists; the policy does not.
- How twenty maps version against an engine that keeps changing. The Python API faces the identical
  question and the answer should probably be the same one. Immutable publishes are half of it.
- Whether a map published into the game needs review before students see it.
