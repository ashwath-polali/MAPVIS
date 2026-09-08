# MAPVIS

A web tool for turning a painted image into a 2D game map.

You start from one picture. You draw the walkable ground onto it by hand at native resolution, mark
elevation and the things a character should walk behind, place props and give them movement, then
walk the map yourself to check it holds up. Pressing export writes a versioned bundle a game engine
reads over HTTP.

Maps are drawn on a picture rather than assembled from tiles, so a map looks like whatever it was
painted as. Nothing is snapped to a grid. Elevation and collision are stored per pixel.

Built for the Algorithmic Thinking Club at Bonney Lake High School.

## Run it

Node 22 or newer, which is what CI runs.

```
npm install
npm run dev
```

Open <http://localhost:5274>. That is all it needs: with no configuration the tool runs off this
machine, keeping the mask in the browser and writing bundles to `work/<id>/`.

One command and one port. The API runs inside the Vite dev server, so do not start a second API
process. `npm run api` exists for running the API alone on 5275 and is not part of the normal loop.

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
`DATABASE_URL` blank as well and the whole platform half switches off: the editor still works and
still exports, and the parts that need a server say so instead of failing.

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
can be proposed, but the correction is the deliverable, and it is worth the hour it takes.

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

## Layout

- `src/core/` the editor: masks, elevation, movement, export
- `src/ui/` and `src/site/` the editor surface and the pages around it
- `server/` the API, storage adapters and the database schema
- `server/db/` migrations and the verification scripts
- `work/` bundles this machine has written

Documents go to Postgres, images to any S3-compatible bucket. There is no host-specific storage
anywhere: moving off Vercel is a config file, not a rewrite.

## Checks

```
npm run typecheck   # tsc, no emit
npm run verify      # the whole suite, against a real database and bucket
```

`npm run verify` is not a unit-test runner. It boots the API in-process and exercises the real
thing: a document round trip that must be lossless, the read API including everything it has to
refuse, sign-in and its backoff, the routing, every authored field reaching the bundle, and a gate
that proves a published map loads with this machine's disk switched off. It needs `.env` filled in
and it writes to the database it is pointed at.

## Two dependencies

React and `pg`, plus the AWS S3 client. No router, no state library, no UI kit, no test framework.
Seven routes do not justify twenty kilobytes.
