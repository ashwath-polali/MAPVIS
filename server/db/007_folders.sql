-- Folders and hand-set order on the dashboard.
--
-- Purely organisation. Nothing in here decides whether a map opens, who owns
-- it, what it contains or whether it publishes: a map with no folder row is a
-- map that shows up on the home page exactly as it always has. That is the
-- whole design constraint, because the dashboard is where somebody goes to
-- find work they have already done and it must never be the thing that hides
-- it. If every table below were empty the page would still be correct.
--
-- Why a join table and not a folder_id column on maps: a map belongs in more
-- than one place at once. The hub is both "the island" and "things I am
-- working on this week", and picking one of those means the other list is
-- wrong. That is also why the picker on a card is checkboxes rather than a
-- dropdown; the storage shape and the control agree.
--
-- Ordering is per user and per list. The order you drag maps into inside a
-- folder is not the order you want on the all-maps list, so the sort index
-- lives on the membership row and there is a second table for the ungrouped
-- list. Both are integers with gaps allowed; the client sends the whole
-- sequence after a drag rather than trying to compute one index, which is what
-- keeps two maps from ever holding the same rank.
--
-- Deleting a folder deletes rows in these two tables and nothing else. There is
-- no path from here to a map's row, its painting, its mask or its placements,
-- and the cascades all point the other way: dropping a map takes its
-- membership with it, never the reverse.

-- A named list, owned by one account. Nothing global: two people may both have
-- a folder called "islands" and they are different folders, which is the
-- opposite of the maps table where a slug is globally unique because a door
-- addresses it by bare string.
create table if not exists folders (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references users(id) on delete cascade,
  name        text not null default '',
  -- where this folder sits in the rail, set by dragging. Sparse on purpose.
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists folders_owner_sort on folders (owner_id, sort);

-- Which maps are in which folder, and in what order inside it. The primary key
-- is the pair, so adding a map twice is a no-op rather than a duplicate card.
create table if not exists folder_maps (
  folder_id   uuid not null references folders(id) on delete cascade,
  map_id      uuid not null references maps(id) on delete cascade,
  sort        integer not null default 0,
  added_at    timestamptz not null default now(),
  primary key (folder_id, map_id)
);
-- the picker on a card asks the other direction: which folders is this map in
create index if not exists folder_maps_map on folder_maps (map_id);

-- The order of the all-maps list, which has no folder to hang a sort index on.
-- Keyed by owner as well as map because the row is a preference of the person
-- looking, not a property of the map.
--
-- A map with no row here sorts to the top, ahead of everything hand-placed,
-- and the reason is that a map you have never dragged is a map you just made.
-- Sinking new work to the bottom of a list somebody sorted a month ago is how
-- a dashboard starts hiding things.
create table if not exists map_order (
  owner_id    uuid not null references users(id) on delete cascade,
  map_id      uuid not null references maps(id) on delete cascade,
  sort        integer not null default 0,
  primary key (owner_id, map_id)
);
