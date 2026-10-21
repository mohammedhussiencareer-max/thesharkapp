-- Expenses and daily allocation. No dependency on purchases or POS shifts.
--
-- Categories have a kind: fixed_monthly, daily, driver_hours, interest, or
-- depreciation. Kind is frozen. The owner can rename or deactivate a category;
-- deactivating it does not drop entries already posted. Seed rows are synthetic
-- labels only, with no amounts.
--
-- expense_entries is append-only. A normal row is one posted expense. A void
-- row points at it (voids_id) with a reason and does not carry an amount.
-- There is no UPDATE and no DELETE. driver_hours.amount is not taken from the
-- client: trg_expense_entries_validate sets it to round(hours * hourly_rate, 2)
-- (half away from zero, the numeric round).
--
-- request_id is unique on every row, entries and voids. The web mints one id
-- per draft and sends that same id again if the reply is lost. After the owner
-- check and after the raw payload is validated and normalized, the function
-- looks up request_id before any category or target lookup. The same normalized
-- payload returns the saved id and inserts nothing. A different payload raises
-- 'request_id already used for a different expense' (22023). The unique
-- constraint is only the race guard: the loser retries, and the retry hits the
-- lookup. A void retry with the same request_id, the same target, and the same
-- reason returns the existing void. A different target or reason is the same
-- refusal. A void uses its own request_id; it does not reuse the entry's.
-- Driver pay ignores the client amount, so a replay compares hours, rate, and
-- the computed amount, not the discarded client amount.
--
-- The owner types the category name, the note, the void reason, and the driver
-- label. One helper, app.text_has_long_digit_run, rejects a run of 8 or more
-- Unicode decimal digits (general category Nd) in all of them. The bracket
-- class lists every Nd range from Node Unicode 16.0
-- (process.versions.unicode), generated with /\p{Nd}/u over U+0000–U+10FFFF.
-- The client uses the same property. Text is NFKC-normalized first. A letter
-- resets the count. Every other character is ignored, so brackets, slashes,
-- punctuation, symbols, and format characters do not break the run. A date
-- like 2030-04-03 is eight digits and is refused; that is an accepted
-- trade-off. The message is 'مينفعش تكتب أرقام تليفونات أو أرقام قومية'.
--
-- What counts, when the day is read (not at insert):
--   * a voided row does not count, and a void marker never counts;
--   * an actual invoice (is_estimate = false) that is itself not voided
--     supersedes every estimate with the same category and the same period.
--     The estimate row stays. It is not auto-voided. If every actual for that
--     category and period is later voided, the estimates count again.
--   * several actuals all count. Several estimates count only while no actual
--     remains.
--   * the period is period_month for fixed_monthly, interest, and depreciation,
--     and expense_date for daily and driver_hours. paid_on is never the period.
--   * a driver label is not part of the period. One actual for a driver
--     category on a date supersedes every estimate for that category on that
--     date. Other actual driver rows on that date still count.
--
-- Allocation (app.expense_daily) does not read pos_shifts. A day with no shift
-- still carries its share. fixed_monthly lands in fixed_share, interest in
-- interest, and depreciation in depreciation. Each of those is spread over
-- every calendar day of its month (28–31, or 29 in a leap February). daily and
-- driver_hours land only on expense_date.
--
-- Rounding is largest-remainder on piasters, per entry, then summed.
--   base = floor(amount_piasters / day_count)
--   remainder = amount_piasters mod day_count
--   days 1..remainder get one extra piaster; later days get the base.
-- Equal fractions therefore go to the earliest days. The days of the month sum
-- to that entry exactly. Example: 1000.00 over 30 days is 33.34 on days 1–10
-- and 33.33 on days 11–30. A query for part of the month returns those
-- precomputed shares. It does not split the amount again over the requested
-- days. app.expense_month_check reports whether the sum of the month's day
-- totals equals the sum of the effective entries in that month.
--
-- Sums and outputs of expense_day_share, expense_daily, and expense_month_check
-- are unconstrained numeric, rounded to 2 decimal places. One posted entry is
-- still numeric(14,2). Adding entries that each fit that cap cannot overflow
-- the day or the month total.
--
-- No advisory lock. A write does not update a running balance. Supersession is
-- decided when a day is read. A second void of the same entry fails the unique
-- voids_id constraint. Month status stores an explicit boolean, so two writers
-- do not toggle each other. Category kind never changes, so a rename cannot
-- reclassify history.
--
-- Writes go through security definer functions with search_path = '' that allow
-- only the owner or service_role. Authenticated users may SELECT; RLS hides
-- rows from everyone else. anon has no grants.
-- ============================================================================
-- Phone-like runs. Used by category names, notes, void reasons, and labels.
-- ============================================================================
-- [[:alpha:]] follows the database locale provider. Under ICU, PostgreSQL
-- uses u_isalpha, which is the Unicode Letter category (L*): the same set as
-- the client's /\p{L}/u, with combining marks (harakat such as U+064B) not
-- counted as letters. libc or builtin can treat marks as alphabetic and would
-- let a mark split a phone number, so refuse to install anywhere but ICU.
do $icu$
begin
  if (
    select
      d.datlocprovider
    from
      pg_catalog.pg_database d
    where
      d.datname = pg_catalog.current_database()
  ) is distinct from 'i' then
    raise exception 'expenses free-text check needs an ICU database locale'
      using errcode = '0A000';
  end if;
end;
$icu$;

create function app.text_has_long_digit_run (p_text text) returns boolean language plpgsql immutable
set
  search_path = '' as $$
