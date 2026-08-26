-- MAPVIS platform schema, postgres (neon).
--
-- The split this file assumes, and the reason it stays small: documents live
-- here, bytes live in object storage. A map's three mask planes used to be one
-- 1,056,768-character base64 string inside doc.json; they are an image and they
-- go to r2 as planes.png. What is left is metadata, the placements, and the
-- names the game addresses, and all of that is a few hundred kilobytes.
--
-- Two things in here are deliberately ahead of their UI. The anchors table
-- ships now because retrofitting author-typed names onto maps that already
-- exist means migrating every one of them. The jobs table ships now because
-- every long call has to become a row before anything can be hosted, and the
-- laptop relay claims its work out of it.

-- No extensions. gen_random_uuid() has been core postgres since 13 and the
-- api-key ciphertext is made in node with aes-256-gcm, not in the database.

-- ---------------------------------------------------------------- identity --

-- A user IS an account. There is no org model on purpose: the club's plan is
-- one shared login that Ash and every ATC member use, not a membership graph.
create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  password_hash  text not null,
  display_name   text not null default '',
  created_at     timestamptz not null default now(),

  -- How this account reaches each service. 'key' uses the stored ciphertext,
  -- 'relay' is wired to a linked machine and stores no key at all, 'none' is
  -- the degraded path. The club account ships relay/relay; switching either to
  -- 'key' and pasting one severs the machine link for that service, which is
  -- the whole graduation story and it is a dropdown.
  claude_provider    text not null default 'none' check (claude_provider   in ('key','relay','none')),
  pixellab_provider  text not null default 'none' check (pixellab_provider in ('key','relay','none')),

  -- aes-256-gcm ciphertext. Never selected into any response, never sent to a
  -- browser. Null whenever the matching provider is not 'key'.
  claude_key_enc     bytea,
  pixellab_key_enc   bytea
);

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  user_agent  text not null default '',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index on sessions (user_id);
create index on sessions (expires_at);

-- A machine that runs the claude cli and SAM on this account's behalf. It long
-- polls the jobs table, does the work locally, and posts the result back. When
-- no link has checked in recently, routing degrades instead of failing.
create table relay_links (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  name          text not null default '',
  token_hash    text not null unique,
  capabilities  text[] not null default '{}',   -- 'claude', 'sam', 'pixellab'
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index on relay_links (user_id);

-- -------------------------------------------------------------------- maps --

-- slug is globally unique, not unique per owner, and that is forced by the
-- door contract rather than chosen: an anchor writes to:'panther-maw' as a bare
-- string with no owner in it, so two people cannot both own 'hub'.
create table maps (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9._-]{0,59}$'),
  owner_id    uuid not null references users(id) on delete cascade,
  title       text not null default '',

  -- geometry. base_* is the painting inside a canvas that may have been grown,
  -- so a grown map re-grows on reload exactly as mask.ts serialize() v3 did.
  w           integer not null,
  h           integer not null,
  base_w      integer not null,
  base_h      integer not null,
  base_ox     integer not null default 0,
  base_oy     integer not null default 0,
  spawn_x     integer not null default 0,
  spawn_y     integer not null default 0,

  -- the placements. Genuinely nested (life, looks, dirs per heading) and the
  -- one part of a map that is really document-shaped, so it stays jsonb.
  assets      jsonb not null default '[]'::jsonb,
  asset_next  integer not null default 1,

  -- side documents that used to be their own files. All small and all read
  -- with the map, so one row is one query. asks is the prompt history that
  -- taught us what works, keeps is the last 20 kept, style is the cached read
  -- of the painting.
  asks        jsonb not null default '[]'::jsonb,
  keeps       jsonb not null default '[]'::jsonb,
  style       jsonb,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on maps (owner_id, updated_at desc);

-- Every binary that belongs to a map. role is what it is for; key is the
-- object-storage path. planes.png is the autosave carrying lvl/occ/cut in
-- r/g/b, and it replaces the base64 field that made doc.json 1.89 MB.
create table map_blobs (
  map_id      uuid not null references maps(id) on delete cascade,
  role        text not null check (role in ('planes','scene','levels','occluders','cut')),
  key         text not null,
  bytes       integer not null,
  sha256      text not null,
  updated_at  timestamptz not null default now(),
  primary key (map_id, role)
);

-- ----------------------------------------------------------------- anchors --

-- The seam between MAPVIS, the game and the python API. A member writes
-- guide_to("maw_entrance") and never an x and a y, so this is the only place
-- that name can be created. A row, not a blob inside the map, because the API
-- has to list a map's names without downloading the map.
--
-- name and label are different fields on purpose. label is what the player
-- reads on the door prompt; name is what python addresses. Making one string
-- do both means renaming a door for the player silently breaks a member's code.
create table anchors (
  id           uuid primary key default gen_random_uuid(),
  map_id       uuid not null references maps(id) on delete cascade,

  -- author-typed, unique in the map, shaped like a python identifier so a typo
  -- is caught when it is written instead of failing silently at runtime.
  name         text not null check (name ~ '^[a-z][a-z0-9_]{0,47}$'),
  kind         text not null check (kind in ('point','region','door','post','spawn','trigger')),

  x            integer not null,
  y            integer not null,
  r            integer not null default 14,
  rect         jsonb,          -- region only: [x,y,w,h]

  -- door only. to_anchor is the field the current events contract is missing,
  -- and without it three connected rooms all land the player on the target
  -- map's single global spawn no matter which door was used.
  to_slug      text,
  to_anchor    text,

  -- when set, this anchor is bound to a placement and follows it. Dragging the
  -- NPC moves coach_post with it, which is what "a name survives editing"
  -- actually has to mean.
  placement_id text,
  facing       text,           -- post only: one of the 8 headings

  label        text not null default '',
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),

  unique (map_id, name)
);
create index on anchors (map_id, kind);
create index on anchors (to_slug);

