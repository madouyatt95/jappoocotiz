-- « À jour jusqu'à » devient un véritable encaissement : le complément
-- manquant est enregistré dans la caisse et apparaît dans les mouvements.

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
      when public.contribution_periods.amount_paid >= public.contribution_periods.amount_due then 'paid'
      when public.contribution_periods.amount_paid > 0 then 'partial'
      when excluded.due_date < current_date then 'late'
      else 'due'
    end;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Une ancienne référence administrative est convertie au prochain clic de
-- l’administrateur. Le SQL Editor n’a volontairement aucun droit d’encaisser.

drop function if exists public.set_member_paid_through(uuid, uuid, date, date);

create or replace function public.record_paid_through_movement(
  p_member_id uuid,
  p_fund_id uuid,
  p_start_month date,
  p_paid_through_month date
)
returns jsonb
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
  payment public.cash_payments;
  amount_to_record numeric(12,2);
begin
  select * into target_member from public.family_members where id = p_member_id for update;
  select * into target_fund from public.funds where id = p_fund_id;

  if target_member.id is null or target_fund.id is null
    or target_member.family_id <> target_fund.family_id then
    raise exception 'Membre ou caisse introuvable';
  end if;
  if not public.can_manage_family(target_member.family_id) then
    raise exception 'Seul un administrateur peut enregistrer cette mise à jour';
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

  -- Retire l’ancienne estimation administrative et restaure uniquement les
  -- paiements réellement enregistrés avant de calculer le complément.
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
    where period.member_id = target_member.id
      and period.fund_id = target_fund.id
      and period.administrative_paid
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
  from actuals
  where period.id = actuals.id;

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
  set status = 'cancelled'
  where period.member_id = target_member.id
    and period.fund_id = target_fund.id
    and period.period_start < normalized_start;

  perform public.sync_fund_periods(target_fund.id, auth.uid());

  select coalesce(sum(period.amount_due - period.amount_paid), 0)
  into amount_to_record
  from public.contribution_periods period
  where period.member_id = target_member.id
    and period.fund_id = target_fund.id
    and period.period_start between normalized_start and normalized_paid_through
    and period.status not in ('exempt', 'cancelled')
    and period.amount_paid < period.amount_due;

  if amount_to_record > 0 then
    select public.record_cash_payment(
      target_member.family_id,
      target_fund.id,
      target_member.id,
      amount_to_record,
      current_date,
      'Mise à jour jusqu’à ' || to_char(normalized_paid_through, 'MM/YYYY')
    ) into payment;
  end if;

  return jsonb_build_object(
    'ok', true,
    'schedule_id', result.id,
    'payment_id', payment.id,
    'amount_recorded', amount_to_record,
    'fund_id', target_fund.id,
    'paid_through_month', normalized_paid_through
  );
end;
$$;

revoke all on function public.sync_fund_periods(uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_paid_through_movement(uuid, uuid, date, date) from public, anon;
grant execute on function public.record_paid_through_movement(uuid, uuid, date, date) to authenticated;

commit;