declare
  v_text text;
  v_char text;
  v_run integer := 0;
  -- Nd bracket class, Node Unicode 16.0, 71 inclusive ranges.
  -- 0030-0039 0660-0669 06F0-06F9 07C0-07C9 0966-096F 09E6-09EF 0A66-0A6F
  -- 0AE6-0AEF 0B66-0B6F 0BE6-0BEF 0C66-0C6F 0CE6-0CEF 0D66-0D6F 0DE6-0DEF
  -- 0E50-0E59 0ED0-0ED9 0F20-0F29 1040-1049 1090-1099 17E0-17E9 1810-1819
  -- 1946-194F 19D0-19D9 1A80-1A89 1A90-1A99 1B50-1B59 1BB0-1BB9 1C40-1C49
  -- 1C50-1C59 A620-A629 A8D0-A8D9 A900-A909 A9D0-A9D9 A9F0-A9F9 AA50-AA59
  -- ABF0-ABF9 FF10-FF19 104A0-104A9 10D30-10D39 10D40-10D49 11066-1106F
  -- 110F0-110F9 11136-1113F 111D0-111D9 112F0-112F9 11450-11459 114D0-114D9
  -- 11650-11659 116C0-116C9 116D0-116E3 11730-11739 118E0-118E9 11950-11959
  -- 11BF0-11BF9 11C50-11C59 11D50-11D59 11DA0-11DA9 11F50-11F59 16130-16139
  -- 16A60-16A69 16AC0-16AC9 16B50-16B59 16D70-16D79 1CCF0-1CCF9 1D7CE-1D7FF
  -- 1E140-1E149 1E2F0-1E2F9 1E4F0-1E4F9 1E5F1-1E5FA 1E950-1E959 1FBF0-1FBF9
  c_digit constant text := $nd$[0-9٠-٩۰-۹߀-߉०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯෦-෯๐-๙໐-໙༠-༩၀-၉႐-႙០-៩᠐-᠙᥆-᥏᧐-᧙᪀-᪉᪐-᪙᭐-᭙᮰-᮹᱀-᱉᱐-᱙꘠-꘩꣐-꣙꤀-꤉꧐-꧙꧰-꧹꩐-꩙꯰-꯹０-９𐒠-𐒩𐴰-𐴹𐵀-𐵉𑁦-𑁯𑃰-𑃹𑄶-𑄿𑇐-𑇙𑋰-𑋹𑑐-𑑙𑓐-𑓙𑙐-𑙙𑛀-𑛉𑛐-𑛣𑜰-𑜹𑣠-𑣩𑥐-𑥙𑯰-𑯹𑱐-𑱙𑵐-𑵙𑶠-𑶩𑽐-𑽙𖄰-𖄹𖩠-𖩩𖫀-𖫉𖭐-𖭙𖵰-𖵹𜳰-𜳹𝟎-𝟿𞅀-𞅉𞋰-𞋹𞓰-𞓹𞗱-𞗺𞥐-𞥙🯰-🯹]$nd$;
begin
  v_text := pg_catalog.normalize(
    coalesce(p_text, ''),
    'NFKC'
  );

  if v_text = '' then
    return false;
  end if;

  -- A digit counts. A letter resets the run. Everything else is ignored, so
  -- brackets, slashes, punctuation, symbols, and format characters do not
  -- break it. Test the digit before [[:alpha:]]. A date like 2030-04-03 is
  -- eight digits and is refused; that is an accepted trade-off.
  for v_index in 1..pg_catalog.char_length(v_text) loop
    v_char := pg_catalog.substring(v_text, v_index, 1);

    if v_char ~ c_digit then
      v_run := v_run + 1;

      if v_run >= 8 then
        return true;
      end if;
    elsif v_char ~ '[[:alpha:]]' then
      v_run := 0;
    end if;
  end loop;

  return false;
end;
$$;

comment on function app.text_has_long_digit_run (text) is 'True when free text contains a run of 8 or more Unicode decimal digits (Nd, Unicode 16.0). NFKC is applied first. A letter resets the count. Every other character is ignored. A date like 2030-04-03 is refused; that is an accepted trade-off.';

revoke all on function app.text_has_long_digit_run (text)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.assert_no_phone_text (p_text text) returns void language plpgsql
set
  search_path = '' as $$
begin
  if app.text_has_long_digit_run (p_text) then
    raise exception 'مينفعش تكتب أرقام تليفونات أو أرقام قومية'
      using errcode = '22023';
  end if;
end;
$$;

comment on function app.assert_no_phone_text (text) is 'Rejects a phone-like or national-id-like run in owner-typed text.';

revoke all on function app.assert_no_phone_text (text)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 1. Categories
-- ============================================================================
create table app.expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint expense_categories_name_chk check (char_length(btrim(name)) between 1 and 80),
  constraint expense_categories_kind_chk check (
    kind in (
      'fixed_monthly',
      'daily',
      'driver_hours',
      'interest',
      'depreciation'
    )
  )
);

comment on table app.expense_categories is 'Expense categories. Kind is fixed; the owner renames or deactivates. Seed names have no amounts.';

create unique index expense_categories_name_lower_idx on app.expense_categories (lower(btrim(name)));

create function app.trg_expense_categories_freeze () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  if new.kind is distinct from old.kind then
    raise exception 'expense category kind is fixed'
      using errcode = '55000';
  end if;

  if new.id is distinct from old.id
  or new.created_at is distinct from old.created_at then
    raise exception 'expense category identity is fixed'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke all on function app.trg_expense_categories_freeze ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_expense_categories_freeze
before update on app.expense_categories for each row
execute function app.trg_expense_categories_freeze ();

create function app.trg_expense_categories_no_delete () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  raise exception 'expense categories are not deleted'
    using errcode = '55000';
end;
$$;

