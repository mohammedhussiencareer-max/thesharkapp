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
-- This trigger does not take the posting advisory lock. A BEFORE ROW trigger
-- would acquire that lock after the conversion row lock, so a multi-row update
-- can deadlock with another update that locks rows in a different order.
-- It reads the item FOR SHARE instead. A concurrent base_unit UPDATE already
-- holds a no-key-update lock on that item row (trg_stock_items_base_unit_lock
-- takes the posting advisory lock in a BEFORE STATEMENT trigger, before that
-- row lock). FOR SHARE conflicts with no-key-update, so the conversion write
-- and the base_unit update wait on the item row. While any conversion exists,
-- trg_stock_items_reject_converted_base_unit rejects the base_unit change.
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

comment on function app.trg_item_unit_conversions_reject_base_unit () is 'Rejects a conversion whose unit trims to the item base_unit. Locks the item FOR SHARE so it waits on a concurrent base_unit update, without the posting advisory lock.';

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
