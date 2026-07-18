-- Annulation traçable des paiements et abonnements Web Push par appareil.

begin;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  member_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_member_fk foreign key (member_id, family_id)
    references public.family_members(id, family_id) on delete cascade,
  constraint push_subscriptions_endpoint_check check (
    endpoint like 'https://%'
    and length(endpoint) <= 2000
    and length(p256dh) between 20 and 300
    and length(auth_key) between 8 and 200
    and (user_agent is null or length(user_agent) <= 300)
  )
);

create index if not exists push_subscriptions_member_idx
  on public.push_subscriptions(member_id, updated_at desc);

create table if not exists public.cash_expenses (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  fund_id uuid not null,
  amount numeric(12,2) not null check (amount > 0),
  reason text not null check (length(trim(reason)) between 3 and 160),
  expense_date date not null default current_date,
  spent_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint cash_expenses_fund_family_fk foreign key (fund_id, family_id)
    references public.funds(id, family_id) on delete restrict
);

create index if not exists cash_expenses_family_fund_idx
  on public.cash_expenses(family_id, fund_id, expense_date desc, created_at desc);

drop trigger if exists push_subscriptions_touch_updated_at on public.push_subscriptions;
create trigger push_subscriptions_touch_updated_at
before update on public.push_subscriptions
for each row execute function public.touch_updated_at();

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;

alter table public.cash_expenses enable row level security;
revoke all on public.cash_expenses from public, anon, authenticated;
grant select on public.cash_expenses to authenticated;

drop policy if exists cash_expenses_select_scope on public.cash_expenses;
create policy cash_expenses_select_scope on public.cash_expenses
for select to authenticated using (public.can_record_fund(family_id, fund_id));

create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth_key text,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  member public.family_members;
  subscription public.push_subscriptions;
begin
  select * into member
  from public.family_members
  where user_id = auth.uid()
    and active
    and approval_status = 'approved'
  order by created_at
  limit 1;

  if member.id is null then raise exception 'Accès familial approuvé requis'; end if;
  if p_endpoint is null or p_endpoint not like 'https://%' or length(p_endpoint) > 2000 then
    raise exception 'Abonnement push invalide';
  end if;
  if length(coalesce(p_p256dh, '')) not between 20 and 300
    or length(coalesce(p_auth_key, '')) not between 8 and 200 then
    raise exception 'Clés push invalides';
  end if;

  insert into public.push_subscriptions(
    family_id, member_id, user_id, endpoint, p256dh, auth_key, user_agent
  ) values (
    member.family_id, member.id, auth.uid(), trim(p_endpoint),
    trim(p_p256dh), trim(p_auth_key), left(nullif(trim(p_user_agent), ''), 300)
  )
  on conflict (endpoint) do update set
    family_id = excluded.family_id,
    member_id = excluded.member_id,
    user_id = excluded.user_id,
    p256dh = excluded.p256dh,
    auth_key = excluded.auth_key,
    user_agent = excluded.user_agent
  returning * into subscription;

  return jsonb_build_object('ok', true, 'subscription_id', subscription.id);
end;
$$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  deleted_count integer := 0;
begin
  delete from public.push_subscriptions
  where endpoint = p_endpoint and user_id = auth.uid();
  get diagnostics deleted_count = row_count;
  return jsonb_build_object('ok', true, 'deleted', deleted_count);
end;
$$;