revoke all on function app.trg_expense_categories_no_delete ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_expense_categories_no_delete
before delete on app.expense_categories for each row
execute function app.trg_expense_categories_no_delete ();

create trigger trg_expense_categories_no_truncate
before truncate on app.expense_categories for each statement
execute function app.trg_expense_categories_no_delete ();

create function app.trg_expense_categories_phone () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  perform app.assert_no_phone_text (new.name);

  return new;
end;
$$;

revoke all on function app.trg_expense_categories_phone ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_expense_categories_phone
before insert or update on app.expense_categories for each row
execute function app.trg_expense_categories_phone ();

insert into
  app.expense_categories (name, kind)
values
  ('إيجار', 'fixed_monthly'),
  ('مرتبات ثابتة', 'fixed_monthly'),
  ('غاز', 'daily'),
  ('نقل', 'daily'),
  ('أجر يومي', 'daily'),
  ('أجر طيارين', 'driver_hours'),
  ('فوائد', 'interest'),
  ('إهلاك', 'depreciation');

-- ============================================================================
-- 2. Append-only entries
-- ============================================================================
create table app.expense_entries (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  category_id uuid null references app.expense_categories (id) on delete restrict,
  amount numeric(14, 2) null,
  period_month date null,
  expense_date date null,
  paid_on date null,
  is_estimate boolean null,
  note text null,
  hours numeric(6, 2) null,
  hourly_rate numeric(14, 2) null,
  driver_label text null,
  voids_id uuid null unique references app.expense_entries (id) on delete restrict,
  void_reason text null,
  created_at timestamptz not null default now(),
  created_by uuid null,
  constraint expense_entries_note_chk check (
    note is null
    or char_length(btrim(note)) between 1 and 500
  ),
  constraint expense_entries_driver_label_chk check (
    driver_label is null
    or char_length(btrim(driver_label)) between 1 and 40
  ),
  constraint expense_entries_hours_chk check (
    hours is null
    or (
      hours <> 'NaN'::numeric
      and hours > 0
    )
  ),
  constraint expense_entries_hourly_rate_chk check (
    hourly_rate is null
    or (
      hourly_rate <> 'NaN'::numeric
      and hourly_rate > 0
    )
  ),
  constraint expense_entries_shape_chk check (
    (
      voids_id is null
      and category_id is not null
      and amount is not null
      and amount > 0
      and amount <> 'NaN'::numeric
      and is_estimate is not null
      and void_reason is null
      and (
        (
          period_month is not null
          and expense_date is null
          and hours is null
          and hourly_rate is null
          and driver_label is null
        )
        or (
          expense_date is not null
          and period_month is null
        )
      )
    )
    or (
      voids_id is not null
      and voids_id <> id
      and category_id is null
      and amount is null
      and period_month is null
      and expense_date is null
      and paid_on is null
      and is_estimate is null
      and note is null
      and hours is null
      and hourly_rate is null
      and driver_label is null
      and void_reason is not null
      and char_length(btrim(void_reason)) between 1 and 500
    )
  )
);

comment on table app.expense_entries is 'Append-only expenses. Void rows reference the entry they cancel. Driver amount is computed in the validate trigger.';

comment on column app.expense_entries.period_month is 'First day of the month for fixed_monthly, interest, and depreciation.';

comment on column app.expense_entries.expense_date is 'Cairo calendar date for daily and driver_hours. Not a timestamp.';

comment on column app.expense_entries.paid_on is 'Payment date. Separate from the period and never used for allocation.';

comment on column app.expense_entries.is_estimate is 'True until an actual invoice for the same category and period supersedes it. The row is kept.';

comment on column app.expense_entries.request_id is 'One id per draft, including a void draft. A replay of the same normalized payload returns this row.';

comment on column app.expense_entries.voids_id is 'Set only on a void marker. Unique, so an entry is voided at most once.';

create index expense_entries_category_id_idx on app.expense_entries (category_id);

create index expense_entries_period_month_idx on app.expense_entries (period_month)
where
  period_month is not null;

create index expense_entries_expense_date_idx on app.expense_entries (expense_date)
where
  expense_date is not null;

create index expense_entries_list_idx on app.expense_entries (created_at desc, id desc)
where
  voids_id is null;

create function app.prevent_expense_entries_mutation () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception 'app.expense_entries is append-only; % is not allowed', tg_op
    using errcode = '55000';
end;
$$;

revoke all on function app.prevent_expense_entries_mutation ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_expense_entries_no_update_delete
before update or delete on app.expense_entries for each row
execute function app.prevent_expense_entries_mutation ();

create trigger trg_expense_entries_no_truncate
before truncate on app.expense_entries for each statement
execute function app.prevent_expense_entries_mutation ();

create function app.trg_expense_entries_validate () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_kind text;
  v_active boolean;
