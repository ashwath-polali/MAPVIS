-- One kind of point on the water, and it is called a berth.
--
-- A point nested inside the island that owns it and a point in a free-standing
-- `marks` array are two shapes doing one job, and the nested one cannot be
-- placed: it is welded to its place, born at that place's corner. The corner a
-- sail leg turns at halfway across then has to be faked as a berth on whichever
-- island happens to be nearer.
--
-- One kind of point instead. A berth is a waypoint on the ocean: dropped and
-- dragged anywhere, addressable by name from code, and joinable, so a ship can
-- run from one island to another through however many berths steer it.
--
-- So every nested point is lifted into `marks` and the nesting is stripped.
-- Belonging to an island becomes a FIELD, `island`, naming the place: the point
-- still follows that island when it is dragged, and it is still what
-- composition() hands the game as that slot's berth, but it is a free point that
-- can be moved anywhere and addressed by its own name.
--
-- WHAT A LIFTED POINT IS CALLED. `<place>_berth`, labelled off the place's title
-- so a player never reads an address: the hub's berth becomes `the_hub_berth`
-- labelled "The Hub Berth". Names are checked against every island, every sea
-- region and every existing mark, because python addresses all of them in one
-- namespace and a collision is a save the server refuses.
--
-- `approach` LEAVES THE VOCABULARY. It was never a kind of point; it was the
-- second field on a place. A lifted one becomes a plain berth of its own, and
-- any mark that had somehow been given kind `approach` is rewritten, so nothing
-- is left for cleanMark to go on silently accepting.
--
-- THE VERSION IS NOT COUNTED UP. The game stamps a saved position with it and
-- refuses to resume a run when it has moved. Every berth comes out of this at
-- exactly the coordinates it went in at, so nothing the game reads has changed,
-- and bumping it would throw away every saved position at once
-- for a rename.
do $$
declare
  places_in  jsonb;
  places_out jsonb := '[]'::jsonb;
  marks_out  jsonb;
  regions_in jsonb;
  taken      text[];
  pl         jsonb;
  nested     jsonb;
  what       text;
  base       text;
  nm         text;
  words      text;
  made       jsonb;
  n          int;
begin
  select places, coalesce(marks, '[]'::jsonb), coalesce(regions, '[]'::jsonb)
    into places_in, marks_out, regions_in
    from world where id = 1;
  if places_in is null then return; end if;

  -- every name already spoken for, so a lifted berth cannot land on top of an
  -- island, a stretch of water or a waypoint somebody already placed
  select coalesce(array_agg(v), '{}'::text[]) into taken from (
    select jsonb_array_elements(places_in) ->> 'name' as v
    union all select jsonb_array_elements(marks_out) ->> 'name'
    union all select jsonb_array_elements(regions_in) ->> 'name'
  ) s where v is not null;

  select coalesce(jsonb_agg(
           case when m ->> 'kind' = 'approach' then jsonb_set(m, '{kind}', '"berth"'::jsonb) else m end
         ), '[]'::jsonb)
    into marks_out
    from jsonb_array_elements(marks_out) m;

  for pl in select jsonb_array_elements(places_in) loop
    foreach what in array array['berth', 'approach'] loop
      nested := pl -> what;
      continue when nested is null or jsonb_typeof(nested) <> 'object';
      continue when nested -> 'x' is null or nested -> 'y' is null;

      base := left(coalesce(pl ->> 'name', 'island') || '_' || what, 48);
      nm := base;
      n := 2;
      while nm = any(taken) loop
        nm := left(base, 45) || '_' || n;
        n := n + 1;
      end loop;
      taken := taken || nm;

      -- the words a player reads, from the title if the author wrote one and
      -- unpacked from the address if not, which is what displayName does
      words := nullif(btrim(coalesce(pl ->> 'title', '')), '');
      if words is null then words := initcap(replace(coalesce(pl ->> 'name', 'island'), '_', ' ')); end if;

      made := jsonb_build_object(
        'name', nm,
        'kind', 'berth',
        'x', nested -> 'x',
        'y', nested -> 'y',
        'island', pl ->> 'name',
        'label', words || ' ' || initcap(what)
      );
      -- the heading held once the hull is tied up, and the anchor inside the
      -- island it puts somebody down on. Both lived on the nested point and
      -- both are real authored data, so neither is defaulted or dropped.
      if nested ? 'facing' then made := made || jsonb_build_object('facing', nested -> 'facing'); end if;
      if nested ? 'at' then made := made || jsonb_build_object('at', nested -> 'at'); end if;
      marks_out := marks_out || jsonb_build_array(made);
    end loop;
    places_out := places_out || jsonb_build_array(pl - 'berth' - 'approach');
  end loop;

  update world set places = places_out, marks = marks_out where id = 1;
end $$;
