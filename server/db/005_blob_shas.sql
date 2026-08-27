-- Answer "has this file changed" without paying the bucket to find out.
--
-- serveFromStore downloaded the whole object and THEN computed its ETag from
-- the bytes it had just fetched, so a 304 cost exactly as much as a 200. On a
-- laptop that is invisible because the disk answers first. On the deployed
-- editor it meant reopening a map spent one bucket read per file to be told
-- nothing had changed: 156 reads, every time, forever.
--
-- The sha is recorded when the bytes are written, so the tag is known before
-- any read happens and a revalidation is one indexed primary-key lookup in
-- Postgres against a table that is already awake.
--
-- Keyed by the bucket key rather than by library item on purpose. A direction
-- set is 64 files under one item, states are more, and the scene and the mask
-- planes are not library items at all. One row per object is the only shape
-- that covers all of them without a per-kind special case.
create table if not exists blob_shas (
  key        text primary key,
  sha        text not null,
  bytes      integer not null,
  updated_at timestamptz not null default now()
);

-- delPrefix invalidates a whole subtree, which is a prefix scan. The primary
-- key index serves that already on most planners, but saying so explicitly
-- keeps it true if the key type ever changes.
create index if not exists blob_shas_key_prefix on blob_shas (key text_pattern_ops);
