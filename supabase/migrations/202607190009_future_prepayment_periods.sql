-- Paiement anticipé : un administrateur peut prolonger la période d'un membre
-- jusqu'à un mois futur, puis enregistrer un paiement en espèces traçable.

begin;

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
  join public.family_members member on member.id = schedule.member_id and member.family_id = schedule.family_id
  cross join lateral generate_series(
    greatest(date '2021-01-01', target_fund.start_date, schedule.start_month),
    least(schedule.end_month, date_trunc('month', current_date + interval '10 years')::date),
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
    amount_due = case when public.contribution_periods.amount_paid = 0 then excluded.amount_due else public.contribution_periods.amount_due end,
    status = case
      when excluded.status in ('exempt', 'cancelled') then excluded.status
      when public.contribution_periods.amount_paid >= public.contribution_periods.amount_due then 'paid'
      when public.contribution_periods.amount_paid > 0 then 'partial'
      when excluded.due_date < current_date then 'late'
      else 'due'
    end;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

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
  select * into target_member from public.family_members where id = p_member_id for update;
  select * into target_fund from public.funds where id = p_fund_id;

  if target_member.id is null or target_fund.id is null
    or target_member.family_id <> target_fund.family_id then
    raise exception 'Membre ou caisse introuvable';
  end if;
  if not public.can_manage_family(target_member.family_id) then
    raise exception 'Seul un administrateur peut définir les mensualités dues';
  end if;
  if not target_member.active or target_member.approval_status <> 'approved' then
    raise exception 'Ce membre n’est pas actif';
  end if;
  if p_start_month is null or p_end_month is null then
    raise exception 'Les mois de début et de fin sont obligatoires';
  end if;

  normalized_start := date_trunc('month', p_start_month)::date;
  normalized_end := date_trunc('month', p_end_month)::date;
  if normalized_start < date '2021-01-01' then
    raise exception 'Le début ne peut pas précéder janvier 2021';
  end if;
  if normalized_end < normalized_start then
    raise exception 'Le mois de fin doit suivre le mois de début';
  end if;
  if normalized_end > date_trunc('month', current_date + interval '10 years')::date then
    raise exception 'Le mois de fin ne peut pas dépasser dix ans après le mois courant';
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

create or replace function public.record_cash_payment_through_month(
  p_family_id uuid,
  p_fund_id uuid,
  p_member_id uuid,
  p_start_month date,
  p_end_month date,
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
  outstanding numeric(12,2);
  result public.cash_payments;
begin
  if not public.can_manage_family(p_family_id) then
    raise exception 'Seul un administrateur peut mettre un membre à jour jusqu’à un mois choisi';
  end if;

  perform public.set_member_fund_schedule(
    p_member_id,
    p_fund_id,
    p_start_month,
    p_end_month
  );

  select coalesce(sum(amount_due - amount_paid), 0)
  into outstanding
  from public.contribution_periods
  where family_id = p_family_id
    and fund_id = p_fund_id
    and member_id = p_member_id
    and status not in ('exempt', 'cancelled')
    and amount_paid < amount_due;

  if outstanding <= 0 then
    raise exception 'Ce membre est déjà à jour pour cette caisse jusqu’au mois choisi';
  end if;

  select public.record_cash_payment(
    p_family_id,
    p_fund_id,
    p_member_id,
    outstanding,
    p_payment_date,
    p_note
  ) into result;

  return result;
end;
$$;

revoke all on function public.sync_fund_periods(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_member_fund_schedule(uuid, uuid, date, date) from public, anon;
revoke all on function public.record_cash_payment_through_month(uuid, uuid, uuid, date, date, date, text) from public, anon;
grant execute on function public.set_member_fund_schedule(uuid, uuid, date, date) to authenticated;
grant execute on function public.record_cash_payment_through_month(uuid, uuid, uuid, date, date, date, text) to authenticated;

commit;