begin
  if new.voids_id is not null then
    if new.void_reason is null
    or char_length(btrim(new.void_reason)) = 0 then
      raise exception 'void reason is required'
        using errcode = '22023';
    end if;

    if char_length(btrim(new.void_reason)) > 500 then
      raise exception 'void reason is too long'
        using errcode = '22023';
    end if;

    new.void_reason := btrim(new.void_reason);
    perform app.assert_no_phone_text (new.void_reason);
    new.category_id := null;
    new.amount := null;
    new.period_month := null;
    new.expense_date := null;
    new.paid_on := null;
    new.is_estimate := null;
    new.note := null;
    new.hours := null;
    new.hourly_rate := null;
    new.driver_label := null;

    if exists (
      select
        1
      from
        app.expense_entries entry
      where
        entry.id = new.voids_id
        and entry.voids_id is not null
    ) then
      raise exception 'cannot void a void'
        using errcode = '22023';
    end if;

    if exists (
      select
        1
      from
        app.expense_entries entry
      where
        entry.voids_id = new.voids_id
    ) then
      raise exception 'expense entry is already voided'
        using errcode = '22023';
    end if;

    if not exists (
      select
        1
      from
        app.expense_entries entry
      where
        entry.id = new.voids_id
    ) then
      raise exception 'unknown expense entry'
        using errcode = '22023';
    end if;

    return new;
  end if;

  perform app.assert_no_phone_text (new.note);
  perform app.assert_no_phone_text (new.driver_label);

  if new.category_id is null then
    raise exception 'expense category is required'
      using errcode = '22023';
  end if;

  select
    category.kind,
    category.active
  into
    v_kind,
    v_active
  from
    app.expense_categories category
  where
    category.id = new.category_id;

  if not found then
    raise exception 'unknown expense category'
      using errcode = '22023';
  end if;

  if v_active is not true then
    raise exception 'expense category is inactive'
      using errcode = '22023';
  end if;

  if new.is_estimate is null then
    raise exception 'is_estimate is required'
      using errcode = '22023';
  end if;

  if new.void_reason is not null then
    raise exception 'void reason must be empty on an expense'
      using errcode = '22023';
  end if;

  if new.paid_on is not null
  and (
    new.paid_on < date '1990-01-01'
    or new.paid_on > date '2100-12-31'
  ) then
    raise exception 'date is out of range'
      using errcode = '22023';
  end if;

  if v_kind in ('fixed_monthly', 'interest', 'depreciation') then
    if new.period_month is null then
      raise exception 'period month is required'
        using errcode = '22023';
    end if;

    if new.period_month <> pg_catalog.date_trunc('month', new.period_month::timestamp)::date then
      raise exception 'period month must be the first day of the month'
        using errcode = '22023';
    end if;

    if new.period_month < date '1990-01-01'
    or new.period_month > date '2100-12-01' then
      raise exception 'date is out of range'
        using errcode = '22023';
    end if;

    if new.expense_date is not null then
      raise exception 'expense date must be empty for a monthly expense'
        using errcode = '22023';
    end if;

    if new.hours is not null
    or new.hourly_rate is not null
    or new.driver_label is not null then
      raise exception 'driver fields must be empty unless the category is driver hours'
        using errcode = '22023';
    end if;

    if new.amount is null
    or new.amount <= 0
    or new.amount = 'NaN'::numeric then
      raise exception 'amount must be greater than zero'
        using errcode = '22023';
    end if;

    return new;
  end if;

  if v_kind = 'daily' then
    if new.expense_date is null then
      raise exception 'expense date is required'
        using errcode = '22023';
    end if;

    if new.expense_date < date '1990-01-01'
    or new.expense_date > date '2100-12-31' then
      raise exception 'date is out of range'
        using errcode = '22023';
    end if;

    if new.period_month is not null then
      raise exception 'period month must be empty for a daily expense'
        using errcode = '22023';
    end if;

    if new.hours is not null
    or new.hourly_rate is not null
    or new.driver_label is not null then
      raise exception 'driver fields must be empty unless the category is driver hours'
        using errcode = '22023';
    end if;

    if new.amount is null
    or new.amount <= 0
    or new.amount = 'NaN'::numeric then
      raise exception 'amount must be greater than zero'
        using errcode = '22023';
    end if;

    return new;
  end if;

  if v_kind = 'driver_hours' then
    if new.expense_date is null then
      raise exception 'expense date is required'
        using errcode = '22023';
    end if;

    if new.expense_date < date '1990-01-01'
    or new.expense_date > date '2100-12-31' then
      raise exception 'date is out of range'
        using errcode = '22023';
    end if;

    if new.period_month is not null then
      raise exception 'period month must be empty for a daily expense'
        using errcode = '22023';
    end if;

    if new.hours is null then
      raise exception 'hours are required for driver pay'
        using errcode = '22023';
    end if;

    if new.hourly_rate is null then
      raise exception 'hourly rate is required for driver pay'
        using errcode = '22023';
    end if;

    if new.hours <= 0
    or new.hours = 'NaN'::numeric then
      raise exception 'hours must be greater than zero'
        using errcode = '22023';
    end if;

    if new.hourly_rate <= 0
    or new.hourly_rate = 'NaN'::numeric then
      raise exception 'hourly rate must be greater than zero'
        using errcode = '22023';
    end if;

    -- Client amount is ignored. Half away from zero, same as numeric round.
    new.amount := pg_catalog.round(new.hours * new.hourly_rate, 2);

    if new.amount is null
    or new.amount <= 0
    or new.amount = 'NaN'::numeric then
      raise exception 'driver amount must be greater than zero'
        using errcode = '22023';
    end if;

    return new;
  end if;

  raise exception 'expense category kind is not allowed'
    using errcode = '22023';
end;
$$;

comment on function app.trg_expense_entries_validate () is 'Checks kind, period, and void shape. Overwrites driver_hours.amount with round(hours * hourly_rate, 2).';

revoke all on function app.trg_expense_entries_validate ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_expense_entries_validate
before insert on app.expense_entries for each row
execute function app.trg_expense_entries_validate ();

-- ============================================================================
-- 3. Month status. The owner marks a month complete and can unmark it.
-- ============================================================================
create table app.month_expense_status (
  month date primary key,
  complete boolean not null,
  confirmed_at timestamptz null,
  confirmed_by uuid null,
  constraint month_expense_status_month_chk check (
    month = pg_catalog.date_trunc ('month', month::timestamp)::date
  ),
  constraint month_expense_status_confirm_chk check (
    (
      complete
      and confirmed_at is not null
      and confirmed_by is not null
    )
    or (
      not complete
      and confirmed_at is null
      and confirmed_by is null
    )
  )
);

