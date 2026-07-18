-- Plages de mensualités par membre et par caisse.
-- Les responsables habilités peuvent reconstituer les échéances depuis janvier 2021
-- sans écraser les paiements déjà ventilés.

begin;

alter table public.family_members
  add column if not exists write_fund_codes text[] not null default '{}'::text[];

update public.family_members
set write_fund_codes = case
  when role = 'admin' then array['family', 'death']::text[]
  when access_level = 'write' then array['family', 'death']::text[]
  else '{}'::text[]
end
where write_fund_codes is distinct from case
  when role = 'admin' then array['family', 'death']::text[]
  when access_level = 'write' then array['family', 'death']::text[]
  else '{}'::text[]
end;

alter table public.family_members
  drop constraint if exists family_members_write_fund_codes_check;
alter table public.family_members
  add constraint family_members_write_fund_codes_check check (
    write_fund_codes <@ array['family', 'death']::text[]
    and cardinality(write_fund_codes) <= 2
  );

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
    from public.family_members member
    where member.family_id = target_family_id
      and member.user_id = auth.uid()
      and member.active
      and member.approval_status = 'approved'
      and member.access_level = 'write'
      and member.role in ('admin', 'treasurer', 'cash_collector')
      and (member.role = 'admin' or cardinality(member.write_fund_codes) > 0)
  );
$$;

create or replace function public.can_record_fund(target_family_id uuid, target_fund_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1
    from public.family_members member
    join public.funds fund
      on fund.id = target_fund_id and fund.family_id = member.family_id
    where member.family_id = target_family_id
      and member.user_id = auth.uid()
      and member.active
      and member.approval_status = 'approved'
      and member.access_level = 'write'
      and member.role in ('admin', 'treasurer', 'cash_collector')
      and (member.role = 'admin' or fund.code = any(member.write_fund_codes))
  );
$$;

drop function if exists public.review_member_access(uuid, text, text);
create or replace function public.review_member_access(
  p_member_id uuid,
  p_decision text,
  p_access_level text default 'read',
  p_write_fund_codes text[] default '{}'::text[]
)
returns public.family_members
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  target public.family_members;
  normalized_codes text[];
begin
  if p_decision not in ('approve', 'reject') then raise exception 'Décision invalide'; end if;
  if p_access_level not in ('read', 'write') then raise exception 'Niveau d’accès invalide'; end if;

  select coalesce(array_agg(distinct code order by code), '{}'::text[])
  into normalized_codes
  from unnest(coalesce(p_write_fund_codes, '{}'::text[])) code
  where code in ('family', 'death');

  if p_access_level = 'write' and cardinality(normalized_codes) = 0 then
    raise exception 'Choisissez au moins une caisse pour le droit d’écriture';
  end if;
  if cardinality(normalized_codes) <> cardinality(coalesce(p_write_fund_codes, '{}'::text[])) then
    raise exception 'Caisse autorisée invalide';
  end if;

  select * into target from public.family_members where id = p_member_id for update;
  if target.id is null then raise exception 'Compte introuvable'; end if;
  if not public.can_manage_family(target.family_id) then raise exception 'Autorisation administrateur requise'; end if;
  if target.role = 'admin' and target.approval_status = 'approved' then
    raise exception 'Les droits d’un administrateur ne peuvent pas être modifiés ici';
  end if;

  if p_decision = 'approve' then
    update public.family_members
    set
      approval_status = 'approved',
      access_level = p_access_level,
      write_fund_codes = case when p_access_level = 'write' then normalized_codes else '{}'::text[] end,
      role = case when p_access_level = 'write' then 'cash_collector' else 'member' end,
      active = true,
      reviewed_at = now(),
      reviewed_by = auth.uid()
    where id = p_member_id
    returning * into target;
  else
    update public.family_members
    set
      approval_status = 'rejected',
      access_level = 'read',
      write_fund_codes = '{}'::text[],
      role = 'member',
      active = false,
      reviewed_at = now(),
      reviewed_by = auth.uid()
    where id = p_member_id
    returning * into target;
  end if;
  return target;
end;
$$;

create table if not exists public.member_fund_schedules (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  member_id uuid not null,
  fund_id uuid not null,
  start_month date not null,
  end_month date not null,
  active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_fund_schedules_months_check check (
    start_month = date_trunc('month', start_month)::date
    and end_month = date_trunc('month', end_month)::date
    and start_month >= date '2021-01-01'
    and end_month >= start_month
  ),
  constraint member_fund_schedules_member_fk foreign key (member_id, family_id)
    references public.family_members(id, family_id) on delete cascade,
  constraint member_fund_schedules_fund_fk foreign key (fund_id, family_id)
    references public.funds(id, family_id) on delete cascade,
  unique (member_id, fund_id)
);

