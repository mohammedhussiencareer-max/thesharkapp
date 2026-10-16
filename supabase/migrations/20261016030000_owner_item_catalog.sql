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
-- Conversion writes take the posting advisory lock before the item row, the
-- same order as trg_stock_items_base_unit_lock (BEFORE UPDATE OF base_unit,
-- FOR EACH STATEMENT) and app.assert_ledger_write_allowed. A base_unit change
-- already holds that lock before it locks the row, so the two wait instead of
-- deadlocking, and each check sees the other's committed unit.
create function app.trg_item_unit_conversions_reject_base_unit () returns trigger language plpgsql security definer
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
    si.id = new.item_id
  for share;

  if found
  and pg_catalog.btrim(new.unit) = v_base_unit then
    raise exception 'cannot store a conversion for the item base unit'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function app.trg_item_unit_conversions_reject_base_unit () is 'Rejects a conversion whose unit trims to the item base_unit. Holds the posting advisory lock before the item row.';

revoke all on function app.trg_item_unit_conversions_reject_base_unit ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_item_unit_conversions_reject_base_unit
before insert or update on app.item_unit_conversions for each row
execute function app.trg_item_unit_conversions_reject_base_unit ();

-- Depends on trg_stock_items_base_unit_lock having already taken the posting
-- advisory lock in this statement, before the row lock. Do not run this check
-- from a trigger that is not BEFORE UPDATE OF base_unit.
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
      and pg_catalog.btrim(iuc.unit) = new.base_unit
  ) then
    raise exception 'cannot change base_unit to a unit that already has a conversion'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function app.trg_stock_items_reject_converted_base_unit () is 'Rejects a base_unit change to a unit that already has a conversion row. The posting advisory lock is already held by trg_stock_items_base_unit_lock.';

revoke all on function app.trg_stock_items_reject_converted_base_unit ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_stock_items_reject_converted_base_unit
before update of base_unit on app.stock_items for each row
execute function app.trg_stock_items_reject_converted_base_unit ();
