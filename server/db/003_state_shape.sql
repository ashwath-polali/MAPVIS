-- What a face looks like, so the library listing can be answered from rows
-- rather than by walking work/<id>/states/ and opening a png per face to read
-- its header.
--
-- The client reads a state's size and fps directly (App.tsx picks a face by
-- name and draws it), so those have to survive the move off disk. src is the
-- first frame, which is what the picker draws as the thumbnail.
alter table library_states add column fps integer;
alter table library_states add column w integer not null default 0;
alter table library_states add column h integer not null default 0;
alter table library_states add column src text;