create index if not exists member_fund_schedules_family_idx
  on public.member_fund_schedules(family_id, member_id);

drop trigger if exists member_fund_schedules_touch_updated_at on public.member_fund_schedules;
create trigger member_fund_schedules_touch_updated_at
before update on public.member_fund_schedules
for each row execute function public.touch_updated_at();

insert into public.member_fund_schedules(
  family_id, member_id, fund_id, start_month, end_month, active
)
select
  member.family_id,
  member.id,
  fund.id,
  date_trunc('month', greatest(fund.start_date, member.joined_on))::date,
  date_trunc('month', current_date)::date,
  true
from public.family_members member
join public.funds fund on fund.family_id = member.family_id and fund.active
where member.active
  and member.approval_status = 'approved'
on conflict (member_id, fund_id) do nothing;

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
  from public.member_fund_schedules schedule
  join public.family_members member
    on member.id = schedule.member_id and member.family_id = schedule.family_id
  cross join lateral generate_series(
    greatest(target_fund.start_date, schedule.start_month),
    least(schedule.end_month, date_trunc('month', current_date)::date),
    interval '1 month'
  ) as month_value
  where schedule.fund_id = target_fund.id
    and schedule.family_id = target_fund.family_id
    and schedule.active
    and member.active
    and member.approval_status = 'approved'
    and target_fund.active
  on conflict (member_id, fund_id, period_start) do update
  set
    due_date = excluded.due_date,
    amount_due = case
      when public.contribution_periods.amount_paid = 0 then excluded.amount_due
      else public.contribution_periods.amount_due
    end,
    status = case
      when public.contribution_periods.status = 'exempt' then 'exempt'
      when public.contribution_periods.amount_paid >= public.contribution_periods.amount_due then 'paid'
      when public.contribution_periods.amount_paid > 0 then 'partial'
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
  fund_record public.funds;
begin
  if new.active and new.approval_status = 'approved' then
    for fund_record in
      select * from public.funds where family_id = new.family_id and active
    loop
      insert into public.member_fund_schedules(
        family_id, member_id, fund_id, start_month, end_month, active,
        created_by, updated_by
      ) values (
        new.family_id,
        new.id,
        fund_record.id,
        date_trunc('month', greatest(fund_record.start_date, new.joined_on))::date,
        date_trunc('month', current_date)::date,
        true,
        auth.uid(),
        auth.uid()
      ) on conflict (member_id, fund_id) do nothing;

      perform public.sync_fund_periods(fund_record.id, coalesce(auth.uid(), new.user_id));
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists family_members_sync_schedule on public.family_members;
create trigger family_members_sync_schedule
after insert or update of joined_on, active, approval_status on public.family_members
for each row execute function public.handle_member_schedule();

create or replace function public.set_member_fund_schedule(
  p_member_id uuid,
  p_fund_id uuid,
  p_start_month date,
  p_end_month date
)
returns public.member_fund_schedules
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  target_member public.family_members;
  target_fund public.funds;
  normalized_start date;
  normalized_end date;
  result public.member_fund_schedules;
begin
  select * into target_member from public.family_members where id = p_member_id;
  select * into target_fund from public.funds where id = p_fund_id;

  if target_member.id is null or target_fund.id is null
    or target_member.family_id <> target_fund.family_id then
    raise exception 'Membre ou caisse introuvable';
  end if;
  if not public.can_record_fund(target_member.family_id, target_fund.id) then
    raise exception 'Autorisation insuffisante';
  end if;
  if not target_member.active or target_member.approval_status <> 'approved' then
    raise exception 'Ce membre n’est pas actif';
  end if;
  if p_start_month is null or p_end_month is null then
    raise exception 'Les mois de début et de fin sont obligatoires';
  end if;

  normalized_start := date_trunc('month', p_start_month)::date;
  normalized_end := date_trunc('month', p_end_month)::date;
  if normalized_start < greatest(date '2021-01-01', date_trunc('month', target_fund.start_date)::date) then
    raise exception 'Le début ne peut pas précéder janvier 2021 ou le début de la caisse';
  end if;
  if normalized_end < normalized_start then
    raise exception 'Le mois de fin doit suivre le mois de début';
  end if;
  if normalized_end > date_trunc('month', current_date)::date then
    raise exception 'Le mois de fin ne peut pas dépasser le mois courant';
  end if;

  insert into public.member_fund_schedules(
    family_id, member_id, fund_id, start_month, end_month, active,
    created_by, updated_by
  ) values (
    target_member.family_id, target_member.id, target_fund.id,
    normalized_start, normalized_end, true, auth.uid(), auth.uid()
  )
  on conflict (member_id, fund_id) do update set
    start_month = excluded.start_month,
    end_month = excluded.end_month,
    active = true,
    updated_by = auth.uid()
  returning * into result;

  update public.contribution_periods
  set status = 'cancelled'
  where member_id = target_member.id
    and fund_id = target_fund.id
    and amount_paid = 0
    and (period_start < normalized_start or period_start > normalized_end);

  perform public.sync_fund_periods(target_fund.id, auth.uid());
  return result;
