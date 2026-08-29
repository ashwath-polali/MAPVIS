-- The fields an author could not enter.
--
-- Every column below already had a type in the editor, a place in the export or
-- a reader in the game, and no way for a person to put a value in it. Nine of
-- them are the half-plumbed sweep in docs/AUTHORING.md; the rest are what those
-- nine needed underneath them.

-- ----------------------------------------------------------------- anchors --

-- WHERE A BODY ENDS UP WHEN IT USES THIS PLACE, in painting pixels, and it is a
-- different pixel from x,y. x,y is the middle of the thing, which for a chart
-- table is the tabletop, and standing on the tabletop is not what anybody meant.
-- The game's walk_to and its arrival through a door both aim here when it is
-- set, and at x,y when it is not, which is what every anchor did before.
alter table anchors add column if not exists stand jsonb;

-- rect's four numbers are [x0, y0, x1, y1], TWO OPPOSITE CORNERS. The original
-- comment on this column said [x,y,w,h] while the game's own box test at
-- src/game/pmap/anchors.ts destructured corners, and nothing was authoritative
-- because no rect had ever been authored. The game is the side with running
-- code, so the game wins. Recorded here because the column comment was the
-- other half of the disagreement.
comment on column anchors.rect is 'region only: [x0,y0,x1,y1], two opposite corners, matching the game''s box test';

-- ------------------------------------------------------------------- maps --

-- THE SIX NUMBERS THAT DESCRIBE THE BODY A MAP IS DRAWN FOR. The most demanded
-- shape in the authoring sweep, thirteen of fourteen passes. bundle() writes all
-- six into map.json, the game consumes all six, MAPVIS's own walk law reads them
-- and check-anchors reads two back out, and there was no control and no column,
-- so they could not even be set out of band. Every map MAPVIS ever produced
-- shipped an 18 px character walking at 34 px/s on ground squashed 0.72, whether
-- it was a 688 px island seen from above or a room at character scale.
--
-- The defaults are exactly walk.ts defaultCfg(), so every existing map keeps the
-- contract it already shipped with and nothing changes under a published bundle.
alter table maps add column if not exists char_h    integer not null default 18;
alter table maps add column if not exists char_hip  integer not null default 2;
alter table maps add column if not exists char_hipdy integer not null default 1;
alter table maps add column if not exists speed     real    not null default 34;
alter table maps add column if not exists yscale    real    not null default 0.72;
alter table maps add column if not exists step_tol  integer not null default 10;

-- WHAT KIND OF PLACE THIS IS. The engine guesses from the border on every map
-- because MAPVIS knows the answer and never said it. 'hall' is the third value:
-- a shared space that is neither a club's island nor a room, and it is the
-- template for anything a member builds that other people also use.
alter table maps add column if not exists class text not null default 'island'
  check (class in ('island', 'room', 'hall'));

-- WHAT THIS MAP IS ABOUT: the school offering it teaches. The join between a
-- published map and the thing behind it currently lives in a hardcoded Set in
-- the game repo, so shipping a member's island is a source edit and a deploy.
alter table maps add column if not exists island_id text not null default '';

-- The author's own key/values for the whole map. There was no map-level bag at
-- all: not in the type, not here, not in the export, not in the game's reader,
-- so the only place to hang map-scoped data was a meta on some arbitrarily
-- chosen anchor, which is a convention nothing enforces.
alter table maps add column if not exists meta jsonb not null default '{}'::jsonb;

-- title is already a column. It is written as the slug at creation, read by the
-- dashboard, and never reaches a bundle, which is the fifth direction of the
-- half-plumbed bug shape. The reading end is fixed in publish.mjs; nothing about
-- the column itself needs to change.

-- THE OCCLUDER BASELINES, which are the one hand-set number in the depth system
-- and the only part of a map that was destroyed rather than merely missing. The
-- polygons themselves live in the planes png as ids in the green channel; the
-- baseline, the row a character has to be north of before the painting is drawn
-- over him, is a number per id and lived nowhere. MaskDoc.serialize() omitted it
-- and unpack() rebuilt every one from the bottom edge of the polygon, so the
-- typed value was gone on the next open. The author watched the field take it.
alter table maps add column if not exists occs jsonb not null default '[]'::jsonb;
