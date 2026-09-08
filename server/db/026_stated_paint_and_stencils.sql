-- TWO THINGS AN AUTHOR CAN NOW SAY THAT THE ROW HAD NOWHERE TO PUT.
--
-- paint_set: the four paint_* numbers were STATED by a person, not scanned off
-- the bytes at publish. 020 added those columns as a measurement and publish
-- overwrites them on every version, so without this flag an author's correction
-- would be wiped by the next export. Measured is still the default and is right
-- nearly always; this is for a painting whose edge is a faint alpha halo the
-- scan reads as picture, which makes the footprint too big and the centre wrong.
--
-- stencils: the outlines somebody drew. Three tools take polygon points, all
-- three rasterize into a plane and clear the list, and nothing ever stored it,
-- so the same outline was traced by hand for the level, again for the cut and
-- again for the occluder. The planes are still the only truth about the map. A
-- stencil is a stencil: it lays the same points down again with whatever tool is
-- live, and deleting one changes no pixel.
alter table maps add column if not exists paint_set boolean not null default false;
alter table maps add column if not exists stencils  jsonb   not null default '[]'::jsonb;

comment on column maps.paint_set is
  'true when paint_w/h/ox/oy were typed by the author. publish leaves them alone when it is set.';
comment on column maps.stencils is
  'outlines the author drew, newest first, [{id, pts:[[x,y],...]}]. Not a shape the map has, a shape to re-lay.';
