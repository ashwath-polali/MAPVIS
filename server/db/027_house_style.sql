-- Whose hand drew this map.
--
-- A style card is a craft sentence and one reference painting: the part of a
-- prompt that says projection, cluster size, outline, light and saturation, and
-- never says anything about the subject. The words themselves are in
-- server/store/style.mjs, which is the file to read and edit. This is only where
-- a card lives and who is allowed to reach for it.
--
-- TWO KINDS OF CARD AND THE DIFFERENCE IS THE WHOLE POINT. An account's own card
-- is made from one of its own published maps and nobody else ever sees it. The
-- house card is one account's card that OTHER accounts may be granted, which is
-- how a group of people building one game all draw in the same hand while a
-- stranger who signs up draws in their own. Without the grant table the only two
-- options are one global style for everybody or no shared style at all, and both
-- are wrong.

create table if not exists style_cards (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references users(id) on delete cascade,

  -- the address a map stores and a bundle stamps, so a card can be renamed for
  -- a person without every map that used it losing track of which hand it was
  key        text not null check (key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  title      text not null default '',

  -- palette, light, outline, scale and the one compact clause that is appended
  -- to a prompt. Shaped exactly like the card readStyleCard writes off a
  -- painting, because that is where an account's own card comes from.
  craft      jsonb not null default '{}'::jsonb,

  -- the published map whose picture is passed as the style image. Empty is
  -- legal: the craft sentence alone still carries the hand, and a card made
  -- before its reference was published should not be unusable until it is.
  ref_slug   text not null default '',

  -- the one card that is granted rather than owned. Marked here rather than
  -- inferred from the grant table being non-empty, because a house card with
  -- nobody granted yet is still a house card.
  house      boolean not null default false,

  created_at timestamptz not null default now(),
  unique (owner_id, key)
);

create index if not exists style_cards_owner on style_cards (owner_id);

-- Who may reach a card that is not theirs. Only ever rows for a house card: an
-- account's own card needs no grant and must never get one.
create table if not exists style_grants (
  card_id    uuid not null references style_cards(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (card_id, user_id)
);

create index if not exists style_grants_user on style_grants (user_id);

-- WHICH HAND DREW THIS MAP, chosen on the first step before the subject is
-- typed. Null is the honest default and it means the prompt went out as typed:
-- every map that already exists was drawn that way and none of them should start
-- claiming a hand they were not drawn by.
alter table maps add column if not exists style_card_id uuid references style_cards(id) on delete set null;

-- The kind the person typed, which is not the same fact as `class`. `class`
-- decides how the engine loads a bundle; this records which scaffold was put in
-- front of the generator, so a republish writes the same prompt shape and a map
-- whose class was corrected afterwards does not rewrite its own history.
alter table maps add column if not exists style_kind text not null default ''
  check (style_kind in ('', 'island', 'room', 'hall'));
