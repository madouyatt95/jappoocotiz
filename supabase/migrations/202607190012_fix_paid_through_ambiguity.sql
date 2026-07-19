-- Corrige l’ambiguïté entre la variable PL/pgSQL « payment » et l’alias SQL
-- du même nom dans l’encaissement « à jour jusqu’à ».

begin;

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
#variable_conflict use_column
declare
  target_member public.family_members;
  target_fund public.funds;
  normalized_start date;
  normalized_paid_through date;
  current_month date := date_trunc('month', current_date)::date;
  result public.member_fund_schedules;
  recorded_payment public.cash_payments;
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

  with actuals as (
    select
      period.id,
      least(
        period.amount_due,
        coalesce(sum(allocation.amount) filter (where cash_entry.reversed_at is null), 0)
      ) as actual_paid
    from public.contribution_periods period
    left join public.cash_payment_allocations allocation on allocation.period_id = period.id
    left join public.cash_payments cash_entry on cash_entry.id = allocation.payment_id
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
    ) into recorded_payment;
  end if;

  return jsonb_build_object(
    'ok', true,
    'schedule_id', result.id,
    'payment_id', recorded_payment.id,
    'amount_recorded', amount_to_record,
    'fund_id', target_fund.id,
    'paid_through_month', normalized_paid_through
  );
end;
$$;

revoke all on function public.record_paid_through_movement(uuid, uuid, date, date) from public, anon;
grant execute on function public.record_paid_through_movement(uuid, uuid, date, date) to authenticated;

commit;
