-- A world becomes a per-account document, and OUR world does not move.
--
-- 010 wrote `check (id = 1)` and an essay under it: a berth is a position
-- relative to every other island, so two compositions would be two worlds that
-- cannot both be sailed. That argument is right about ONE ocean and wrong about
-- one TABLE. It is the same conflation the maps table never made: everybody gets
-- maps, one account's maps are the game's, and the shared row was the reason
-- /api/world had to be walled off from every visitor with a 403 explaining that
-- the tool they just signed up for has a page they are not allowed to open.
--
-- So the check goes, an owner arrives, and a stranger gets an ocean of their own
-- to place their own islands on and their own engine to read it.
--
-- OUR WORLD IS ROW 1 AND STAYS ROW 1. Nothing about it changes: same integer id,
-- same version, same marks, same public read at /api/v1/world, byte for byte.
-- The pin is deliberately the id rather than a flag, because a flag can be set
-- on two rows and an id cannot, and the game's read has no account behind it and
-- therefore nothing to resolve a flag against.
--
-- WHY owner_id STAYS NULL ON IT HERE. Which account is ours is CONFIGURATION,
-- OCEAN_OWNER in .env falling back to BOOTSTRAP_EMAIL, and a migration cannot
-- read it. So row 1 is claimed by the first request from that account, and until
-- then it is the unowned world the game reads, which is exactly what it has
-- always been. On a laptop with no login screen there is no owner at all and
-- everything resolves to row 1, unchanged.
--
-- pub_id IS WHERE A STRANGER'S ENGINE READS. Their composition has to be
-- fetchable by something that is not MAPVIS and is not signed in, the same way
-- ours is, so it needs an address that is public, stable, and not an email. An
-- opaque uuid, at /api/v1/worlds/<pub_id>, which cannot collide with
-- /api/v1/world or /api/v1/world/marks because the word is plural.

alter table world drop constraint if exists world_id_check;

-- a second row needs a second id, and the column's default is the literal 1, so
-- a plain insert collides with the game's own world. Started past whatever is
-- already there rather than at 2, in case an install has more.
create sequence if not exists world_id_seq owned by world.id;
select setval('world_id_seq', greatest(1, coalesce((select max(id) from world), 1)));
alter table world alter column id set default nextval('world_id_seq');

alter table world add column if not exists owner_id uuid references users(id) on delete cascade;
alter table world add column if not exists pub_id   uuid not null default gen_random_uuid();

-- ONE OCEAN PER ACCOUNT, enforced rather than trusted: the resolve-or-create
-- path runs on every authoring request, so two tabs signing in at once is a real
-- race and the loser must lose loudly instead of writing a second world nobody
-- can find again. Partial, because row 1 is unowned until its account arrives.
create unique index if not exists world_owner_uniq on world (owner_id) where owner_id is not null;
create unique index if not exists world_pub_uniq   on world (pub_id);