comment on table app.month_expense_status is 'Owner flag that a month''s expenses are complete. Unmarking clears confirmed_at and confirmed_by.';

-- ============================================================================
-- 4. Privileges. SELECT for the owner via RLS. No direct writes.
-- ============================================================================
alter table app.expense_categories enable row level security;

alter table app.expense_entries enable row level security;

alter table app.month_expense_status enable row level security;

create policy expense_categories_select_owner on app.expense_categories for
select
  to authenticated using (app.is_owner ());

create policy expense_entries_select_owner on app.expense_entries for
select
  to authenticated using (app.is_owner ());

create policy month_expense_status_select_owner on app.month_expense_status for
select
  to authenticated using (app.is_owner ());

revoke all on table app.expense_categories
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.expense_categories to authenticated,
  service_role;

revoke all on table app.expense_entries
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.expense_entries to authenticated,
  service_role;

revoke all on table app.month_expense_status
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.month_expense_status to authenticated,
  service_role;

-- ============================================================================
-- 5. Write functions
-- ============================================================================
create function app.assert_expense_write_allowed () returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_is_owner boolean;
  v_db_role text;
  v_jwt_role text;
begin
  -- Same privilege rule as app.assert_pos_write_allowed. No advisory lock:
  -- there is no running balance, voids are unique, and month status is an
  -- explicit boolean rather than a toggle of the stored value.
  v_is_owner := coalesce(app.is_owner (), false);
  v_db_role := coalesce(nullif(pg_catalog.current_setting('role', true), ''), '');
  v_jwt_role := coalesce(
    (
      select
        nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    ),
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    ''
  );

  if not coalesce(
    v_is_owner is true
    or v_db_role = 'service_role'
    or v_jwt_role = 'service_role',
    false
  ) then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;
end;
$$;

comment on function app.assert_expense_write_allowed () is 'Allows the owner or service_role to write expenses. Does not take an advisory lock.';

revoke all on function app.assert_expense_write_allowed ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.add_expense_category (p_name text, p_kind text) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_name text;
  v_id uuid;
begin
  perform app.assert_expense_write_allowed ();

  v_name := btrim(coalesce(p_name, ''));

  if v_name = '' then
    raise exception 'expense category name is required'
      using errcode = '22023';
  end if;

  if char_length(v_name) > 80 then
    raise exception 'expense category name is too long'
      using errcode = '22023';
  end if;

  perform app.assert_no_phone_text (v_name);

  if p_kind is null
  or p_kind not in (
    'fixed_monthly',
    'daily',
    'driver_hours',
    'interest',
    'depreciation'
  ) then
    raise exception 'expense category kind is not allowed'
      using errcode = '22023';
  end if;

  insert into
    app.expense_categories (name, kind)
  values
    (v_name, p_kind)
  returning
    id into v_id;

  return v_id;
end;
$$;

revoke all on function app.add_expense_category (text, text)
from
  public,
  anon;

grant
execute on function app.add_expense_category (text, text) to authenticated,
service_role;

create function app.rename_expense_category (p_id uuid, p_name text) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_name text;
  v_found uuid;
begin
  perform app.assert_expense_write_allowed ();

  v_name := btrim(coalesce(p_name, ''));

  if v_name = '' then
    raise exception 'expense category name is required'
      using errcode = '22023';
  end if;

  if char_length(v_name) > 80 then
    raise exception 'expense category name is too long'
      using errcode = '22023';
  end if;

  perform app.assert_no_phone_text (v_name);

  update app.expense_categories
  set
    name = v_name
  where
    id = p_id
  returning
    id into v_found;

  if v_found is null then
    raise exception 'unknown expense category'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function app.rename_expense_category (uuid, text)
from
  public,
  anon;

grant
execute on function app.rename_expense_category (uuid, text) to authenticated,
service_role;

create function app.set_expense_category_active (p_id uuid, p_active boolean) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_found uuid;
begin
  perform app.assert_expense_write_allowed ();

  if p_active is null then
    raise exception 'active is required'
      using errcode = '22023';
  end if;

  update app.expense_categories
  set
    active = p_active
  where
    id = p_id
  returning
    id into v_found;

  if v_found is null then
    raise exception 'unknown expense category'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function app.set_expense_category_active (uuid, boolean)
from
  public,
  anon;

grant
execute on function app.set_expense_category_active (uuid, boolean) to authenticated,
service_role;

create function app.add_expense_entry (
  p_category_id uuid,
  p_amount numeric default null,
  p_period_month date default null,
  p_expense_date date default null,
  p_paid_on date default null,
  p_is_estimate boolean default null,
  p_note text default null,
  p_hours numeric default null,
  p_hourly_rate numeric default null,
  p_driver_label text default null,
  -- Last, because PostgreSQL requires every argument after a default to have
  -- one too. Null is rejected below; the web always sends the draft id.
  p_request_id uuid default null
) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_kind text;
  v_amount numeric;
  v_note text;
  v_label text;
  v_existing app.expense_entries;
  v_id uuid;
