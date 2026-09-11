-- The picture on the arrival card.
--
-- A door swap shows a cover, the map's name and one fact. The name and the fact
-- are `title` and `meta`. The picture needs a role in map_blobs as well as a
-- field in the bundle, because the role column is a check constraint and a
-- cover blob cannot be STORED under a role the constraint does not list.
--
-- A cover is keyed by the place being arrived at rather than by the door used
-- to get there, so it belongs to the map and not to the anchor. Otherwise every
-- island reached through an unfinished door arrives with a default cover.
alter table map_blobs drop constraint if exists map_blobs_role_check;
alter table map_blobs add constraint map_blobs_role_check
  check (role in ('planes','scene','levels','occluders','cut','cover'));

-- the one fact the card prints beside the name. Not `meta`, because meta is the
-- author's own bag and a reader should not have to guess which key is the fact.
alter table maps add column if not exists cover_fact text not null default '';
