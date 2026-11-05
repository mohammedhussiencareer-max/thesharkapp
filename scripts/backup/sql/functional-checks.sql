begin;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object('sub',:'owner', 'role', 'authenticated')::text,
    true
  );

set
  local role authenticated;

do $$
begin
  if not app.is_owner() then
    raise exception 'FUNCTIONAL: app.is_owner() is false for the restored owner';
  end if;
  perform 1 from app.stock_items limit 1;
end
$$;

rollback;

begin;

set
  local role anon;

do $$
begin
  perform 1 from app.stock_items limit 1;
  raise exception 'FUNCTIONAL: anon can read app.stock_items';
exception
  when insufficient_privilege then
    null;
end
$$;

rollback;
