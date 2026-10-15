begin;

select
  plan (1);

select
  has_schema ('app', 'schema app exists');

select
  *
from
  finish ();

rollback;
