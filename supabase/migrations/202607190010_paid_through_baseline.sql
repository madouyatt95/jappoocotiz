-- La situation « à jour jusqu'à » est une référence administrative.
-- Elle déduit les mensualités réglées depuis le début choisi sans créer de
-- paiement en espèces ni modifier le solde réel de la caisse.

begin;

alter table public.member_fund_schedules
  add column if not exists paid_through_month date;

alter table public.member_fund_schedules
  drop constraint if exists member_fund_schedules_paid_through_check;
alter table public.member_fund_schedules
  add constraint member_fund_schedules_paid_through_check check (
    paid_through_month is null
    or (
      paid_through_month = date_trunc('month', paid_through_month)::date
      and paid_through_month >= start_month
    )
  );

alter table public.contribution_periods
  add column if not exists administrative_paid boolean not null default false;

drop function if exists public.record_cash_payment_through_month(uuid, uuid, uuid, date, date, date, text);

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
  if target_fund.id is null then raise exception 'Caisse introuvable'; end if;

  insert into public.contribution_periods(
    family_id, fund_id, member_id, period_start, due_date,
    amount_due, amount_paid, status, created_by
  )
  select
    member.family_id,
    target_fund.id,
    member.id,
    month_value::date,
    make_date(extract(year from month_value)::integer, extract(month from month_value)::integer, target_fund.due_day),
    target_fund.monthly_amount,
    0,
    case
      when latest_exception.action = 'exempt' then 'exempt'
      when latest_exception.action in ('suspend', 'leave') then 'cancelled'
      when make_date(extract(year from month_value)::integer, extract(month from month_value)::integer, target_fund.due_day) < current_date then 'late'
      else 'due'
    end,
    actor_user_id
  from public.member_fund_schedules schedule
  join public.family_members member
    on member.id = schedule.member_id and member.family_id = schedule.family_id
  cross join lateral generate_series(
    greatest(date '2021-01-01', target_fund.start_date, schedule.start_month),
    least(
      greatest(
        schedule.end_month,
        coalesce(schedule.paid_through_month, schedule.end_month),
        date_trunc('month', current_date)::date
      ),
      date_trunc('month', current_date + interval '10 years')::date
    ),
    interval '1 month'
  ) month_value
  left join lateral (
    select fund_exception.action
    from public.member_fund_exceptions fund_exception
    where fund_exception.member_id = member.id
      and fund_exception.fund_id = target_fund.id
      and (
        (fund_exception.action = 'leave' and month_value::date >= fund_exception.start_month)
        or
        (fund_exception.action <> 'leave' and month_value::date between fund_exception.start_month and coalesce(fund_exception.end_month, fund_exception.start_month))
      )
    order by fund_exception.created_at desc
    limit 1
  ) latest_exception on true
  where schedule.fund_id = target_fund.id
    and schedule.family_id = target_fund.family_id
    and schedule.active
    and member.active
    and member.approval_status = 'approved'
    and target_fund.active
  on conflict (member_id, fund_id, period_start) do update set
    due_date = excluded.due_date,
    amount_due = case
      when public.contribution_periods.amount_paid = 0 then excluded.amount_due
      else public.contribution_periods.amount_due
    end,
    status = case
      when excluded.status in ('exempt', 'cancelled') then excluded.status
      when public.contribution_periods.administrative_paid then 'paid'
      when public.contribution_periods.amount_paid >= public.contribution_periods.amount_due then 'paid'
      when public.contribution_periods.amount_paid > 0 then 'partial'
      when excluded.due_date < current_date then 'late'
      else 'due'
    end;

  get diagnostics affected = row_count;

  -- Quand la référence recule, le montant réellement encaissé est conservé.
  -- Seule la part administrative est retirée.
  with actuals as (
    select
      period.id,
      least(
        period.amount_due,
        coalesce(sum(allocation.amount) filter (where payment.reversed_at is null), 0)
      ) as actual_paid
    from public.contribution_periods period
    left join public.cash_payment_allocations allocation on allocation.period_id = period.id
    left join public.cash_payments payment on payment.id = allocation.payment_id
    where period.fund_id = target_fund.id
    group by period.id, period.amount_due
  )
  update public.contribution_periods period
  set
    amount_paid = actuals.actual_paid,
    administrative_paid = false,
    status = case
      when period.status in ('exempt', 'cancelled') then period.status
      when actuals.actual_paid >= period.amount_due then 'paid'
      when actuals.actual_paid > 0 then 'partial'
      when period.due_date < current_date then 'late'
      else 'due'
    end
  from public.member_fund_schedules schedule, actuals
  where period.id = actuals.id
    and schedule.member_id = period.member_id
    and schedule.fund_id = period.fund_id
    and period.administrative_paid
    and (
      schedule.paid_through_month is null
      or period.period_start < schedule.start_month
      or period.period_start > schedule.paid_through_month
      or period.status in ('exempt', 'cancelled')
    );

  -- Tous les mois applicables jusqu'à la référence sont considérés réglés.
  -- Le montant versé affiché est ainsi déduit automatiquement depuis 2021.
  update public.contribution_periods period
  set
    amount_paid = period.amount_due,
    administrative_paid = true,
    status = 'paid'
  from public.member_fund_schedules schedule
  where schedule.member_id = period.member_id
    and schedule.fund_id = period.fund_id
    and schedule.active
    and schedule.paid_through_month is not null
    and period.period_start between schedule.start_month and schedule.paid_through_month
    and period.status not in ('exempt', 'cancelled');

  return affected;