begin
  perform app.assert_expense_write_allowed ();

  if p_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  -- Scale is rejected here because numeric(14,2) would round it on the way in.
  -- This does not read the category. Driver pay still ignores p_amount.
  if p_amount is not null then
    if p_amount = 'NaN'::numeric
    or p_amount <> pg_catalog.round(p_amount, 2) then
      raise exception 'amount must have at most 2 decimal places'
        using errcode = '22023';
    end if;

    if pg_catalog.abs(p_amount) > 999999999999.99 then
      raise exception 'amount is too large'
        using errcode = '22023';
    end if;

    v_amount := p_amount;
  else
    v_amount := null;
  end if;

  if p_hours is not null then
    if p_hours = 'NaN'::numeric
    or p_hours <> pg_catalog.round(p_hours, 2) then
      raise exception 'hours must have at most 2 decimal places'
        using errcode = '22023';
    end if;

    if pg_catalog.abs(p_hours) > 9999.99 then
      raise exception 'hours are too large'
        using errcode = '22023';
    end if;
  end if;

  if p_hourly_rate is not null then
    if p_hourly_rate = 'NaN'::numeric
    or p_hourly_rate <> pg_catalog.round(p_hourly_rate, 2) then
      raise exception 'hourly rate must have at most 2 decimal places'
        using errcode = '22023';
    end if;

    if pg_catalog.abs(p_hourly_rate) > 999999999999.99 then
      raise exception 'hourly rate is too large'
        using errcode = '22023';
    end if;
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');

  if v_note is not null
  and char_length(v_note) > 500 then
    raise exception 'note is too long'
      using errcode = '22023';
  end if;

  v_label := nullif(btrim(coalesce(p_driver_label, '')), '');

  if v_label is not null
  and char_length(v_label) > 40 then
    raise exception 'driver label is too long'
      using errcode = '22023';
  end if;

  perform app.assert_no_phone_text (v_note);
  perform app.assert_no_phone_text (v_label);

  -- Replay before any category lookup. A later rename or deactivation must
  -- still return the row that this request already posted.
  select
    *
  into
    v_existing
  from
    app.expense_entries entry
  where
    entry.request_id = p_request_id;

  if found then
    if v_existing.voids_id is null
    and v_existing.category_id is not distinct from p_category_id
    and v_existing.period_month is not distinct from p_period_month
    and v_existing.expense_date is not distinct from p_expense_date
    and v_existing.paid_on is not distinct from p_paid_on
    and v_existing.is_estimate is not distinct from p_is_estimate
    and v_existing.note is not distinct from v_note
    and v_existing.hours is not distinct from p_hours
    and v_existing.hourly_rate is not distinct from p_hourly_rate
    and v_existing.driver_label is not distinct from v_label
    and (
      (
        v_existing.hours is not null
        and v_existing.amount = pg_catalog.round(
          v_existing.hours * v_existing.hourly_rate,
          2
        )
      )
      or (
        v_existing.hours is null
        and v_existing.amount is not distinct from v_amount
      )
    ) then
      return v_existing.id;
    end if;

    raise exception 'request_id already used for a different expense'
      using errcode = '22023';
  end if;

  select
    category.kind
  into
    v_kind
  from
    app.expense_categories category
  where
    category.id = p_category_id;

  if v_kind = 'driver_hours' then
    v_amount := null;

    if p_hours is not null
    and p_hourly_rate is not null
    and p_hours > 0
    and p_hourly_rate > 0
    and pg_catalog.round(p_hours * p_hourly_rate, 2) > 999999999999.99 then
      raise exception 'driver amount is too large'
        using errcode = '22023';
    end if;
  end if;

  insert into
    app.expense_entries (
      request_id,
      category_id,
      amount,
      period_month,
      expense_date,
      paid_on,
      is_estimate,
      note,
      hours,
      hourly_rate,
      driver_label,
      created_by
    )
  values
    (
      p_request_id,
      p_category_id,
      v_amount,
      p_period_month,
      p_expense_date,
      p_paid_on,
      p_is_estimate,
      v_note,
      p_hours,
      p_hourly_rate,
      v_label,
      auth.uid ()
    )
  returning
    id into v_id;

  return v_id;
end;
$$;

comment on function app.add_expense_entry (
  uuid,
  numeric,
  date,
  date,
  date,
  boolean,
  text,
  numeric,
  numeric,
  text,
  uuid
) is 'Posts one expense. The same request_id and normalized payload returns the saved id. Driver amount is computed by the validate trigger and the client amount is discarded.';

revoke all on function app.add_expense_entry (
  uuid,
  numeric,
  date,
  date,
  date,
  boolean,
  text,
  numeric,
  numeric,
  text,
  uuid
)
from
  public,
  anon;

grant
execute on function app.add_expense_entry (
  uuid,
  numeric,
  date,
  date,
  date,
  boolean,
  text,
  numeric,
  numeric,
  text,
  uuid
) to authenticated,
service_role;

create function app.void_expense_entry (p_id uuid, p_reason text, p_request_id uuid) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_reason text;
  v_existing app.expense_entries;
  v_id uuid;
begin
  perform app.assert_expense_write_allowed ();

  if p_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  if p_id is null then
    raise exception 'unknown expense entry'
      using errcode = '22023';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  if v_reason is null then
    raise exception 'void reason is required'
      using errcode = '22023';
  end if;

  if char_length(v_reason) > 500 then
    raise exception 'void reason is too long'
      using errcode = '22023';
  end if;

  perform app.assert_no_phone_text (v_reason);

  -- Same request, same target, and same reason returns the void already
  -- stored. A different target or reason is refused. The target is not read
  -- until this request id is new, so a retry does not fail as "already voided".
  select
    *
  into
    v_existing
  from
    app.expense_entries entry
  where
    entry.request_id = p_request_id;

  if found then
    if v_existing.voids_id is not distinct from p_id
    and v_existing.void_reason is not distinct from v_reason
    and v_existing.category_id is null then
      return v_existing.id;
    end if;

    raise exception 'request_id already used for a different expense'
      using errcode = '22023';
  end if;

  insert into
    app.expense_entries (request_id, voids_id, void_reason, created_by)
  values
    (p_request_id, p_id, v_reason, auth.uid ())
  returning
    id into v_id;

  return v_id;
