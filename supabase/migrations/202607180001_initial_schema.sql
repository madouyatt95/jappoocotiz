-- Jàppoo Cotiz — socle de production sans données de démonstration.
-- Deux caisses seulement, paiements en espèces et contrôle des accès par RLS.

create extension if not exists pgcrypto;

create table if not exists public.family_spaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.family_spaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  full_name text not null check (length(trim(full_name)) between 2 and 120),
  role text not null default 'member' check (role in ('admin', 'treasurer', 'cash_collector', 'member')),
  branch text,
  country text,
  joined_on date not null default date '2021-01-01',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, family_id)
);

create unique index if not exists family_members_family_user_unique
  on public.family_members(family_id, user_id)
  where user_id is not null;

create index if not exists family_members_user_idx on public.family_members(user_id);
create index if not exists family_members_family_idx on public.family_members(family_id);

create table if not exists public.funds (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.family_spaces(id) on delete cascade,
  code text not null check (code in ('family', 'death')),
  name text not null,
  description text,
  monthly_amount numeric(12,2) not null default 5 check (monthly_amount > 0),
  frequency text not null default 'monthly' check (frequency = 'monthly'),
  start_date date not null default date '2021-01-01',
  due_day smallint not null default 10 check (due_day between 1 and 28),
  display_order smallint not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (family_id, code),
  unique (id, family_id)
);

create table if not exists public.contribution_periods (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  fund_id uuid not null,
  member_id uuid not null,
  period_start date not null,
  due_date date,
  amount_due numeric(12,2) not null default 0 check (amount_due >= 0),
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0 and amount_paid <= amount_due),
  status text not null default 'due' check (status in ('upcoming', 'due', 'late', 'exempt', 'cancelled')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contribution_periods_fund_family_fk foreign key (fund_id, family_id)
    references public.funds(id, family_id) on delete cascade,
  constraint contribution_periods_member_family_fk foreign key (member_id, family_id)
    references public.family_members(id, family_id) on delete cascade,
  unique (member_id, fund_id, period_start),
  unique (id, family_id, fund_id, member_id)
);

create index if not exists contribution_periods_member_idx
  on public.contribution_periods(member_id, period_start desc);

create table if not exists public.cash_payments (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  fund_id uuid not null,
  member_id uuid not null,
  contribution_period_id uuid,
  amount numeric(12,2) not null check (amount > 0),
  method text not null default 'cash' check (method = 'cash'),
  payment_date date not null default current_date,
  period_start date not null,
  note text check (note is null or length(note) <= 160),
  recorded_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id),
  reversal_reason text,
  constraint cash_payments_fund_family_fk foreign key (fund_id, family_id)
    references public.funds(id, family_id) on delete restrict,
  constraint cash_payments_member_family_fk foreign key (member_id, family_id)
    references public.family_members(id, family_id) on delete restrict,
  constraint cash_payments_period_scope_fk foreign key (contribution_period_id, family_id, fund_id, member_id)
    references public.contribution_periods(id, family_id, fund_id, member_id) on delete restrict,
  constraint cash_payments_reversal_complete check (
    (reversed_at is null and reversed_by is null and reversal_reason is null)
    or
    (reversed_at is not null and reversed_by is not null and length(trim(reversal_reason)) >= 3)
  ),
  unique (id, family_id, fund_id, member_id)
);

create index if not exists cash_payments_member_idx
  on public.cash_payments(member_id, payment_date desc)
  where reversed_at is null;
create index if not exists cash_payments_family_idx
  on public.cash_payments(family_id, payment_date desc)
  where reversed_at is null;

create table if not exists public.cash_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null,
  period_id uuid not null,
  family_id uuid not null,
  fund_id uuid not null,
  member_id uuid not null,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  constraint cash_payment_allocations_payment_scope_fk foreign key (payment_id, family_id, fund_id, member_id)
    references public.cash_payments(id, family_id, fund_id, member_id) on delete restrict,
  constraint cash_payment_allocations_period_scope_fk foreign key (period_id, family_id, fund_id, member_id)
    references public.contribution_periods(id, family_id, fund_id, member_id) on delete restrict,
  unique (payment_id, period_id)
);

