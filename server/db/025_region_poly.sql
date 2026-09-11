-- A REGION YOU DRAW, AND A RADIUS THAT CAN HOLD A PLACE.
--
-- A named area could be a circle or a box and nothing else. Neither is a pier
-- that bends, an L-shaped plaza or a waterfront: marking the hub's dock as a box
-- takes in half the water, and marking it as a circle takes in the volcano. So
-- an author walks the edge of the thing and the points land here.
--
-- At least three points, checked in the browser, checked again in
-- syncEventsToAnchors because putDoc is reachable by a hand-written POST. Two
-- points are a line, a line has no inside, and a region built from one is a
-- place no player is ever in with nothing anywhere saying why.
--
-- POLY AND RECT ARE EXCLUSIVE IN THIS TABLE. Both exporters write the poly's
-- bounding box into the bundle's `rect` beside the points, because
-- the reading side tests a region by its rect and has no
-- polygon test at all. Storing that derived box here as well would give a
-- reopened map two shapes and no way to tell which one the author drew.
alter table anchors add column if not exists poly jsonb;

comment on column anchors.poly is
  'region only: [[x,y],...] in painting pixels, at least three, closed by the reader. Exclusive with rect: the bundle carries this and its bounding box together because the game has no polygon test yet.';

-- AND THE RADIUS CEILING WAS NEVER HERE, which is the point of saying so.
--
-- r was clamped 4 to 64 in one line of the editor and nowhere else: this column
-- is a plain integer with no check, neither exporter clamps, and the game reads
-- Math.max(1, Math.round(r)) with no upper bound. 64 on a 688px map is under two
-- percent of it, so the one shape an author could reach for could not hold a
-- plaza, a pier or a platform. The tool allows 512 now, which covers any
-- painting PixelLab's measured area budget can produce.
comment on column anchors.r is
  'the activation radius in painting pixels. No constraint on purpose: the consumer clamps only at 1 and the tool decides the ceiling, currently 512.';