end;
$$;

revoke all on function public.set_member_fund_schedule(uuid, uuid, date, date) from public, anon;
grant execute on function public.set_member_fund_schedule(uuid, uuid, date, date) to authenticated;
revoke all on function public.can_record_fund(uuid, uuid) from public, anon;
grant execute on function public.can_record_fund(uuid, uuid) to authenticated;
revoke all on function public.review_member_access(uuid, text, text, text[]) from public, anon;
grant execute on function public.review_member_access(uuid, text, text, text[]) to authenticated;

create or replace function public.enforce_cash_payment_fund_scope()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if not public.can_record_fund(new.family_id, new.fund_id) then
    raise exception 'Vous n’avez pas le droit d’écriture sur cette caisse';
  end if;
  return new;
end;
$$;

drop trigger if exists cash_payments_fund_scope on public.cash_payments;
create trigger cash_payments_fund_scope
before insert on public.cash_payments
for each row execute function public.enforce_cash_payment_fund_scope();

revoke all on function public.enforce_cash_payment_fund_scope() from public, anon, authenticated;

create or replace function public.list_payment_activity(p_family_id uuid)
returns table (
  payment_id uuid,
  family_id uuid,
  fund_id uuid,
  fund_name text,
  member_name text,
  amount numeric,
  method text,
  payment_date date,
  created_at timestamptz,
  reversed_at timestamptz,
  reversal_reason text,
  recorded_by_name text,
  reversed_by_name text
)
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
begin
  if not public.is_family_member(p_family_id) then
    raise exception 'Accès familial non approuvé';
  end if;

  return query
  select
    payment.id,
    payment.family_id,
    payment.fund_id,
    fund.name,
    case when public.can_record_fund(p_family_id, payment.fund_id) then member.full_name else null end,
    payment.amount,
    payment.method,
    payment.payment_date,
    payment.created_at,
    payment.reversed_at,
    payment.reversal_reason,
    case when public.can_record_fund(p_family_id, payment.fund_id) then coalesce(recorder.full_name, 'Responsable habilité') else null end,
    case when public.can_record_fund(p_family_id, payment.fund_id) then coalesce(reverser.full_name, 'Responsable habilité') else null end
  from public.cash_payments payment
  join public.funds fund on fund.id = payment.fund_id
  join public.family_members member on member.id = payment.member_id
  left join public.profiles recorder on recorder.user_id = payment.recorded_by
  left join public.profiles reverser on reverser.user_id = payment.reversed_by
  where payment.family_id = p_family_id
  order by coalesce(payment.reversed_at, payment.created_at) desc;
end;
$$;

alter table public.member_fund_schedules enable row level security;
revoke all on public.member_fund_schedules from anon;
revoke all on public.member_fund_schedules from authenticated;
grant select on public.member_fund_schedules to authenticated;

drop policy if exists member_fund_schedules_select_scope on public.member_fund_schedules;
create policy member_fund_schedules_select_scope on public.member_fund_schedules
for select to authenticated using (
  public.can_record_fund(family_id, fund_id)
  or exists (
    select 1 from public.family_members member
    where member.id = member_id
      and member.user_id = auth.uid()
      and member.active
      and member.approval_status = 'approved'
  )
);

drop policy if exists contribution_periods_select_scope on public.contribution_periods;
create policy contribution_periods_select_scope on public.contribution_periods
for select to authenticated using (
  public.can_record_fund(family_id, fund_id)
  or exists (
    select 1 from public.family_members member
    where member.id = member_id and member.user_id = auth.uid() and member.active
  )
);

drop policy if exists cash_payments_select_scope on public.cash_payments;
create policy cash_payments_select_scope on public.cash_payments
for select to authenticated using (
  public.can_record_fund(family_id, fund_id)
  or exists (
    select 1 from public.family_members member
    where member.id = member_id and member.user_id = auth.uid() and member.active
  )
);

drop policy if exists cash_payment_allocations_select_scope on public.cash_payment_allocations;
create policy cash_payment_allocations_select_scope on public.cash_payment_allocations
for select to authenticated using (
  public.can_record_fund(family_id, fund_id)
  or exists (
    select 1 from public.family_members member
    where member.id = member_id and member.user_id = auth.uid() and member.active
  )
);

commit;
