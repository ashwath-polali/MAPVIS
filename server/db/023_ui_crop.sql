-- PIXELLAB ANSWERS A GROUND PIECE WITH A FAMILY, AND A FAMILY CANNOT BE SLICED.
--
-- What comes back from /v2/create-ui-asset is one png holding the hero piece at
-- the top and a tray of matching buttons, chips and rules underneath it. The
-- slice record 018 added is `{slice, scale, fill, repeat}` and the four numbers
-- in `slice` are insets measured from the edges of the WHOLE image, with no
-- source rect anywhere in the shape: CSS border-image-slice has none and Pixi
-- NineSliceSprite has none. So on a family image those four numbers point at
-- the tray rather than at the frame, and the piece cannot be sliced at all.
-- Measured on the two real families on disk: dialogue_box_v4 is 688x384 and its
-- hero is 518x182 at 85,17, panel is 448x448 and its hero is 403x150 at 22,22.
-- In both cases more than half the canvas is tray.
--
-- The hero is therefore cut out at import, by an alpha scan and arithmetic, and
-- the columns here are what makes that reversible. server/store/ui.mjs carries
-- the scan and the three refusals.

-- the family exactly as the generator drew it. The piece's own blob_key holds
-- the cropped hero, so this is the second copy and it exists so a bad crop can
-- be undone and so the tray of matching buttons is not thrown away: the tray is
-- the rest of the kit and re-drawing it is another spend.
alter table ui_assets add column if not exists full_key text not null default '';

-- {x, y, w, h}: where the hero sat inside the family. Empty means the piece
-- image IS the family, which is the honest state for a sheet, for a cover
-- plate, for anything uploaded whole, and for a crop that was refused.
alter table ui_assets add column if not exists crop jsonb not null default '{}'::jsonb;

-- WHY A CROP WAS REFUSED, IN THE SENTENCE THE AUTHOR READS.
--
-- The scan refuses instead of trying harder. One that cannot prove which region
-- is the hero keeps the whole image and says so here, and the card asks for a
-- hand crop. A silently wrong crop is the one outcome that must not happen: the
-- four numbers measured against it would then be wrong everywhere the piece is
-- mounted, with nothing anywhere saying a word.
alter table ui_assets add column if not exists crop_note text not null default '';

-- THE SHA OF THE BYTES THIS ROW POINTS AT, SO A STALE CACHE CANNOT WIN.
--
-- server/store/blobs.mjs memoises reads and evicts a key when a write passes
-- through the SAME process. Nothing tells it about a write from another one, so
-- a CLI script that writes 67035 bytes for `panel` leaves a running dev server
-- serving the 56644 it cached until it restarts, while the row and the bucket
-- are both correct. An author redrawing a piece then sees the stale picture
-- with nothing saying why.
--
-- Recorded here rather than only in blob_shas because both image routes already
-- read this row to find blob_key, so the check costs no extra query: hash what
-- the cache handed over, compare, and on a mismatch drop the key and read
-- again. It is also what versions the url the emitted CSS mounts, so a changed
-- picture is a changed url on the published route, which is served immutable.
alter table ui_assets add column if not exists img_sha text not null default '';

comment on column ui_assets.full_key is
  'the family as the generator drew it: hero on top, tray of matching buttons below. blob_key holds the hero cut out of it.';
comment on column ui_assets.crop is
  '{x,y,w,h} of the hero inside full_key. Empty means the piece image is the whole picture, which is right for a sheet and for a refused crop alike; crop_note says which.';
comment on column ui_assets.img_sha is
  'sha1 of the bytes at blob_key, written at the moment they are. A read whose bytes hash differently is being served by a stale process-local cache and re-reads.';