end;
$$;

comment on function app.void_expense_entry (uuid, text, uuid) is 'Appends a void marker. The same request_id, target, and reason returns the existing void and does not insert another row.';

revoke all on function app.void_expense_entry (uuid, text, uuid)
from
  public,
  anon;

grant
execute on function app.void_expense_entry (uuid, text, uuid) to authenticated,
service_role;

create function app.set_month_expense_complete (p_month date, p_complete boolean) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_user uuid;
begin
  perform app.assert_expense_write_allowed ();

  if p_month is null
  or p_month <> pg_catalog.date_trunc('month', p_month::timestamp)::date then
    raise exception 'month must be the first day of the month'
      using errcode = '22023';
  end if;

  if p_month < date '1990-01-01'
  or p_month > date '2100-12-01' then
    raise exception 'date is out of range'
      using errcode = '22023';
  end if;

  if p_complete is null then
    raise exception 'complete is required'
      using errcode = '22023';
  end if;

  v_user := auth.uid ();

  if p_complete
  and v_user is null then
    raise exception 'confirmed_by is required'
      using errcode = '22023';
  end if;

  insert into
    app.month_expense_status (month, complete, confirmed_at, confirmed_by)
  values
    (
      p_month,
      p_complete,
      case
        when p_complete then pg_catalog.now()
        else null
      end,
      case
        when p_complete then v_user
        else null
      end
    )
  on conflict (month) do update
  set
    complete = excluded.complete,
    confirmed_at = excluded.confirmed_at,
    confirmed_by = excluded.confirmed_by;
end;
$$;

comment on function app.set_month_expense_complete (date, boolean) is 'Marks or unmarks a month as مصاريفه كاملة. The caller sends the new boolean; this does not flip the stored value.';

revoke all on function app.set_month_expense_complete (date, boolean)
from
  public,
  anon;

grant
execute on function app.set_month_expense_complete (date, boolean) to authenticated,
service_role;

-- ============================================================================
-- 6. What counts, and the piaster share of one monthly entry
-- ============================================================================
create function app.expense_day_share (
  p_amount numeric,
  p_day_count integer,
  p_day_index integer
) returns numeric language sql immutable security invoker
set
  search_path = '' as $$
  select
    round(
      (
        (p_amount * 100)::bigint / p_day_count
        + case
          when p_day_index <= ((p_amount * 100)::bigint % p_day_count) then 1
          else 0
        end
      )::numeric / 100,
      2
    );
$$;

comment on function app.expense_day_share (numeric, integer, integer) is 'Largest-remainder piaster share for one entry. Day 1 through the remainder get one extra piaster. 1000.00 / 30 is 33.34 on days 1-10 and 33.33 after that.';

revoke all on function app.expense_day_share (numeric, integer, integer)
from
  public,
  anon;

grant
execute on function app.expense_day_share (numeric, integer, integer) to authenticated,
service_role;

create function app.expense_effective () returns table (
  id uuid,
  category_id uuid,
  kind text,
  amount numeric(14, 2),
  period_month date,
  expense_date date,
  is_estimate boolean
) language sql stable security invoker
set
  search_path = '' as $$
  select
    entry.id,
    entry.category_id,
    category.kind,
    entry.amount,
    entry.period_month,
    entry.expense_date,
    entry.is_estimate
  from
    app.expense_entries entry
    join app.expense_categories category on category.id = entry.category_id
  where
    entry.voids_id is null
    and entry.amount is not null
    and not exists (
      select
        1
      from
        app.expense_entries void_row
      where
        void_row.voids_id = entry.id
    )
    and (
      entry.is_estimate = false
      or not exists (
        select
          1
        from
          app.expense_entries actual
        where
          actual.voids_id is null
          and actual.is_estimate = false
          and actual.category_id = entry.category_id
          and actual.period_month is not distinct from entry.period_month
          and actual.expense_date is not distinct from entry.expense_date
          and not exists (
            select
              1
            from
              app.expense_entries void_actual
            where
              void_actual.voids_id = actual.id
          )
      )
    );
$$;

comment on function app.expense_effective () is 'Entries that count today. Security invoker, so RLS applies. Estimates drop out while a live actual exists for the same category and period; they are not voided.';

revoke all on function app.expense_effective ()
from
  public,
  anon;

grant
execute on function app.expense_effective () to authenticated,
service_role;

create function app.expense_daily (p_from date, p_to date) returns table (
  "date" date,
  fixed_share numeric,
  daily_total numeric,
  driver_total numeric,
  interest numeric,
  depreciation numeric,
  total numeric
) language plpgsql stable security invoker
set
  search_path = '' as $$
