-- One synthetic expense through the real RPC, run in a loop by ci-roundtrip.sh
-- while a dump is taken. Run as the postgres role with -v owner=<uuid>.
select
  set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', :'owner', 'role', 'authenticated')::text,
    false
  );

select
  app.add_expense_entry (
    p_category_id => (
      select id from app.expense_categories where kind = 'fixed_monthly' order by name limit 1
    ),
    p_amount => 1.00,
    p_period_month => date '2026-10-01',
    p_is_estimate => false,
    p_note => 'ci-writer',
    p_request_id => gen_random_uuid()
  );
