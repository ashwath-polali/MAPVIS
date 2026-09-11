-- Storage for the fields an author types.
--
-- Each column below backs a control in the editor and a field in the export. A
-- type in the editor and a reader in the game are not enough on their own: with
-- no column the value has nowhere to live between the two.

-- ----------------------------------------------------------------- anchors --

-- WHERE A BODY ENDS UP WHEN IT USES THIS PLACE, in painting pixels, and it is a
-- different pixel from x,y. x,y is the middle of the thing, which for a chart
-- table is the tabletop, and standing on the tabletop is not what anybody meant.
-- The game's walk_to and its arrival through a door both aim here when it is
-- set, and at x,y when it is not, which is what every anchor did before.
alter table anchors add column if not exists stand jsonb;

-- rect's four numbers are [x0, y0, x1, y1], TWO OPPOSITE CORNERS, and not
-- [x, y, w, h]. The game's box test destructures corners, so corners is what
-- crosses the wire. Recorded on the column as well, because a comment that
-- says the other shape is how the two ends drift apart.
comment on column anchors.rect is 'region only: [x0,y0,x1,y1], two opposite corners, matching the game''s box test';

-- ------------------------------------------------------------------- maps --

-- THE SIX NUMBERS THAT DESCRIBE THE BODY A MAP IS DRAWN FOR, and the most
-- widely read shape in the schema. bundle() writes all six into map.json, the
-- game consumes all six, MAPVIS's own walk law reads them and check-anchors
-- reads two back out. They belong to the map because a 688 px island seen from
-- above and a room at character scale are not walked by the same body: one
-- default for both means every map describes an 18 px character walking at
-- 34 px/s on ground squashed 0.72.
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

-- WHAT THIS MAP IS ABOUT: the subject it teaches. Without it, the join between a
-- published map and the thing behind it lives in a hardcoded set inside the game
-- that reads it, so shipping one more map is a source edit and a deploy.
alter table maps add column if not exists island_id text not null default '';

-- The author's own key/values for the whole map. Without a map-level bag the
-- only place to hang map-scoped data is a meta on some arbitrarily chosen
-- anchor, which is a convention nothing enforces.
alter table maps add column if not exists meta jsonb not null default '{}'::jsonb;

-- title is already a column, written as the slug at creation and read by the
-- dashboard. It reaches a bundle through publish.mjs; nothing about the column
-- itself needs to change.

-- THE OCCLUDER BASELINES, the one hand-set number in the depth system. The
-- polygons live in the planes png as ids in the green channel; the baseline,
-- the row a character has to be north of before the painting is drawn over him,
-- is a number per id and has no other home. It must be serialized: rebuilding
-- one from the bottom edge of its polygon throws the typed value away on the
-- next open, silently, in front of the person who typed it.
alter table maps add column if not exists occs jsonb not null default '[]'::jsonb;
