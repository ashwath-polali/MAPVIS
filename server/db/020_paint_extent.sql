-- WHERE THE PAINT ACTUALLY IS, MEASURED, AS OPPOSED TO WHERE THE FILE IS.
--
-- base_w/base_h/base_ox/base_oy are the DROPPED IMAGE's size and offset inside
-- the canvas. They are what growCanvas moves and what re-grows a map on reload,
-- so getDoc round-trips them back into the document and they cannot be
-- repurposed. A picture dropped with its transparent margin already baked in
-- reads identical to the canvas, 688x640 at 0,0, which is useless as a
-- footprint.
--
-- The game wants a different fact. Its WorldSlot.footprint is the PAINTED
-- extent, because a discovery radius is measured against the island somebody can
-- see, and its origin is where that extent sits so a slot is placed by the
-- painting's centre and not the canvas's. On a 688x640 canvas whose opaque rows
-- run 194 to 570 that is 669x377 at 7,194, sixty-two pixels south of the centre.
--
-- Sending base_* under the name `footprint` is fatal rather than merely wrong.
-- 688 * 640 = 440,320 against the 265,000 pixel ceiling one generation can hold,
-- so compositionFaults refuses the WHOLE composition on that one field, and a
-- reader that throws a faulty document away discards every island with it.
--
-- So the extent gets four columns of its own, scanned off the bytes that
-- actually ship at publish. Zero means never measured, and composition() falls
-- back to base_* there, which is only what it was already sending.
alter table maps add column if not exists paint_w  integer not null default 0;
alter table maps add column if not exists paint_h  integer not null default 0;
alter table maps add column if not exists paint_ox integer not null default 0;
alter table maps add column if not exists paint_oy integer not null default 0;
