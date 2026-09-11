-- The UI library: a piece has a TYPE, and a ground piece has four numbers.
--
-- 012 gave a surface a picture and a list of named rectangles, which was the
-- right half to build first and is not enough to be consumed. docs/UI-KIT.md
-- read the game's own record and found the missing halves.
--
-- WHAT A TYPE BUYS. Twenty-one kinds of drawn surface, derived from the record
-- rather than invented, and the reason to have them at all is that twenty
-- islands built by twenty people end up speaking one dialect rather than
-- twenty. A type carries its legal canvas, its region vocabulary and its
-- generation preset, so an author picks a type and describes the piece instead
-- of rediscovering what a dialogue box is made of by dragging six unlabelled
-- rectangles. The table of types lives in server/store/ui.mjs as data and NOT
-- as a check constraint here: it carries presets, element lists and region
-- vocabularies that no column could hold, and two copies of a list that long
-- drift the first time one is edited. This column only says the name is
-- identifier-shaped; the refusal of a type nobody named is in the store.
--
-- WHAT slices IS FOR. `center / 100% 100% no-repeat` squashes one whole
-- painting into whatever box the element happens to be, and leaves the inside
-- of the painting as a percentage somebody measures in an image editor and
-- types into a stylesheet, a repo away from the picture. The four numbers here
-- are source-pixel insets that CSS border-image and Pixi NineSliceSprite both
-- take, measured once against the picture and stored beside it.
--
-- WHY THE COLUMN IS RENAMED. `slot` already means something else on the reading
-- side: a world slot is an island's berth on the sea, named about thirty times
-- over as slotOfMap, seaSlots, residentSlots and berth. One word for two things
-- costs whoever greps for it. The word on the wire is `region`, so the column
-- is too.
alter table ui_assets rename column slots to regions;

-- which of the twenty-one this piece is. Blank is legal and means unclassified:
-- a row drawn before the vocabulary existed should not claim a type nobody
-- chose for it.
alter table ui_assets add column if not exists type text not null default ''
  check (type = '' or type ~ '^[a-z][a-z0-9_]{0,31}$');

-- { slice: {top,right,bottom,left}, scale, fill, repeat: {x,y} }, all in SOURCE
-- pixels. Empty means unmeasured, which is a legal state for a piece still
-- being drawn and a refusal at publish for a ground piece. `src`, `w` and `h`
-- complete the record on the way out and are not stored twice.
alter table ui_assets add column if not exists slices jsonb not null default '{}'::jsonb;

-- CORE CHROME IS NEVER OVERRIDABLE. One kit for the whole game, and a
-- contributor's piece may only ADD to it. A row with this set refuses
-- any write that does not also claim to be core, so a member cannot quietly
-- replace the dialogue box every island speaks through. The name list that is
-- reserved before any row exists lives beside the types in the store, because
-- the fence has to stand when the shelf is still empty.
alter table ui_assets add column if not exists core boolean not null default false;

-- The author saying a piece is finished, which is a different fact from the
-- picture having arrived. `status` says the generator answered; this says the
-- measurement was made and checked. A ground piece with no slices cannot get
-- here, because four numbers are the whole of what the game can consume.
alter table ui_assets add column if not exists published    boolean     not null default false;
alter table ui_assets add column if not exists published_at timestamptz;

-- the read api serves by name with no account in the path, and core has to win
-- that tie rather than whichever row happens to be older
create index if not exists ui_assets_name_core on ui_assets (name, core desc, created_at);

comment on column ui_assets.regions is
  'named rectangles on the picture. Six kinds: text, number, picture, fill, face, press. A face is a cut on a sheet, which is how a family of marks under the generator''s 192px floor gets addressed after being drawn in one job.';
comment on column ui_assets.slices is
  'the nine-slice record in SOURCE pixels, the one shape CSS border-image and Pixi NineSliceSprite agree on. slice.top + slice.bottom must be under h or CSS silently drops the border image with no error.';
