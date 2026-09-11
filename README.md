# MAPVIS

**Turn a painted picture into a walkable 2D game map.**

You start from one image. You draw the walkable ground onto it by hand at native resolution, mark
elevation and the things a character should walk behind, place props and give them movement, then
walk the map yourself to check it holds up. Pressing export writes a versioned bundle a game engine
reads over HTTP.

Maps are drawn on a picture rather than assembled from tiles, so a map looks like whatever it was
painted as. Nothing snaps to a grid. Elevation and collision are stored per pixel.

<p align="center">
  <img src="site-art/2-harbour.png" width="700" alt="A harbour town seen from above, with a lighthouse, a stone breakwater and fishing boats at the quay.">
  <br><em>One image. The quay is walkable, the water is not, and the sea wall is something to walk behind.</em>
</p>

<p align="center">
  <img src="site-art/3-terraces.png" width="700" alt="Terraced fields climbing a mountainside to a temple, with stairs between each level.">
  <br><em>Elevation is a value under every pixel, so the stairs connect four levels and the retaining walls do not.</em>
</p>

<p align="center">
  <img src="site-art/4-market.png" width="700" alt="A market square at dusk, crowded with stalls, barrels, a cart and people.">
  <br><em>Anything that moves comes out as its own asset and is given a behaviour, not a baked animation.</em>
</p>

## Run it

Node 22 or newer, which is what CI runs.

```
git clone https://github.com/ashwath-polali/MAPVIS.git
cd MAPVIS
npm install
npm run dev
```

Open <http://localhost:5274> and drop a png on it.

That is the whole of it. With no configuration MAPVIS runs off this machine: the mask lives in the
browser, bundles are written to `work/<id>/`, and everything that needs a server says so instead of
failing. One command and one port, because the API runs inside the Vite dev server. `npm run api`
exists for running the API alone on 5275 and is not part of the normal loop.

### With a database and a bucket

Accounts, a dashboard of your maps, publishing and hosted bundles need Postgres and any
S3-compatible bucket. Copy `.env.example` to `.env` and fill in what you have, then:

```
npm run migrate     # create the tables
npm run doctor      # says whether postgres, the bucket and the vault key all answer
```

Every value is read from the environment. A real environment variable always beats a line in `.env`,
so a host overrides the file and a test can turn a local convenience off. Nothing secret is ever
committed, ever reaches the browser bundle, or has a default in the code.

Leave the `S3_*` lines blank and images fall back to `work/.blobs` on this machine. Leave
`DATABASE_URL` blank as well and the platform half switches off: the editor still works and still
exports, and the read API answers with a sentence saying nothing is published here yet.

## Author a map

The editor is at `/edit`, and `/edit?id=<slug>` reopens one. It runs left to right in six steps.

1. **load** drop a png. That picture is the map, at its own resolution. Nothing resamples it.
2. **cut** paint out what is not the place: the sea around an island, the black around a room. Cut
   pixels become transparent in the exported scene, and the engine draws its own ocean under them.
3. **levels** paint the walkable ground and its elevation. A level is a value under every pixel, not
   a tile: ground at 40, 60, 80, 100 and the ramps between them at 50, 70, 90. Zero is not walkable.
   Occluders are the shapes a character walks behind, and each carries the y its cover starts at.
4. **test** walk it. The same step law the game runs, with the same body: feet plus two hip probes, a
   level tolerance and an axis slide. If a route is wrong it is wrong here, before anything ships.
5. **assets** place things on the painting and give them movement. Movement is data (wander, cross,
   orbit, drift) rather than baked frames, so the preview and the game agree by construction.
   Anchors go on in this step too: the named points, doors, posts, regions and spawns a game binds to.
6. **export** name the map, say whether it is an island or a room, and write the bundle.

Two things are worth knowing before the first map.

**A name is an address.** Anchors, placements, paths and shots are named by hand in a shape Python
can hold (`lower_snake_case`), and those names are the contract a game is written against. Renaming
one later moves everything pointing at it and says how many moved.