-- ----------------------------------------------------------------- library --

-- What used to be inferred by walking work/<id>/library/ and probing for
-- dirs.json, then 0.png, then effect.json, opening a file descriptor per item
-- to read 24 bytes of png header. On the hub that is 71 probes per listing.
-- Here it is one select, and the shape is written down instead of guessed.
create table library_items (
  id           uuid primary key default gen_random_uuid(),
  map_id       uuid not null references maps(id) on delete cascade,
  name         text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,47}$'),

  kind         text not null check (kind in ('static','animated')),
  is_effect    boolean not null default false,
  w            integer not null,
  h            integer not null,
  fps          integer,
  frame_count  integer not null default 0,

  -- one entry per heading when this thing faces where it walks. The router
  -- picks a rig by body plan, and anything without dirs mirrors instead.
  dirs         jsonb,
  -- the written recipe for an effect: type, params, palette, colors, code.
  effect       jsonb,
  -- which pixellab character or object drew this, which is what makes a state
  -- edit possible later. Was origin.json.
  origin       jsonb,

  blob_prefix  text not null,
  created_at   timestamptz not null default now(),

  unique (map_id, name)
);
create index on library_items (map_id);

-- The same thing wearing another face: a troll's boulder, a character's every
-- heading. A face belongs to the row that owns it, so there is never a
-- question of which boulder.
create table library_states (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references library_items(id) on delete cascade,
  face         text not null,
  dirs         jsonb,
  frame_count  integer not null default 0,
  blob_prefix  text not null,
  unique (item_id, face)
);

-- The .prev folder, which is a real feature and not scratch: an in-place edit
-- rewrites the item, and z puts the pixels back. Capped at 8 the same way
-- PREV_MAX capped it, oldest dropped first.
create table library_versions (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references library_items(id) on delete cascade,
  seq          integer not null,
  blob_prefix  text not null,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (item_id, seq)
);

-- -------------------------------------------------------------------- jobs --

-- Replaces the LIVE and WAITING maps that live in module scope in api.mjs and
-- break the moment there is more than one server process. Everything that takes
-- real time is a row: the client polls it, /api/stop flips it to 'stopped', and
-- the laptop relay claims 'queued' rows whose provider it can serve.
create table jobs (
  id           uuid primary key default gen_random_uuid(),
  map_id       uuid references maps(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,

  kind         text not null,   -- translate, style-card, asset-plan, effect-plan, asset-gen, propose, ...
  provider     text not null check (provider in ('claude','pixellab','sam')),
  status       text not null default 'queued'
               check (status in ('queued','claimed','running','done','error','stopped')),

  payload      jsonb not null default '{}'::jsonb,
  result       jsonb,
  error        text,

  -- which relay took it, and when it last said it was alive. A claimed job with
  -- a stale heartbeat goes back to queued rather than hanging forever.
  claimed_by   uuid references relay_links(id) on delete set null,
  heartbeat_at timestamptz,

  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index on jobs (status, provider, created_at);
create index on jobs (user_id, created_at desc);
create index on jobs (map_id);

-- Every spend, so a shared club account has a ledger instead of a surprise.
-- cost_usd comes from what the endpoint itself reports.
create table usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  map_id     uuid references maps(id) on delete set null,
  job_id     uuid references jobs(id) on delete set null,
  provider   text not null,
  endpoint   text not null,
  cost_usd   numeric(10,4) not null default 0,
  at         timestamptz not null default now()
);
create index on usage (user_id, at desc);

-- ---------------------------------------------------------------- publish --

-- A publish is immutable. Version N's bytes live at a version-scoped prefix
-- forever and 'latest' is a pointer, so re-exporting can never break a class
-- that is mid-session and a game build can pin a version it was tested against.
create table publishes (
  id           uuid primary key default gen_random_uuid(),
  map_id       uuid not null references maps(id) on delete cascade,
  version      integer not null,
  blob_prefix  text not null,
  manifest     jsonb not null,
  bytes        bigint not null default 0,
  published_by uuid references users(id) on delete set null,
  published_at timestamptz not null default now(),
  unique (map_id, version)
);
create index on publishes (map_id, version desc);
