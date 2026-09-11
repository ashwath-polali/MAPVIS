-- Routes, shots, and the water between the islands.
--
-- Three things a map cannot say about itself, each needing a type, a column and
-- a control rather than just one of the three.
--
--   paths     a named polyline: a route walked or sailed, marked once.
--   framings  a named shot: where the camera sits and how close.
--   world     the one ocean every crossing happens on. It has no map of its
--             own, because a MAPVIS document cannot exist without a painting
--             and the water is the one surface with no painting under it.
--
-- paths and framings are jsonb on the map for the same reason `assets` is:
-- genuinely nested, small, always read with the map, so one row stays one
-- query. Both default to empty, which is what every existing map already ships.

alter table maps add column if not exists paths    jsonb not null default '[]'::jsonb;
alter table maps add column if not exists framings jsonb not null default '[]'::jsonb;

-- THE WORLD IS ONE ROW, because there is one ocean.
--
-- Not one per account: a berth is a position relative to every other island,
-- so two accounts holding two compositions would be two worlds that cannot
-- both be sailed. The check constraint says so in a way a second insert cannot
-- argue with.
--
-- w/h is the ocean's own extent, which is not any painting's extent. A place's
-- x,y is its position on that water and its w,h is the footprint it occupies
-- there, so an island can be placed before it has ever been painted.
create table if not exists world (
  id         integer primary key default 1 check (id = 1),
  w          integer not null default 4096,
  h          integer not null default 4096,
  -- each entry: name, map, title, x, y, w, h, state, release, berth, approach.
  -- `map` empty is a SLOT THAT IS EMPTY ON PURPOSE: a reserved position holding
  -- no map yet, carrying a state, reading as a rumour, with the rise happening
  -- where the rumour was.
  places     jsonb not null default '[]'::jsonb,
  -- named sea regions that partition the water: mist, sailable, shallow,
  -- forbidden, ambience. What makes "anywhere you have not been" an answerable
  -- question rather than a coordinate test.
  regions    jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

insert into world (id) values (1) on conflict (id) do nothing;