**Elevation and collision are per pixel and hand-drawn.** That is the point of the tool. A first pass
can be proposed, but the correction is the deliverable, and it is worth the hour it takes: a
hand-drawn mask measures 0.69 px mean boundary error against 4.18 px for a derived one.

## Publish

Export writes the bundle to `work/<id>/`. With a database configured, it also publishes: version N is
written once and never rewritten, so a game can pin the version it was tested against and
re-exporting cannot break a session already running.

Frames are packed into one atlas per map, which is the difference between a map costing six requests
to open and several hundred.

## Read a map from a game

```
GET /api/v1/maps                 every published map, with its newest version
GET /api/v1/maps/:slug           the newest published version
GET /api/v1/maps/:slug?v=3       a pinned version
GET /api/v1/maps/:slug/anchors   the names a game can bind to
```

The response gives the bundle's file URLs, the collision and elevation planes, the placements, and
the named anchors. `map.json` carries the map's class (`island`, `room` or `hall`), the six numbers
describing the body it was drawn for, the painting's own extent inside its canvas, and who published
it when.

The read API is open and account-free, because a game fetches it with no session.

## Deploy your own

The whole API is one serverless function: `api/index.mjs` is nine lines around a plain node
`(req, res)` handler. There is no host-specific storage anywhere, so moving host is a config file
rather than a rewrite.

1. Import the repo at your host. `vercel.json` needs no answers.
2. Set the environment variables listed in `.env.example`. The eight that matter are
   `DATABASE_URL`, `DATABASE_POOLED_URL`, the five `S3_*` values and `KEY_VAULT_SECRET`.
3. Deploy, then open `/api/me`. `{"user":null}` means the database answered.

**Do not set `MAPVIS_SOLO` on a host.** It is an authentication bypass for one person on one laptop.
It refuses on a serverless runtime, refuses when `NODE_ENV` is production, and refuses any request
that did not come from the loopback address, but the right value for it on a server is still blank.
If a proxy in front of you sets `x-forwarded-for`, set `TRUST_PROXY=1` so the rate limiter keys on
the real address instead of ignoring a header anybody can write.

## Layout

- `src/core/` the editor: masks, elevation, movement, export
- `src/ui/` and `src/site/` the editor surface and the pages around it
- `server/` the API, storage adapters and the database schema
- `server/db/` migrations and the checks
- `work/` maps you author. Gitignored, and yours: back it up somewhere private.

## Contribute

Issues and pull requests are welcome. Before opening one:

```
npm run typecheck     # tsc, no emit
npm run verify:local  # the checks that need nothing configured
npm run build
```

Those three are exactly what CI runs on every push, and they need no database, no bucket and no keys.
`verify:local` boots the API in-process against a temporary directory and proves what has to be true
on a fresh clone: a document round trip that is lossless, the read API refusing rather than crashing
with no platform behind it, the limiter in front of sign-in, and the solo-mode bypass being off in
every shape but a local one.

`npm run verify` is the other half and is not part of CI, because it needs a live Postgres and a live
bucket and it writes to them: the read API including everything it has to refuse, sign-in and its
backoff, the routing, every authored field reaching the bundle, and a gate that proves a published
map loads with this machine's disk switched off.

Two runtime dependencies, React and `pg`, plus the AWS S3 client. No router, no state library, no UI
kit, no test framework. Seven routes do not justify twenty kilobytes.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Read it, learn from it, fork it, build on it: any
noncommercial purpose is permitted, and use by a school, a university or any other educational
institution is permitted explicitly. Commercial use is not. Keep the notice.

The artwork is not covered by that license. Every image under `public/` and `site-art/` is pixel art
generated with [PixelLab](https://pixellab.ai) and is subject to PixelLab's terms. And anything you
draw in MAPVIS is yours: none of it is in this repository.
