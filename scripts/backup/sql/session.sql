begin isolation level repeatable read read only;
\if :{?snapshot}
set transaction snapshot :'snapshot';
\endif
set local timezone = 'UTC';
set local extra_float_digits = 1;
set local search_path = '';
set local intervalstyle = 'postgres';
set local datestyle = 'ISO, MDY';
set local bytea_output = 'hex';
set local statement_timeout = '15min';
