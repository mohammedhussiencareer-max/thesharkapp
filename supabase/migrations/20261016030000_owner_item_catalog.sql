-- Owner catalog maintenance. Items are deactivated, never deleted.
-- A conversion unit must not be the item's base unit: post_movements treats
-- that unit as factor 1 and would ignore the row.
-- ============================================================================
-- 1. Owner writes through RLS. service_role grants from the ledger migration stay.
-- ============================================================================
grant insert on table app.stock_items to authenticated;

grant
update (
  name,
  kind,
  base_unit,
  count_frequency,
  loss_pct,
  parent_item_id,
  active
) on table app.stock_items to authenticated;

grant insert,
update,
delete on table app.item_unit_conversions to authenticated;

create policy stock_items_insert_owner on app.stock_items for insert to authenticated
with
  check (app.is_owner ());

create policy stock_items_update_owner on app.stock_items
for update
  to authenticated using (app.is_owner ())
with
  check (app.is_owner ());

create policy item_unit_conversions_insert_owner on app.item_unit_conversions for insert to authenticated
with
  check (app.is_owner ());

create policy item_unit_conversions_update_owner on app.item_unit_conversions
for update
  to authenticated using (app.is_owner ())
with
  check (app.is_owner ());

create policy item_unit_conversions_delete_owner on app.item_unit_conversions for delete to authenticated using (app.is_owner ());

-- ============================================================================
-- 2. Unindexed foreign key (Supabase advisor).
-- ============================================================================
create index stock_items_parent_item_id_idx on app.stock_items (parent_item_id)
where
  parent_item_id is not null;

-- ============================================================================
-- 3. Base unit and conversion unit must stay distinct.
-- ============================================================================
-- Every conversion write first takes the posting advisory lock in a BEFORE
-- STATEMENT trigger, before any row is locked (a BEFORE ROW trigger would take
-- it after the conversion row lock and could deadlock with a multi-row update).
-- So a factor never changes while a posting batch reads conversions, and the
-- conversion writes and base_unit changes (which take the same lock the same
-- way) run one after the other. The row trigger then checks the item's base
-- unit; while any conversion exists, trg_stock_items_reject_converted_base_unit
-- rejects a base_unit change.
-- Shared by the conversion writes and item deletes: takes the posting advisory lock.
create function app.trg_item_unit_conversions_lock () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);
  return null;
end;
$$;

revoke all on function app.trg_item_unit_conversions_lock ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_item_unit_conversions_lock
before insert or update or delete on app.item_unit_conversions for each statement
execute function app.trg_item_unit_conversions_lock ();

-- Deleting an item cascades to its conversions, whose statement trigger takes
-- the posting advisory lock only after the item row is locked. Take the lock
-- first, before any item row lock, so a delete cannot deadlock with a posting
-- that waits on the item row for its foreign-key check.
create trigger trg_stock_items_delete_lock
before delete on app.stock_items for each statement
execute function app.trg_item_unit_conversions_lock ();

create function app.trg_item_unit_conversions_reject_base_unit () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_base_unit text;
begin
  select
    si.base_unit
  into v_base_unit
  from
    app.stock_items si
  where
    si.id = new.item_id;

  if found
  and pg_catalog.btrim(new.unit) = v_base_unit then
    raise exception 'cannot store a conversion for the item base unit'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- No row lock on the item: base_unit changes and item deletes take the same
-- posting advisory lock that trg_item_unit_conversions_lock already holds, so
-- the read is stable, and a row lock here could deadlock with multi-row item
-- updates (for example toggling active) that take no advisory lock.
comment on function app.trg_item_unit_conversions_reject_base_unit () is 'Rejects a conversion whose unit trims to the item base_unit. The posting advisory lock is already held by trg_item_unit_conversions_lock.';

revoke all on function app.trg_item_unit_conversions_reject_base_unit ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_item_unit_conversions_reject_base_unit
before insert or update on app.item_unit_conversions for each row
execute function app.trg_item_unit_conversions_reject_base_unit ();

-- Runs after trg_stock_items_base_unit_lock (BEFORE UPDATE OF base_unit,
-- FOR EACH STATEMENT), which already holds the posting advisory lock before
-- the row lock. Do not move this check off that trigger.
create function app.trg_stock_items_reject_converted_base_unit () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  if new.base_unit is distinct from old.base_unit
  and exists (
    select
      1
    from
      app.item_unit_conversions iuc
    where
      iuc.item_id = new.id
  ) then
    raise exception 'cannot change base_unit while the item has unit conversions'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function app.trg_stock_items_reject_converted_base_unit () is 'Rejects any base_unit change while the item has a conversion row, so existing factors keep their meaning. The posting advisory lock is already held by trg_stock_items_base_unit_lock.';

revoke all on function app.trg_stock_items_reject_converted_base_unit ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_stock_items_reject_converted_base_unit
before update of base_unit on app.stock_items for each row
execute function app.trg_stock_items_reject_converted_base_unit ();

