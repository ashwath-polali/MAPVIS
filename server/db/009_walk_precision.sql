-- speed and yscale have to survive a round trip EXACTLY, or the autosave never
-- stops writing.
--
-- 008 made them `real`, which is float4 and cannot hold 0.72: it comes back as
-- 0.7200000286102295. putDoc hashes the whole row's contents and skips the
-- write when the hash matches, and that skip is not an optimisation, it is what
-- keeps a four-second autosave from writing 1.6 GB an hour into a 0.5 GB tier.
-- A value that changes shape between the write and the read makes every save
-- look like a change, so the skip never fires again.
--
-- Caught by verify-map.mjs's "an unchanged save wrote nothing" check, which is
-- the one test in that file its own header calls the one that matters.
alter table maps alter column speed  type double precision;
alter table maps alter column yscale type double precision;