create or replace function public.record_cash_expense(
  p_family_id uuid,
  p_fund_id uuid,
  p_amount numeric,
  p_expense_date date,
  p_reason text
)
returns public.cash_expenses
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  target_fund public.funds;
  expense public.cash_expenses;
  collected numeric(12,2);
  spent numeric(12,2);
  available numeric(12,2);
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Montant invalide'; end if;
  if p_expense_date is null or p_expense_date > current_date then
    raise exception 'La date de dépense ne peut pas être dans le futur';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 or length(trim(p_reason)) > 160 then
    raise exception 'Un motif de 3 à 160 caractères est requis';
  end if;

  select * into target_fund
  from public.funds
  where id = p_fund_id and family_id = p_family_id and active
  for update;
  if target_fund.id is null then raise exception 'Caisse introuvable ou inactive'; end if;
  if not public.can_record_fund(p_family_id, p_fund_id) then
    raise exception 'Vous n’avez pas le droit de dépenser sur cette caisse';
  end if;

  select coalesce(sum(amount), 0) into collected
  from public.cash_payments
  where family_id = p_family_id and fund_id = p_fund_id and reversed_at is null;

  select coalesce(sum(amount), 0) into spent
  from public.cash_expenses
  where family_id = p_family_id and fund_id = p_fund_id;

  available := collected - spent;
  if p_amount > available then
    raise exception 'Solde insuffisant : % € disponibles', available;
  end if;

  insert into public.cash_expenses(
    family_id, fund_id, amount, reason, expense_date, spent_by
  ) values (
    p_family_id, p_fund_id, p_amount, trim(p_reason), p_expense_date, auth.uid()
  ) returning * into expense;

  return expense;
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
  if reason is null or length(trim(reason)) < 3 or length(trim(reason)) > 160 then
    raise exception 'Un motif de 3 à 160 caractères est requis';
  end if;

  select * into target
  from public.cash_payments
  where id = payment_id
  for update;

  if target.id is null then raise exception 'Paiement introuvable'; end if;
  if not public.can_manage_family(target.family_id) then
    raise exception 'Seul un administrateur peut annuler un paiement';
  end if;
  if target.reversed_at is not null then raise exception 'Paiement déjà annulé'; end if;

  perform 1
  from public.funds
  where id = target.fund_id and family_id = target.family_id
  for update;

  select
    coalesce((select sum(amount) from public.cash_payments
      where family_id = target.family_id and fund_id = target.fund_id
        and reversed_at is null and id <> target.id), 0)
    - coalesce((select sum(amount) from public.cash_expenses
      where family_id = target.family_id and fund_id = target.fund_id), 0)
  into balance_after;
  if balance_after < 0 then
    raise exception 'Ce paiement ne peut pas être annulé car une partie du solde a déjà été dépensée';
  end if;

  update public.contribution_periods period
  set
    amount_paid = greatest(0, period.amount_paid - allocation.total_amount),
    status = case
      when greatest(0, period.amount_paid - allocation.total_amount) >= period.amount_due then 'paid'
      when greatest(0, period.amount_paid - allocation.total_amount) > 0 then 'partial'
      when period.due_date < current_date then 'late'
      else 'due'
    end
  from (
    select period_id, sum(amount) as total_amount
    from public.cash_payment_allocations
    where payment_id = target.id
    group by period_id
  ) allocation
  where period.id = allocation.period_id;

  update public.cash_payments
  set
    reversed_at = now(),
    reversed_by = auth.uid(),
    reversal_reason = trim(reason)
  where id = payment_id
  returning * into target;

  return target;
end;
$$;

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
    movement.payment_id,
    movement.family_id,
    movement.fund_id,
    movement.fund_name,
    movement.member_name,
    movement.amount,
    movement.method,
    movement.payment_date,
    movement.created_at,
    movement.reversed_at,
    movement.reversal_reason,
    movement.recorded_by_name,
    movement.reversed_by_name
  from (
    select
      payment.id as payment_id,
      payment.family_id,
      payment.fund_id,
      fund.name as fund_name,
      case when public.can_record_fund(p_family_id, payment.fund_id) then member.full_name else null end as member_name,
      payment.amount,
      payment.method,
      payment.payment_date,
      payment.created_at,
      payment.reversed_at,
      payment.reversal_reason,
      case when public.can_record_fund(p_family_id, payment.fund_id) then coalesce(recorder.full_name, 'Responsable habilité') else null end as recorded_by_name,
      case when public.can_record_fund(p_family_id, payment.fund_id) then coalesce(reverser.full_name, 'Responsable habilité') else null end as reversed_by_name,
      coalesce(payment.reversed_at, payment.created_at) as sort_at
    from public.cash_payments payment
    join public.funds fund on fund.id = payment.fund_id
    join public.family_members member on member.id = payment.member_id
    left join public.profiles recorder on recorder.user_id = payment.recorded_by
    left join public.profiles reverser on reverser.user_id = payment.reversed_by
    where payment.family_id = p_family_id

    union all

    select
      expense.id as payment_id,
      expense.family_id,
      expense.fund_id,
      fund.name as fund_name,
      null::text as member_name,
      expense.amount,
      'expense'::text as method,
      expense.expense_date as payment_date,
      expense.created_at,
      null::timestamptz as reversed_at,
      expense.reason as reversal_reason,
      case when public.can_record_fund(p_family_id, expense.fund_id) then coalesce(spender.full_name, 'Responsable habilité') else null end as recorded_by_name,
      null::text as reversed_by_name,
      expense.created_at as sort_at
    from public.cash_expenses expense
    join public.funds fund on fund.id = expense.fund_id
    left join public.profiles spender on spender.user_id = expense.spent_by
    where expense.family_id = p_family_id
  ) movement
  order by movement.sort_at desc;
end;
$$;

revoke all on function public.register_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.remove_push_subscription(text) from public, anon;
revoke all on function public.record_cash_expense(uuid, uuid, numeric, date, text) from public, anon;
revoke all on function public.reverse_cash_payment(uuid, text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;
grant execute on function public.record_cash_expense(uuid, uuid, numeric, date, text) to authenticated;
grant execute on function public.reverse_cash_payment(uuid, text) to authenticated;

commit;
