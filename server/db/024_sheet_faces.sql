-- A SHEET IS CUT BY THE SAME SCAN, ASKED THE OPPOSITE QUESTION.
--
-- One scan is the alpha flood fill that finds the hero piece in a family and
-- refuses rather than guessing. This is the second, and it exists because
-- /v2/create-ui-asset is a panel kit generator and nothing else: asked for an
-- icon set of a compass, a key, a star, a lock and a tick it returns panels, and
-- asked for round blank chip tokens it returns panels. So the six sheet types go
-- to /v2/generate-image-v2 instead, which paints an arbitrary subject with
-- transparency and has no element list to force furniture out of.
--
-- What comes back from that route is one canvas of separate small marks, and the
-- scan reads it for EVERY shape above a minimum rather than for the largest one.
-- The rectangles land in `regions` as kind `face`, which 018 already carries and
-- which is what a consumer cuts the sheet apart by, so there is no new column
-- for them and no second truth about the same rectangles.
--
-- No schema change here, only the sentence the column claims about itself. The
-- refusals now come from either scan and an author reads them in the same place.
comment on column ui_assets.crop_note is
  'why a scan refused, in the sentence the author reads. Two scans use it: the hero crop on a ground piece, and the face cut on a sheet. Either one refuses rather than guessing, because a silently wrong rectangle is wrong everywhere the piece is mounted with nothing saying so.';
