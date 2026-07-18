-- Paiements fiables, périodes rétroactives et suppression administrative complète.

begin;

-- Les fonctions de synchronisation utilisaient déjà ces deux statuts, mais la
-- contrainte initiale les refusait. Cela faisait échouer un paiement dès qu'une
-- échéance déjà payée ou partielle était resynchronisée.
alter table public.contribution_periods
  drop constraint if exists contribution_periods_status_check;
alter table public.contribution_periods
  add constraint contribution_periods_status_check check (
    status in ('upcoming', 'due', 'late', 'partial', 'paid', 'exempt', 'cancelled')
  );

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
    greatest(date '2021-01-01', schedule.start_month),
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
  if not public.can_record_fund(target_member.family_id, target_fund.id) then
    raise exception 'Autorisation insuffisante pour cette caisse';
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
  if p_amount is null or p_amount <= 0 then raise exception 'Montant invalide'; end if;
  if p_payment_date is null or p_payment_date > current_date then raise exception 'La date de paiement ne peut pas être dans le futur'; end if;
  if p_note is not null and length(p_note) > 160 then raise exception 'Note trop longue'; end if;

  select * into target_fund
  from public.funds
  where id = p_fund_id and family_id = p_family_id and active
  for update;
  if target_fund.id is null then raise exception 'Caisse introuvable ou inactive'; end if;
  if not public.can_record_fund(p_family_id, p_fund_id) then
    raise exception 'Vous n’avez pas le droit d’enregistrer un paiement sur cette caisse';
  end if;

  select * into target_member
  from public.family_members
  where id = p_member_id
    and family_id = p_family_id
    and active
    and approval_status = 'approved'
  for update;
  if target_member.id is null then raise exception 'Membre introuvable ou inactif'; end if;

  perform public.sync_fund_periods(target_fund.id, auth.uid());

  select coalesce(sum(amount_due - amount_paid), 0) into outstanding
  from public.contribution_periods
  where fund_id = p_fund_id
    and member_id = p_member_id
    and status not in ('exempt', 'cancelled')
    and amount_paid < amount_due;

  if outstanding <= 0 then
    raise exception 'Aucune mensualité due : définissez d’abord la période de ce membre pour cette caisse';
  end if;
  if p_amount > outstanding then
    raise exception 'Le montant dépasse le reste à payer de % €', outstanding;
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
    set
      amount_paid = amount_paid + allocated,
      status = case
        when amount_paid + allocated >= amount_due then 'paid'
        when amount_paid + allocated > 0 then 'partial'
        when due_date < current_date then 'late'
        else 'due'
      end
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

create or replace function public.delete_family_member(
  p_member_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  target public.family_members;
  deleted_payments integer := 0;
  deleted_periods integer := 0;
begin
  select * into target
  from public.family_members
  where id = p_member_id
  for update;

  if target.id is null then raise exception 'Membre introuvable'; end if;
  if not public.can_manage_family(target.family_id) then
    raise exception 'Autorisation administrateur requise';
  end if;
  if target.role = 'admin' or target.user_id = auth.uid() then
    raise exception 'Le compte administrateur ne peut pas être supprimé';
  end if;
  if lower(trim(coalesce(p_confirmation, ''))) <> lower(trim(target.full_name)) then
    raise exception 'Le nom de confirmation ne correspond pas';
  end if;

  delete from public.cash_payment_allocations
  where member_id = target.id and family_id = target.family_id;

  delete from public.cash_payments
  where member_id = target.id and family_id = target.family_id;
  get diagnostics deleted_payments = row_count;

  delete from public.contribution_periods
  where member_id = target.id and family_id = target.family_id;
  get diagnostics deleted_periods = row_count;

  delete from public.family_members where id = target.id;

  return jsonb_build_object(
    'ok', true,
    'member_name', target.full_name,
    'deleted_payments', deleted_payments,
    'deleted_periods', deleted_periods
  );
end;
$$;

-- Met immédiatement les échéances déjà présentes en cohérence avec la nouvelle
-- contrainte et les plages individuelles, sans toucher aux montants versés.
do $$
declare
  fund_record record;
begin
  for fund_record in select id from public.funds where active
  loop
    perform public.sync_fund_periods(fund_record.id, null);
  end loop;
end;
$$;

revoke all on function public.sync_fund_periods(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_member_fund_schedule(uuid, uuid, date, date) from public, anon;
revoke all on function public.record_cash_payment(uuid, uuid, uuid, numeric, date, text) from public, anon;
revoke all on function public.delete_family_member(uuid, text) from public, anon;
grant execute on function public.set_member_fund_schedule(uuid, uuid, date, date) to authenticated;
grant execute on function public.record_cash_payment(uuid, uuid, uuid, numeric, date, text) to authenticated;
grant execute on function public.delete_family_member(uuid, text) to authenticated;

commit;
