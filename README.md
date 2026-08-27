# MAPVIS

A web tool for turning a painted image into a 2D game map.

You start from one picture. You draw the walkable ground onto it by hand at native resolution, mark
elevation and the things a character should walk behind, place props and give them movement, then
walk the map yourself to check it holds up. Pressing export writes a versioned bundle that a game
engine reads over HTTP.

Maps are drawn on a picture rather than assembled from tiles, so a map looks like whatever it was
painted as. Nothing is snapped to a grid. Elevation and collision are stored per pixel.

## Running it

```
npm install
npm run dev
```

Then open http://localhost:5274. The API is Vite middleware, so there is no second process to start.

Set `DATABASE_URL` and the four S3 variables in `.env` to persist maps and their images. Without
them the tool falls back to local disk and still runs.

```
npm run migrate    apply the schema
npm run verify     check the database, storage, auth and the read API
```

## Layout

- `src/core/` the editor: masks, elevation, movement, export
- `src/ui/` and `src/site/` the editor surface and the pages around it
- `server/` the API, storage adapters and the database schema
- `server/db/` migrations and verification scripts

## Storage

Documents go to Postgres, images to any S3-compatible bucket. A published map is immutable: version
N is written once and never rewritten, so a game can pin the version it was tested against and
re-exporting cannot break a session in progress. Frames are packed into one atlas per map, which is
the difference between a map costing six requests to open and several hundred.

## Reading a map from a game

```
GET /api/v1/maps/:slug          the newest published version
GET /api/v1/maps/:slug?v=3      a pinned version
```

The response gives the bundle's file URLs, the collision and elevation planes, placements, and the
named anchors a game binds to.

Built for the Algorithmic Thinking Club at Bonney Lake High School.
