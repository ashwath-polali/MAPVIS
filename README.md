# MAPVIS

**A local web tool a person drives to make 2D painted game maps.**

You describe a map, the tool generates candidates with PixelLab, you draw what is walkable straight
onto the picture at native resolution, you walk it to prove it, put life on it, and it writes a
bundle the game loads.

Run it: `npm run dev`, then **http://localhost:5274**. One command, one port — the API is a
middleware inside the Vite dev server, so there is no separate API process to start. Open a specific
scene with `?img=/hub-final.png&id=hub`; the `id` decides which library and which saved mask you
get, and without it the scene id comes from the dropped filename.

Your cut, levels and placements are saved in **that browser** under `mapvis:<id>`, not on the
server. A different browser is a different set of work. Fixing that is the first item in the
platform plan.

MAPVIS used to be a 3D map generator that ran unattended. That is over. It ran for three weeks
across roughly twenty documented methods and produced zero maps anyone accepted. All of it is in
`archive/`, including the measurements and the verdict history, which are worth keeping and are not
worth restarting from. `archive/docs/README-3d-era.md` is the front door to that period.

The bigger change is that a person now drives the whole thing, on purpose.

## The asset stage

The right-hand column is where a map gets its life: generate a thing, fill an area with a set of
them, make an effect, and give any placement a way of MOVING. The full account of it — including why
movement is data rather than animation frames, the 35% walkability law, and the difference between a
PixelLab object and a PixelLab character — is in the game repo at
`AdventureGame/docs/MAPVIS-ASSETS.md`. Read that before changing anything in `src/core/life.ts`,
which is copied verbatim into the game and must stay identical on both sides.

---

## ONE SCREEN

There are no stages, no wizard, no inspector. The painting fills the window. Everything else is an
edge.

- **The prompt line, top.** Type a description, press enter. It submits four PixelLab jobs and lays
  the results out as a filmstrip. Click one and it becomes the map.
- **The tools, left edge.** brush, polygon, rect, bucket, eraser, eyedropper, occluder. Under them,
  the eight level values you paint with: blocked, ground, three stair bands, three plateaus. Keys
  `b p r f e i o` and `0` to `7`.
- **The cut tools, below a divider.** A painting arrives with a painted sea slab, baked plumes,
  diorama rock sides. The cut is human work: cut brush, cut erase, cut fill (a contiguous colour
  flood from the clicked pixel, Manhattan RGB tolerance 0-120), cut polygon. Keys `c x v n`. They
  edit a separate binary cut mask, never the levels and never the art; cut pixels show as a magenta
  hatch, and `t` (or the `cut view` button) previews the painting with the cut applied over a
  checkerboard. The cut only lands at export: cut pixels leave `scene.png` at alpha 0 and export as
  blocked in `levels.png`. `save cut png` writes just the cut-applied painting as
  `work/<id>/scene-cut.png`, so a painting can be cut and staged before any mechanics exist.
- **The sparkle.** One local pass with Segment Anything that guesses the walkable ground so there is
  something to correct instead of nothing to start from. It is rough. Correcting it is the point.
- **Space.** The walk test, anywhere, with no mode to leave first. Feet plus two hip probes, the
  level tolerance, axis slide, all of it the same law as `PaintedScene.tsx` in the game. Refused
  moves paint red into the hits layer, so you can see where you are blocked.
- **The bottom bar.** Cursor, level, zoom, how much of the map is walkable, and four buttons:
  heal seams, check reach, set spawn, export.

Zoom is 1x to 8x on the wheel, nearest neighbour, never a blurred pixel. Pan is the middle button or
alt and drag.

### heal seams, check reach

Two polygons drawn as separate outlines do not tile exactly. Where their vertex chains disagree by a
fraction of a pixel, a one pixel row of blocked survives between them, invisible below 6x, and it
hard blocks the character because his hip probes sit 2px out from his feet. **heal seams** closes any
blocked pixel pinched between two walkable pixels a legal step apart, and leaves real walls alone.
**check reach** walk floods from the spawn using the same legality test the character uses, then
paints every region the player can never get to. Both were bought with real hours. They stay.

---

## THE BUNDLE

`export` writes `work/<id>/`:

```
scene.png       the painting, cut pixels at alpha 0
levels.png      the level value per pixel, greyscale, blocked under the cut
occluders.png   the occluder id per pixel, red channel
cut.png         the cut mask, white where cut, only written when a cut exists
map.json        encoding, spawn, character metrics, stair regions, occluder baselines
```

Level encoding, the same as `src/game/painted/PaintedScene.tsx` in the game repo: `0` blocked, `40`
L0, `50` ramp 0-1, `60` L1, `70` ramp 1-2, `80` L2, `90` ramp 2-3, `100` L3. A step is legal when the
difference is 10 or less, so two plateaus only connect through the stair painted between them.

Reopening a map with the same id picks the mask back up, from the browser first and from
`work/<id>/` after that. There is no save button.

---

## RUNNING IT

```
npm install
npm run dev          # http://localhost:5273
```

Open a painting you already have with `?img=/work/quay/scene.png&id=quay`, or drop a png on the
window, or type a prompt.

```
npm run build        # typecheck, then production build
npm run typecheck
npm run api          # the api alone, only needed if you serve dist/ elsewhere
```

The api lives in `server/` and is mounted inside the dev server, so it is one command on one port and
the PixelLab token is only ever read in node. The token comes from `PIXELLAB_TOKEN` or from the MCP
entry in `~/.claude.json`, the same way `archive/gate-island/scripts/pxl.py` reads it.

The sparkle needs a python with torch and segment-anything. It defaults to the ComfyUI embedded
python and the vit_b checkpoint already on this machine; override with `MAPVIS_PYTHON` and
`MAPVIS_SAM_CKPT`. Without them, every other part of the tool still works.

Vite, React 19, TypeScript, deliberately the same stack and tsconfig as
`C:\Users\ashcy\AdventureGame`, so a component can move between the two repos without a rewrite.

---

## LAYOUT

```
index.html
vite.config.ts        mounts the api into the dev server
server/
  api.mjs             generate, job, propose, scene, export, and /work static
  pixellab.mjs        the token and the v2 endpoints
  propose_sam.py      the rough walkable guess
src/
  main.tsx
  App.tsx             the one screen
  app.css
  api.ts              calls to the local api
  core/
    mask.ts           the document: pixels, polygons, seam heal, export
    walk.ts           the step law and the reach check
    editor.ts         canvas, view, input, the frame loop
  ui/icons.tsx
work/                 maps on disk, gitignored
archive/              the 3D era. See archive/docs/.
```

`window.mapvis` is the live editor, the way `tools/maskdraw` exposed `window.__md`. Every command the
buttons run is on it.

---

## WHAT IS NOT IN IT

- **Sprites.** No populate step. A painting on its own does not move, and that still needs solving,
  but it is a second tool and it was not going to fit on one screen.
- **A prompt critic.** The prompt goes to PixelLab as typed.
- **Multiple occluder baselines at once.** The number field edits the one you drew last.

## STANDING RULES

- No PixelLab generation without Ash's word for that specific spend. Whole-scene calls have billed
  25 to 40 generations each, not 1.
- Never claim success he has not personally judged. Describe state, show the frame, let him verdict.
- Never present a mid-process artifact as a result.
- Check `archive/docs/` and the verdict record before proposing anything that sounds familiar. Every
  route in the elimination table in `archive/docs/README-3d-era.md` has a dated death.
