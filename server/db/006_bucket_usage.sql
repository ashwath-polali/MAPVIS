-- What the bucket has actually been asked to do this month.
--
-- The per-process ceiling in blobs.mjs stops a runaway loop, which is the only
-- realistic way to spend real money here. It cannot stop the slower thing: a
-- serverless host runs many short-lived processes, so thirty people working all
-- month is thirty thousand processes that each stay far under a per-process
-- limit and still add up.
--
-- R2 bills on overage with no spend cap you can set in the dashboard, so the
-- cap has to live here. One row per month, incremented once per request rather
-- than once per operation, because a write per bucket read would double the
-- cost of the thing it is measuring.
--
-- It is also the answer to "how close am I", which until now had no answer at
-- all short of reading Cloudflare's own dashboard.
create table if not exists bucket_usage (
  month      text primary key,           -- 'YYYY-MM', UTC
  class_a    bigint not null default 0,  -- writes and listings, $4.50/million
  class_b    bigint not null default 0,  -- reads, $0.36/million
  updated_at timestamptz not null default now()
);
