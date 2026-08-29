-- The arrival card, which had a data slot at neither end.
--
-- A door swap shows a cover, the map's name and one fact. The name and the
-- fact arrived with 008 as `title` and `meta`. The picture had nowhere to go at
-- all: no field in bundle(), no column, nothing emitted by publishBundle, and
-- map_blobs.role is a check constraint listing five roles that does not include
-- one, so a cover blob could not even be STORED without this migration.
--
-- The rule the walkthrough sets is that a cover is keyed by the place being
-- arrived at rather than by the door used to get there, so it belongs to the
-- map and not to the anchor. A member's island arriving with a default cover is
-- the failure this exists to stop.
alter table map_blobs drop constraint if exists map_blobs_role_check;
alter table map_blobs add constraint map_blobs_role_check
  check (role in ('planes','scene','levels','occluders','cut','cover'));

-- the one fact the card prints beside the name. Not `meta`, because meta is the
-- author's own bag and a reader should not have to guess which key is the fact.
alter table maps add column if not exists cover_fact text not null default '';