create index if not exists cash_payment_allocations_period_idx
  on public.cash_payment_allocations(period_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists family_spaces_touch_updated_at on public.family_spaces;
create trigger family_spaces_touch_updated_at before update on public.family_spaces
for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists family_members_touch_updated_at on public.family_members;
create trigger family_members_touch_updated_at before update on public.family_members
for each row execute function public.touch_updated_at();

drop trigger if exists funds_touch_updated_at on public.funds;
create trigger funds_touch_updated_at before update on public.funds
for each row execute function public.touch_updated_at();

drop trigger if exists contribution_periods_touch_updated_at on public.contribution_periods;
create trigger contribution_periods_touch_updated_at before update on public.contribution_periods
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles(user_id, full_name)
  values (new.id, nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

insert into public.profiles(user_id, full_name)
select id, nullif(trim(raw_user_meta_data ->> 'full_name'), '')
from auth.users
on conflict (user_id) do nothing;

create or replace function public.is_family_member(target_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1
    from public.family_members fm
    where fm.family_id = target_family_id
      and fm.user_id = auth.uid()
      and fm.active
  );
$$;

create or replace function public.can_record_cash(target_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1
    from public.family_members fm
    where fm.family_id = target_family_id
      and fm.user_id = auth.uid()
      and fm.active
      and fm.role in ('admin', 'treasurer', 'cash_collector')
  );
$$;

create or replace function public.can_manage_family(target_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1
    from public.family_members fm
    where fm.family_id = target_family_id
      and fm.user_id = auth.uid()
      and fm.active
      and fm.role = 'admin'
  );
$$;

create or replace function public.can_reverse_cash(target_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1
    from public.family_members fm
    where fm.family_id = target_family_id
      and fm.user_id = auth.uid()
      and fm.active
      and fm.role in ('admin', 'treasurer')
  );
$$;

create or replace function public.sync_fund_periods(target_fund_id uuid, actor_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  target_fund public.funds;
  affected integer := 0;
begin
  select * into target_fund from public.funds where id = target_fund_id;
  if target_fund.id is null then
    raise exception 'Caisse introuvable';
  end if;

  insert into public.contribution_periods(
    family_id, fund_id, member_id, period_start, due_date,
    amount_due, amount_paid, status, created_by
  )
  select
    member.family_id,
    target_fund.id,
    member.id,
    month_value::date,
    make_date(
      extract(year from month_value)::integer,
      extract(month from month_value)::integer,
      target_fund.due_day
    ),
    target_fund.monthly_amount,
    0,
    case
      when make_date(
        extract(year from month_value)::integer,
        extract(month from month_value)::integer,
        target_fund.due_day
      ) < current_date then 'late'
      else 'due'
    end,
    actor_user_id
  from public.family_members member
  cross join lateral generate_series(
    date_trunc('month', greatest(target_fund.start_date, member.joined_on))::date,
    date_trunc('month', current_date)::date,
    interval '1 month'
  ) as month_value
  where member.family_id = target_fund.family_id
    and member.active
    and target_fund.active
  on conflict (member_id, fund_id, period_start) do update
  set
    due_date = excluded.due_date,
    amount_due = case
      when public.contribution_periods.amount_paid = 0 then excluded.amount_due
      else public.contribution_periods.amount_due
    end,
    status = case
      when public.contribution_periods.status in ('exempt', 'cancelled') then public.contribution_periods.status
      when excluded.due_date < current_date
        and public.contribution_periods.amount_paid < public.contribution_periods.amount_due then 'late'
      else 'due'
    end;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.handle_member_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  fund_record record;
begin
  if new.active then
    for fund_record in
      select id from public.funds where family_id = new.family_id and active
    loop
      perform public.sync_fund_periods(fund_record.id, coalesce(auth.uid(), new.user_id));
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists family_members_sync_schedule on public.family_members;
create trigger family_members_sync_schedule
after insert or update of joined_on, active on public.family_members
for each row execute function public.handle_member_schedule();

create or replace function public.configure_fund(
  p_fund_id uuid,
  p_name text,
  p_description text,
  p_monthly_amount numeric,
  p_start_date date,
  p_due_day integer
)
returns public.funds
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  target public.funds;
begin
  select * into target from public.funds where id = p_fund_id for update;
  if target.id is null then raise exception 'Caisse introuvable'; end if;
  if not public.can_manage_family(target.family_id) then raise exception 'Autorisation insuffisante'; end if;
  if p_name is null or length(trim(p_name)) < 3 then raise exception 'Nom de caisse invalide'; end if;
  if p_monthly_amount is null or p_monthly_amount <= 0 then raise exception 'Montant mensuel invalide'; end if;
  if p_start_date is null or p_start_date > current_date then raise exception 'Date de début invalide'; end if;
  if p_due_day not between 1 and 28 then raise exception 'Jour d’échéance invalide'; end if;

  update public.funds
  set
    name = trim(p_name),
    description = nullif(trim(p_description), ''),
    monthly_amount = p_monthly_amount,
    start_date = date_trunc('month', p_start_date)::date,
    due_day = p_due_day
  where id = p_fund_id
  returning * into target;

  perform public.sync_fund_periods(target.id, auth.uid());
  return target;
end;
$$;

create or replace function public.record_cash_payment(
  p_family_id uuid,
  p_fund_id uuid,
  p_member_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_note text default null
)
returns public.cash_payments
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  target_fund public.funds;
  target_member public.family_members;
  first_period public.contribution_periods;
  pending_period public.contribution_periods;
  payment public.cash_payments;
  outstanding numeric(12,2);
  remaining numeric(12,2);
  allocated numeric(12,2);
begin
  if not public.can_record_cash(p_family_id) then raise exception 'Autorisation insuffisante'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Montant invalide'; end if;
  if p_payment_date is null or p_payment_date > current_date then raise exception 'Date de paiement invalide'; end if;
  if p_note is not null and length(p_note) > 160 then raise exception 'Note trop longue'; end if;

  select * into target_fund
  from public.funds
  where id = p_fund_id and family_id = p_family_id and active
  for update;
  if target_fund.id is null then raise exception 'Caisse introuvable ou inactive'; end if;

  select * into target_member
  from public.family_members
  where id = p_member_id and family_id = p_family_id and active
  for update;
  if target_member.id is null then raise exception 'Membre introuvable ou inactif'; end if;

  perform public.sync_fund_periods(target_fund.id, auth.uid());

  select coalesce(sum(amount_due - amount_paid), 0) into outstanding
  from public.contribution_periods
  where fund_id = p_fund_id
    and member_id = p_member_id
    and status not in ('exempt', 'cancelled')
    and amount_paid < amount_due;

  if outstanding <= 0 then raise exception 'Ce membre est déjà à jour pour cette caisse'; end if;
  if p_amount > outstanding then
    raise exception 'Le montant dépasse le reste à payer de %', outstanding;
  end if;

  select * into first_period
  from public.contribution_periods
  where fund_id = p_fund_id
    and member_id = p_member_id
    and status not in ('exempt', 'cancelled')
    and amount_paid < amount_due
  order by period_start
  limit 1;

  insert into public.cash_payments(
    family_id, fund_id, member_id, contribution_period_id,
    amount, method, payment_date, period_start, note, recorded_by
  ) values (
    p_family_id, p_fund_id, p_member_id, first_period.id,
    p_amount, 'cash', p_payment_date, first_period.period_start,
    nullif(trim(p_note), ''), auth.uid()
  ) returning * into payment;

  remaining := p_amount;
  for pending_period in
    select *
    from public.contribution_periods
    where fund_id = p_fund_id
      and member_id = p_member_id
      and status not in ('exempt', 'cancelled')
      and amount_paid < amount_due
    order by period_start
    for update
  loop
    exit when remaining <= 0;
    allocated := least(remaining, pending_period.amount_due - pending_period.amount_paid);

    update public.contribution_periods
    set amount_paid = amount_paid + allocated
    where id = pending_period.id;

    insert into public.cash_payment_allocations(
      payment_id, period_id, family_id, fund_id, member_id, amount
    ) values (
      payment.id, pending_period.id, p_family_id, p_fund_id, p_member_id, allocated
    );
    remaining := remaining - allocated;
  end loop;

  if remaining <> 0 then raise exception 'Allocation du paiement incomplète'; end if;
  return payment;
end;
$$;

revoke all on function public.is_family_member(uuid) from public, anon;
revoke all on function public.can_record_cash(uuid) from public, anon;
revoke all on function public.can_manage_family(uuid) from public, anon;
revoke all on function public.can_reverse_cash(uuid) from public, anon;
grant execute on function public.is_family_member(uuid) to authenticated;
grant execute on function public.can_record_cash(uuid) to authenticated;
grant execute on function public.can_manage_family(uuid) to authenticated;
grant execute on function public.can_reverse_cash(uuid) to authenticated;
revoke all on function public.sync_fund_periods(uuid, uuid) from public, anon, authenticated;
revoke all on function public.handle_member_schedule() from public, anon, authenticated;
revoke all on function public.configure_fund(uuid, text, text, numeric, date, integer) from public, anon;
revoke all on function public.record_cash_payment(uuid, uuid, uuid, numeric, date, text) from public, anon;
grant execute on function public.configure_fund(uuid, text, text, numeric, date, integer) to authenticated;
grant execute on function public.record_cash_payment(uuid, uuid, uuid, numeric, date, text) to authenticated;

alter table public.family_spaces enable row level security;
alter table public.profiles enable row level security;
alter table public.family_members enable row level security;
alter table public.funds enable row level security;
alter table public.contribution_periods enable row level security;
alter table public.cash_payments enable row level security;
alter table public.cash_payment_allocations enable row level security;

revoke all on public.family_spaces, public.profiles, public.family_members, public.funds,
  public.contribution_periods, public.cash_payments, public.cash_payment_allocations from anon;
revoke all on public.family_spaces, public.profiles, public.family_members, public.funds,
  public.contribution_periods, public.cash_payments, public.cash_payment_allocations from authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop policy if exists family_spaces_select_member on public.family_spaces;
create policy family_spaces_select_member on public.family_spaces
for select to authenticated using (public.is_family_member(id));

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
for select to authenticated using (user_id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists family_members_select_scope on public.family_members;
create policy family_members_select_scope on public.family_members
for select to authenticated using (
  user_id = auth.uid() or public.can_record_cash(family_id)
);

drop policy if exists family_members_insert_admin on public.family_members;
create policy family_members_insert_admin on public.family_members
for insert to authenticated with check (public.can_manage_family(family_id));

drop policy if exists family_members_update_admin on public.family_members;
create policy family_members_update_admin on public.family_members
for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));

drop policy if exists funds_select_member on public.funds;
create policy funds_select_member on public.funds
for select to authenticated using (public.is_family_member(family_id));

drop policy if exists funds_manage_admin on public.funds;

drop policy if exists contribution_periods_select_scope on public.contribution_periods;
create policy contribution_periods_select_scope on public.contribution_periods
for select to authenticated using (
  public.can_record_cash(family_id)
  or exists (
    select 1 from public.family_members fm
    where fm.id = member_id and fm.user_id = auth.uid() and fm.active
  )
);

drop policy if exists contribution_periods_manage_admin on public.contribution_periods;
drop policy if exists contribution_periods_insert_admin on public.contribution_periods;
create policy contribution_periods_insert_admin on public.contribution_periods
for insert to authenticated with check (
  public.can_manage_family(family_id) and created_by = auth.uid()
);

drop policy if exists contribution_periods_update_admin on public.contribution_periods;
create policy contribution_periods_update_admin on public.contribution_periods
for update to authenticated using (public.can_manage_family(family_id)) with check (
  public.can_manage_family(family_id)
);

drop policy if exists cash_payments_select_scope on public.cash_payments;
create policy cash_payments_select_scope on public.cash_payments
for select to authenticated using (
  public.can_record_cash(family_id)
  or exists (
    select 1 from public.family_members fm
    where fm.id = member_id and fm.user_id = auth.uid() and fm.active
  )
);

drop policy if exists cash_payments_insert_authorized on public.cash_payments;

drop policy if exists cash_payment_allocations_select_scope on public.cash_payment_allocations;
create policy cash_payment_allocations_select_scope on public.cash_payment_allocations
for select to authenticated using (
  public.can_record_cash(family_id)
  or exists (
    select 1 from public.family_members fm
    where fm.id = member_id and fm.user_id = auth.uid() and fm.active
  )
);

-- Aucun UPDATE ou DELETE direct n'est autorisé sur les paiements.
create or replace function public.reverse_cash_payment(payment_id uuid, reason text)
returns public.cash_payments
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  target public.cash_payments;
begin
  if reason is null or length(trim(reason)) < 3 then
    raise exception 'Un motif de trois caractères minimum est requis';
  end if;

  select * into target
  from public.cash_payments
  where id = payment_id
  for update;

  if target.id is null then
    raise exception 'Paiement introuvable';
  end if;
  if not public.can_reverse_cash(target.family_id) then
    raise exception 'Autorisation insuffisante';
  end if;
  if target.reversed_at is not null then
    raise exception 'Paiement déjà annulé';
  end if;

  update public.contribution_periods period
  set amount_paid = greatest(0, period.amount_paid - allocation.total_amount)
  from (
    select period_id, sum(amount) as total_amount
    from public.cash_payment_allocations
    where payment_id = target.id
    group by period_id
  ) allocation
  where period.id = allocation.period_id;

  update public.cash_payments
  set reversed_at = now(), reversed_by = auth.uid(), reversal_reason = trim(reason)
  where id = payment_id
  returning * into target;

  return target;
end;
$$;

revoke all on function public.reverse_cash_payment(uuid, text) from public, anon;
grant execute on function public.reverse_cash_payment(uuid, text) to authenticated;

grant usage on schema public to authenticated;
grant select on public.family_spaces, public.funds to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.family_members to authenticated;
grant select, insert, update on public.contribution_periods to authenticated;
grant select on public.cash_payments, public.cash_payment_allocations to authenticated;

insert into public.family_spaces(slug, name, currency)
values ('ma-famille', 'Ma famille', 'EUR')
on conflict (slug) do update set name = excluded.name, currency = excluded.currency;

insert into public.funds(
  family_id, code, name, description, monthly_amount,
  frequency, start_date, due_day, display_order, active
)
select
  fs.id, seed.code, seed.name, seed.description, 5,
  'monthly', date '2021-01-01', 10, seed.display_order, true
from public.family_spaces fs
cross join (
  values
    ('family', 'Caisse famille', 'Cotisation familiale mensuelle', 1),
    ('death', 'Caisse décès', 'Fonds de solidarité mensuel', 2)
) as seed(code, name, description, display_order)
where fs.slug = 'ma-famille'
on conflict (family_id, code) do update
set
  name = excluded.name,
  description = excluded.description,
  monthly_amount = excluded.monthly_amount,
  frequency = excluded.frequency,
  start_date = excluded.start_date,
  due_day = excluded.due_day,
  display_order = excluded.display_order,
  active = true;

select public.sync_fund_periods(id, null)
from public.funds
where active;