begin
  if p_from is null
  or p_to is null
  or p_to < p_from then
    raise exception 'date range is invalid'
      using errcode = '22023';
  end if;

  if p_to - p_from > 366 then
    raise exception 'date range is too long'
      using errcode = '22023';
  end if;

  return query
  with
    months as (
      select
        series.month_start::date as month_start
      from
        pg_catalog.generate_series(
          pg_catalog.date_trunc('month', p_from::timestamp),
          pg_catalog.date_trunc('month', p_to::timestamp),
          interval '1 month'
        ) as series (month_start)
    ),
    days as (
      select
        series.day_value::date as day
      from
        pg_catalog.generate_series(
          p_from::timestamp,
          p_to::timestamp,
          interval '1 day'
        ) as series (day_value)
    ),
    effective as (
      select
        counted.kind,
        counted.amount,
        counted.period_month,
        counted.expense_date
      from
        app.expense_effective () counted
    ),
    monthly as (
      select
        effective.kind,
        effective.amount,
        effective.period_month,
        (
          (
            effective.period_month + interval '1 month' - interval '1 day'
          )::date - effective.period_month + 1
        )::integer as day_count
      from
        effective
      where
        effective.kind in ('fixed_monthly', 'interest', 'depreciation')
        and effective.period_month in (
          select
            months.month_start
          from
            months
        )
    ),
    shares as (
      select
        (monthly.period_month + (series.day_index - 1))::date as day,
        monthly.kind,
        app.expense_day_share(
          monthly.amount,
          monthly.day_count,
          series.day_index
        ) as share
      from
        monthly
        cross join lateral pg_catalog.generate_series(1, monthly.day_count) as series (day_index)
    ),
    monthly_days as (
      select
        shares.day,
        round(
          coalesce(
            sum(shares.share) filter (
              where
                shares.kind = 'fixed_monthly'
            ),
            0
          ),
          2
        ) as fixed_share,
        round(
          coalesce(
            sum(shares.share) filter (
              where
                shares.kind = 'interest'
            ),
            0
          ),
          2
        ) as interest,
        round(
          coalesce(
            sum(shares.share) filter (
              where
                shares.kind = 'depreciation'
            ),
            0
          ),
          2
        ) as depreciation
      from
        shares
      group by
        shares.day
    ),
    daily_days as (
      select
        effective.expense_date as day,
        round(
          coalesce(
            sum(effective.amount) filter (
              where
                effective.kind = 'daily'
            ),
            0
          ),
          2
        ) as daily_total,
        round(
          coalesce(
            sum(effective.amount) filter (
              where
                effective.kind = 'driver_hours'
            ),
            0
          ),
          2
        ) as driver_total
      from
        effective
      where
        effective.kind in ('daily', 'driver_hours')
        and effective.expense_date between p_from and p_to
      group by
        effective.expense_date
    )
  select
    days.day as "date",
    round(coalesce(monthly_days.fixed_share, 0), 2) as fixed_share,
    round(coalesce(daily_days.daily_total, 0), 2) as daily_total,
    round(coalesce(daily_days.driver_total, 0), 2) as driver_total,
    round(coalesce(monthly_days.interest, 0), 2) as interest,
    round(coalesce(monthly_days.depreciation, 0), 2) as depreciation,
    round(
      coalesce(monthly_days.fixed_share, 0) + coalesce(daily_days.daily_total, 0) + coalesce(daily_days.driver_total, 0) + coalesce(monthly_days.interest, 0) + coalesce(monthly_days.depreciation, 0),
      2
    ) as total
  from
    days
    left join monthly_days on monthly_days.day = days.day
    left join daily_days on daily_days.day = days.day
  order by
    days.day;
end;
$$;

comment on function app.expense_daily (date, date) is 'Expense per Cairo date. Security invoker. Monthly kinds are spread with expense_day_share over the whole month, then clipped to the requested dates. Does not read POS shifts.';

revoke all on function app.expense_daily (date, date)
from
  public,
  anon;

grant
execute on function app.expense_daily (date, date) to authenticated,
service_role;

create function app.expense_month_check (p_month date) returns table (
  days_total numeric,
  entries_total numeric,
  balanced boolean
) language plpgsql stable security invoker
set
  search_path = '' as $$
declare
  v_end date;
  v_days numeric;
  v_entries numeric;
begin
  if p_month is null
  or p_month <> pg_catalog.date_trunc('month', p_month::timestamp)::date then
    raise exception 'month must be the first day of the month'
      using errcode = '22023';
  end if;

  if p_month < date '1990-01-01'
  or p_month > date '2100-12-01' then
    raise exception 'date is out of range'
      using errcode = '22023';
  end if;

  v_end := (p_month + interval '1 month' - interval '1 day')::date;

  select
    round(coalesce(sum(day_row.total), 0), 2)
  into
    v_days
  from
    app.expense_daily (p_month, v_end) day_row;

  select
    round(coalesce(sum(entry.amount), 0), 2)
  into
    v_entries
  from
    app.expense_effective () entry
  where
    (
      entry.kind in ('fixed_monthly', 'interest', 'depreciation')
      and entry.period_month = p_month
    )
    or (
      entry.kind in ('daily', 'driver_hours')
      and entry.expense_date between p_month and v_end
    );

  return query
  select
    v_days,
    v_entries,
    v_days = v_entries;
end;
$$;

comment on function app.expense_month_check (date) is 'Per-month check that the sum of daily totals equals the sum of effective entries, including fixed, interest, depreciation, daily, and driver pay.';

revoke all on function app.expense_month_check (date)
from
  public,
  anon;

grant
execute on function app.expense_month_check (date) to authenticated,
service_role;

-- ============================================================================
-- 7. One list row per expense, with the void that points at it.
-- ============================================================================
create view app.expense_lines
with
  (security_invoker = true) as
select
  entry.id,
  entry.category_id,
  category.name as category_name,
  category.kind as category_kind,
  entry.amount,
  entry.period_month,
  entry.expense_date,
  entry.paid_on,
  entry.is_estimate,
  entry.note,
  entry.hours,
  entry.hourly_rate,
  entry.driver_label,
  entry.created_at,
  void_row.id as void_id,
  void_row.void_reason,
  void_row.created_at as voided_at
from
  app.expense_entries entry
  join app.expense_categories category on category.id = entry.category_id
  left join app.expense_entries void_row on void_row.voids_id = entry.id
where
  entry.voids_id is null;

comment on view app.expense_lines is 'Non-void expense rows plus the void marker, if one exists. security_invoker so RLS on the base tables applies.';

revoke all on table app.expense_lines
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.expense_lines to authenticated,
  service_role;