end;
$$;

create or replace function public.set_member_paid_through(
  p_member_id uuid,
  p_fund_id uuid,
  p_start_month date,
  p_paid_through_month date
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
  normalized_paid_through date;
  current_month date := date_trunc('month', current_date)::date;
  result public.member_fund_schedules;
begin
  select * into target_member from public.family_members where id = p_member_id for update;
  select * into target_fund from public.funds where id = p_fund_id;

  if target_member.id is null or target_fund.id is null
    or target_member.family_id <> target_fund.family_id then
    raise exception 'Membre ou caisse introuvable';
  end if;
  if not public.can_manage_family(target_member.family_id) then
    raise exception 'Seul un administrateur peut définir la situation à jour';
  end if;
  if not target_member.active or target_member.approval_status <> 'approved' then
    raise exception 'Ce membre n’est pas actif';
  end if;
  if not target_fund.active then raise exception 'Cette caisse n’est pas active'; end if;
  if p_start_month is null or p_paid_through_month is null then
    raise exception 'Le mois de début et le mois à jour sont obligatoires';
  end if;

  normalized_start := date_trunc('month', p_start_month)::date;
  normalized_paid_through := date_trunc('month', p_paid_through_month)::date;
  if normalized_start < greatest(date '2021-01-01', date_trunc('month', target_fund.start_date)::date) then
    raise exception 'Le début ne peut pas précéder le début de la caisse';
  end if;
  if normalized_paid_through < normalized_start then
    raise exception 'Le mois à jour doit suivre le mois de début';
  end if;
  if normalized_paid_through > date_trunc('month', current_date + interval '10 years')::date then
    raise exception 'Le mois à jour ne peut pas dépasser dix ans après le mois courant';
  end if;

  insert into public.member_fund_schedules(
    family_id, member_id, fund_id, start_month, end_month, paid_through_month,
    active, created_by, updated_by
  ) values (
    target_member.family_id, target_member.id, target_fund.id,
    normalized_start, greatest(current_month, normalized_paid_through), normalized_paid_through,
    true, auth.uid(), auth.uid()
  )
  on conflict (member_id, fund_id) do update set
    start_month = excluded.start_month,
    end_month = excluded.end_month,
    paid_through_month = excluded.paid_through_month,
    active = true,
    updated_by = auth.uid()
  returning * into result;

  update public.contribution_periods period
  set
    amount_paid = 0,
    administrative_paid = false,
    status = 'cancelled'
  where period.member_id = target_member.id
    and period.fund_id = target_fund.id
    and period.period_start < normalized_start
    and not exists (
      select 1
      from public.cash_payment_allocations allocation
      join public.cash_payments payment on payment.id = allocation.payment_id
      where allocation.period_id = period.id and payment.reversed_at is null
    );

  perform public.sync_fund_periods(target_fund.id, auth.uid());
  select * into result from public.member_fund_schedules
  where member_id = target_member.id and fund_id = target_fund.id;
  return result;
end;
$$;

create or replace function public.reverse_cash_payment(payment_id uuid, reason text)
returns public.cash_payments
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  target public.cash_payments;
  balance_after numeric(12,2);
begin
  if reason is null or length(trim(reason)) not between 3 and 160 then raise exception 'Un motif de 3 à 160 caractères est requis'; end if;
  select * into target from public.cash_payments where id = payment_id for update;
  if target.id is null then raise exception 'Paiement introuvable'; end if;
  if not public.can_manage_family(target.family_id) then raise exception 'Seul un administrateur peut annuler un paiement'; end if;
  if target.reversed_at is not null then raise exception 'Paiement déjà annulé'; end if;

  perform 1 from public.funds where id = target.fund_id and family_id = target.family_id for update;
  select
    coalesce((select sum(amount) from public.cash_payments where family_id = target.family_id and fund_id = target.fund_id and reversed_at is null and id <> target.id), 0)
    - coalesce((select sum(amount) from public.cash_expenses where family_id = target.family_id and fund_id = target.fund_id and status in ('approved', 'pending')), 0)
  into balance_after;
  if balance_after < 0 then raise exception 'Ce paiement ne peut pas être annulé car une partie du solde est dépensée ou réservée'; end if;

  update public.cash_payments set
    reversed_at = now(), reversed_by = auth.uid(), reversal_reason = trim(reason)
  where id = payment_id returning * into target;

  with affected_periods as (
    select distinct allocation.period_id
    from public.cash_payment_allocations allocation
    where allocation.payment_id = target.id
  ), actuals as (
    select
      period.id,
      least(
        period.amount_due,
        coalesce(sum(allocation.amount) filter (where payment.reversed_at is null), 0)
      ) as actual_paid
    from public.contribution_periods period
    join affected_periods affected on affected.period_id = period.id
    left join public.cash_payment_allocations allocation on allocation.period_id = period.id
    left join public.cash_payments payment on payment.id = allocation.payment_id
    group by period.id, period.amount_due
  )
  update public.contribution_periods period set
    amount_paid = case when period.administrative_paid then period.amount_due else actuals.actual_paid end,
    status = case
      when period.status in ('exempt', 'cancelled') then period.status
      when period.administrative_paid or actuals.actual_paid >= period.amount_due then 'paid'
      when actuals.actual_paid > 0 then 'partial'
      when period.due_date < current_date then 'late'
      else 'due'
    end
  from actuals
  where period.id = actuals.id;

  perform public.log_admin_event(
    target.family_id, 'payment_reversed', 'cash_payment', target.id::text,
    'Paiement annulé avec conservation de la trace',
    jsonb_build_object('fund_id', target.fund_id, 'amount', target.amount, 'reason', trim(reason))
  );
  return target;
end;
$$;

create or replace function public.audit_schedule_change()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if tg_op = 'INSERT'
    or old.start_month is distinct from new.start_month
    or old.end_month is distinct from new.end_month
    or old.paid_through_month is distinct from new.paid_through_month
    or old.active is distinct from new.active then
    perform public.log_admin_event(
      new.family_id, 'member_schedule_updated', 'member_fund_schedule', new.id::text,
      'Situation « à jour jusqu’à » modifiée',
      jsonb_build_object(
        'member_id', new.member_id,
        'fund_id', new.fund_id,
        'start_month', new.start_month,
        'paid_through_month', new.paid_through_month,
        'active', new.active
      )
    );
  end if;
  return new;
end;
$$;

revoke all on function public.sync_fund_periods(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_member_paid_through(uuid, uuid, date, date) from public, anon;
revoke all on function public.reverse_cash_payment(uuid, text) from public, anon;
grant execute on function public.set_member_paid_through(uuid, uuid, date, date) to authenticated;
grant execute on function public.reverse_cash_payment(uuid, text) to authenticated;

commit;