-- ============================================================================
-- 4. Add a conversion only if the caller's base unit is still current.
-- ============================================================================
-- Lock order: take the posting advisory lock BEFORE reading base_unit. Every
-- base_unit change takes this same lock in a BEFORE STATEMENT trigger, before
-- its row lock, so this function waits for that change to commit and then
-- reads the new unit. A plain select is enough; the lock already serializes
-- the read with those updates. The insert's statement trigger takes the lock
-- again, which this transaction already holds.
-- pg_advisory_xact_lock is granted to PUBLIC by default in Postgres, so
-- authenticated can execute it.
create function app.add_unit_conversion (
  p_item_id uuid,
  p_unit text,
  p_factor numeric,
  p_expected_base_unit text
) returns void language plpgsql security invoker
set
  search_path = '' as $$
declare
  v_base_unit text;
begin
  perform pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);

  select
    si.base_unit
  into v_base_unit
  from
    app.stock_items si
  where
    si.id = p_item_id;

  if found
  and v_base_unit is distinct from p_expected_base_unit then
    raise exception 'base unit changed'
      using errcode = '40001';
  end if;

  -- A hidden row looks missing. Only the owner, who can see every item, gets
  -- the stale error; a non-owner falls through to the insert and RLS denies it.
  if not found
  and app.is_owner () then
    raise exception 'base unit changed'
      using errcode = '40001';
  end if;

  insert into
    app.item_unit_conversions (item_id, unit, factor_to_base)
  values
    (p_item_id, p_unit, p_factor);
end;
$$;

comment on function app.add_unit_conversion (uuid, text, numeric, text) is 'Inserts a conversion when base_unit still matches. Takes the posting advisory lock before reading base_unit so a concurrent base_unit change cannot land in between. pg_advisory_xact_lock stays executable by authenticated because Postgres grants it to PUBLIC.';

revoke
execute on function app.add_unit_conversion (uuid, text, numeric, text)
from
  public,
  anon;

grant
execute on function app.add_unit_conversion (uuid, text, numeric, text) to authenticated;

-- ============================================================================
-- 5. Update and delete a conversion only if the base unit and factor still match.
-- ============================================================================
-- Lock order matches add_unit_conversion: the posting advisory lock is taken
-- BEFORE reading base_unit, so a concurrent base_unit change (which takes the
-- same lock before its row lock) cannot commit in between. The row change then
-- runs under that lock. pg_advisory_xact_lock is granted to PUBLIC by default,
-- so authenticated can execute it.
create function app.update_unit_conversion (
  p_item_id uuid,
  p_unit text,
  p_expected_factor numeric,
  p_factor numeric,
  p_expected_base_unit text
) returns void language plpgsql security invoker
set
  search_path = '' as $$
declare
  v_base_unit text;
  v_updated integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);

  select
    si.base_unit
  into v_base_unit
  from
    app.stock_items si
  where
    si.id = p_item_id;

  if found
  and v_base_unit is distinct from p_expected_base_unit then
    raise exception 'base unit changed'
      using errcode = '40001';
  end if;

  -- A hidden row looks missing. Only the owner, who can see every item, gets
  -- the stale error; a non-owner falls through and the update matches nothing.
  if not found
  and app.is_owner () then
    raise exception 'base unit changed'
      using errcode = '40001';
  end if;

  update app.item_unit_conversions
  set
    factor_to_base = p_factor
  where
    item_id = p_item_id
    and unit = p_unit
    and factor_to_base = p_expected_factor;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise exception 'conversion changed'
      using errcode = '40001';
  end if;
end;
$$;

comment on function app.update_unit_conversion (uuid, text, numeric, numeric, text) is 'Updates a conversion when base_unit and the stored factor still match. Takes the posting advisory lock before reading base_unit.';

revoke
execute on function app.update_unit_conversion (uuid, text, numeric, numeric, text)
from
  public,
  anon;

grant
execute on function app.update_unit_conversion (uuid, text, numeric, numeric, text) to authenticated;

create function app.delete_unit_conversion (
  p_item_id uuid,
  p_unit text,
  p_expected_factor numeric,
  p_expected_base_unit text
) returns void language plpgsql security invoker
set
  search_path = '' as $$
declare
  v_base_unit text;
  v_deleted integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);

  select
    si.base_unit
  into v_base_unit
  from
    app.stock_items si
  where
    si.id = p_item_id;

  if found
  and v_base_unit is distinct from p_expected_base_unit then
    raise exception 'base unit changed'
      using errcode = '40001';
  end if;

  -- A hidden row looks missing. Only the owner, who can see every item, gets
  -- the stale error; a non-owner falls through and the delete matches nothing.
  if not found
  and app.is_owner () then
    raise exception 'base unit changed'
      using errcode = '40001';
  end if;

  delete from app.item_unit_conversions
  where
    item_id = p_item_id
    and unit = p_unit
    and factor_to_base = p_expected_factor;

  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    raise exception 'conversion changed'
      using errcode = '40001';
  end if;
end;
$$;

comment on function app.delete_unit_conversion (uuid, text, numeric, text) is 'Deletes a conversion when base_unit and the stored factor still match. Takes the posting advisory lock before reading base_unit.';

revoke
execute on function app.delete_unit_conversion (uuid, text, numeric, text)
from
  public,
  anon;

grant
execute on function app.delete_unit_conversion (uuid, text, numeric, text) to authenticated;
