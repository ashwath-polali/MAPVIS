-- The run-in goes back on the berth it belongs to, and the test buoy goes.
--
-- 1. THE APPROACH IS A FIELD ON A BERTH AGAIN.
--
-- 019 lifted every nested `approach` out of its place and appended it to `marks`
-- as a free-standing berth named `<place>_approach`. Nothing then put it back on
-- the wire, so `slot.berth.approach` had no author, and PmapScene reads that
-- field and sail.ts runs a whole two-stage manoeuvre off it: aim at the run-in,
-- carry on until it is astern, then swing onto the berth's own heading. Without
-- it every arrival in the game is a straight-in nose.
--
-- It came back briefly as a POSITIONAL rule, "the second berth-kind mark bound
-- to this island", which is what 019 happened to write. That rule is invisible:
-- an author placing a spare dock, or binding a route corner to an island so it
-- follows it around, silently made it the thing the hull steers at, and nothing
-- on the chart or on the wire says which of two points is which.
--
-- So it is a field. `approach` is NOT a kind of mark and it is not coming back
-- as one: nothing sails to a run-in, nothing ever names it, and it only means
-- anything relative to one berth. That is the opposite of the destination 019
-- was freeing, and it is the one case where welding a point to its owner is
-- right rather than wrong.
--
-- WHAT IS FOLDED. Every mark named `<something>_approach` bound to an island
-- that has a berth becomes that berth's nested approach, and the lifted mark is
-- deleted. Its own name, facing and label die with it, which is correct: they
-- are derived from the place's title and nothing reads them.
--
-- 2. AND THE TEST BUOY IS DELETED.
--
-- `sunken_bell_buoy`, labelled "Bell of the Deep", is residue left behind by a
-- verify run that did not clean up after itself. Named exactly, so `the_hub`
-- and `the_hub_berth` are untouched.
--
-- THE VERSION IS NOT COUNTED UP. The game stamps a saved position with it and
-- refuses to resume a run when it has moved, so bumping it throws away the
-- position everybody has saved. Marks are deliberately outside the
-- version comparison in saveWorld for exactly this reason: moving a dock does
-- not put a student inside a wall.
do $$
declare
  marks_in  jsonb;
  marks_out jsonb := '[]'::jsonb;
  m         jsonb;
  run_in    jsonb;
  isle      text;
  -- which islands have already had their dock given the run-in, because only
  -- the FIRST berth bound to an island is the one composition() sends and a
  -- run-in on any of the others is a field nothing reads
  fed       text[] := '{}'::text[];
begin
  select coalesce(marks, '[]'::jsonb) into marks_in from world where id = 1;
  if marks_in is null then return; end if;

  for m in select jsonb_array_elements(marks_in) loop
    -- the buoy leaves without ceremony
    continue when m ->> 'name' = 'sunken_bell_buoy';
    -- and so does a lifted run-in, after its point has been carried across
    continue when m ->> 'name' like '%\_approach'
             and m ->> 'kind' = 'berth'
             and nullif(m ->> 'island', '') is not null;

    -- a dock takes the first lifted run-in bound to the same island. The order
    -- 019 wrote is berth first and approach second, so `first` here is the one
    -- that was this berth's, and a second would have had nothing reading it.
    isle := nullif(m ->> 'island', '');
    if m ->> 'kind' = 'berth' and isle is not null and not (m ? 'approach') and not (isle = any(fed)) then
      fed := fed || isle;
      select a into run_in
        from jsonb_array_elements(marks_in) a
       where a ->> 'name' like '%\_approach'
         and a ->> 'kind' = 'berth'
         and a ->> 'island' = isle
         and a -> 'x' is not null and a -> 'y' is not null
       limit 1;
      if run_in is not null then
        m := m || jsonb_build_object('approach', jsonb_build_object('x', run_in -> 'x', 'y', run_in -> 'y'));
        run_in := null;
      end if;
    end if;

    marks_out := marks_out || jsonb_build_array(m);
  end loop;

  update world set marks = marks_out where id = 1;
end $$;
