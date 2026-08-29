-- A picture of a page is not a page.
--
-- 010 and 011 closed gaps in what a MAP could say. This one is a different
-- surface entirely: the furniture the game draws OVER a map. A dialogue box, a
-- meter, a card, a button. All of it is currently drawn by hand in the game's
-- own code with numbers typed beside it, which is exactly the defect the camera
-- rule was written to kill on the asset side: a hand-typed offset is a fact
-- about a picture that lives nowhere near the picture.
--
-- So a surface is not just a png. It is a png plus the named places inside it
-- where a value goes, and the slots are the whole reason this table exists. A
-- generated panel with no slots is a wallpaper: the vine still has to be told
-- where the number sits, where the bar fills from, where the button is
-- clickable, and every one of those numbers would be typed into vine source and
-- would go stale the moment the panel is regenerated one pixel wider.
--
-- OWNED BY AN ACCOUNT, NOT BY A MAP, and that is the point of it. A dialogue
-- box is not about the hub any more than it is about the Maw; it is the game's
-- own chrome, used by every island at once. library_items is map-scoped and
-- could not have held this without the nullable map_id that 013 explains is not
-- worth its blast radius.

create table if not exists ui_assets (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references users(id) on delete cascade,

  -- the address a grape holds. Same python-identifier rule anchors and
  -- placements are held to, for the same reason: it is typed into member code
  -- and has to be legal there.
  name         text not null check (name ~ '^[a-z][a-z0-9_]{0,47}$'),
  title        text not null default '',
  description  text not null default '',

  -- the picture's own extent, which every slot rect is measured against
  w            integer not null,
  h            integer not null,

  -- where the png sits in object storage, and which pixellab row drew it. The
  -- second one is kept for the same reason map objects keep theirs: without it
  -- there is no way back to the thing that was paid for.
  blob_key     text not null default '',
  pixellab_id  text not null default '',

  -- each entry: name, kind, x, y, w, h, and optionally align and meta. jsonb
  -- rather than a table for the reason `assets` is jsonb on maps: genuinely
  -- nested, small, and never read without the surface it belongs to.
  slots        jsonb not null default '[]'::jsonb,

  -- a surface exists as a row before its picture exists, because generation
  -- takes a minute and a half and the row is what the caller polls. 'failed' is
  -- kept rather than deleted so a spend that produced nothing is still visible.
  status       text not null default 'pending' check (status in ('pending','ready','failed')),
  created_at   timestamptz not null default now(),

  unique (owner_id, name)
);
create index on ui_assets (owner_id);
