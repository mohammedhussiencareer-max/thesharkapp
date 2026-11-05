begin read write;

select
  set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );

do $$
declare
  v_id uuid;
begin
  select id into v_id from app.expense_categories order by id limit 1;
  perform app.rename_expense_category(v_id, 'zz role check proof');
  if not exists (
    select 1 from app.expense_categories where id = v_id and name = 'zz role check proof'
  ) then
    raise exception 'the rename did not change the row';
  end if;
end
$$;

rollback;
