-- Gouvernance des caisses, import historique, exceptions et rapports confidentiels.

begin;

alter table public.funds
  add column if not exists expense_approval_threshold numeric(12,2) not null default 0
  check (expense_approval_threshold >= 0);

alter table public.cash_expenses
  add column if not exists beneficiary text,
  add column if not exists category text not null default 'Autre',
  add column if not exists receipt_path text,
  add column if not exists status text not null default 'approved',
  add column if not exists approved_by uuid references auth.users(id),
  add column if not exists approved_at timestamptz,
  add column if not exists rejected_by uuid references auth.users(id),
  add column if not exists rejected_at timestamptz,
  add column if not exists review_note text;

alter table public.cash_expenses
  drop constraint if exists cash_expenses_status_check,
  drop constraint if exists cash_expenses_beneficiary_check,
  drop constraint if exists cash_expenses_category_check,
  drop constraint if exists cash_expenses_receipt_path_check,
  drop constraint if exists cash_expenses_review_note_check;
alter table public.cash_expenses
  add constraint cash_expenses_status_check check (status in ('pending', 'approved', 'rejected')),
  add constraint cash_expenses_beneficiary_check check (beneficiary is null or length(trim(beneficiary)) between 2 and 120),
  add constraint cash_expenses_category_check check (length(trim(category)) between 2 and 60),
  add constraint cash_expenses_receipt_path_check check (receipt_path is null or length(receipt_path) <= 500),
  add constraint cash_expenses_review_note_check check (review_note is null or length(review_note) <= 160);

update public.cash_expenses
set approved_by = spent_by, approved_at = created_at
where status = 'approved' and approved_at is null;

create table if not exists public.member_fund_exceptions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  member_id uuid not null,
  fund_id uuid not null,
  action text not null check (action in ('exempt', 'suspend', 'resume', 'leave')),
  start_month date not null,
  end_month date,
  note text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint member_fund_exceptions_member_fk foreign key (member_id, family_id)
    references public.family_members(id, family_id) on delete cascade,
  constraint member_fund_exceptions_fund_fk foreign key (fund_id, family_id)
    references public.funds(id, family_id) on delete cascade,
  constraint member_fund_exceptions_range_check check (end_month is null or end_month >= start_month),
  constraint member_fund_exceptions_note_check check (note is null or length(note) <= 160)
);

create index if not exists member_fund_exceptions_scope_idx
  on public.member_fund_exceptions(family_id, member_id, fund_id, created_at desc);

create table if not exists public.admin_audit_events (
  id bigint generated always as identity primary key,
  family_id uuid not null references public.family_spaces(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id text,
  summary text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint admin_audit_events_text_check check (
    length(event_type) between 2 and 80
    and length(entity_type) between 2 and 80
    and length(summary) between 3 and 240
  )
);

create index if not exists admin_audit_events_family_idx
  on public.admin_audit_events(family_id, created_at desc);

create table if not exists public.due_reminder_log (
  id bigint generated always as identity primary key,
  family_id uuid not null references public.family_spaces(id) on delete cascade,
  member_id uuid not null references public.family_members(id) on delete cascade,
  reminder_date date not null,
  reminder_type text not null check (reminder_type in ('late', 'upcoming', 'monthly')),
  sent_count integer not null default 0 check (sent_count >= 0),
  created_at timestamptz not null default now(),
  unique (member_id, reminder_date, reminder_type)
);

alter table public.member_fund_exceptions enable row level security;
alter table public.admin_audit_events enable row level security;
alter table public.due_reminder_log enable row level security;
revoke all on public.member_fund_exceptions, public.admin_audit_events, public.due_reminder_log from public, anon, authenticated;
grant select on public.member_fund_exceptions, public.admin_audit_events to authenticated;

drop policy if exists member_fund_exceptions_admin_select on public.member_fund_exceptions;
create policy member_fund_exceptions_admin_select on public.member_fund_exceptions
for select to authenticated using (public.can_manage_family(family_id));

drop policy if exists admin_audit_events_admin_select on public.admin_audit_events;
create policy admin_audit_events_admin_select on public.admin_audit_events
for select to authenticated using (public.can_manage_family(family_id));

create or replace function public.log_admin_event(
  p_family_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id text,
  p_summary text,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  insert into public.admin_audit_events(
    family_id, actor_user_id, event_type, entity_type, entity_id, summary, details
  ) values (
    p_family_id, auth.uid(), p_event_type, p_entity_type, p_entity_id,
    left(p_summary, 240), coalesce(p_details, '{}'::jsonb)
  );
end;
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
    case when make_date(extract(year from month_value)::integer, extract(month from month_value)::integer, target_fund.due_day) < current_date then 'late' else 'due' end,
    actor_user_id
  from public.member_fund_schedules schedule
  join public.family_members member on member.id = schedule.member_id and member.family_id = schedule.family_id
  cross join lateral generate_series(
    greatest(date '2021-01-01', target_fund.start_date, schedule.start_month),
    least(schedule.end_month, date_trunc('month', current_date)::date),
    interval '1 month'
  ) month_value
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
      when public.contribution_periods.status in ('exempt', 'cancelled') then public.contribution_periods.status
      when public.contribution_periods.amount_paid >= public.contribution_periods.amount_due then 'paid'
      when public.contribution_periods.amount_paid > 0 then 'partial'
      when excluded.due_date < current_date then 'late'
      else 'due'
    end;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

drop function if exists public.record_cash_expense(uuid, uuid, numeric, date, text);
create function public.record_cash_expense(
  p_family_id uuid,
  p_fund_id uuid,
  p_amount numeric,
  p_expense_date date,
  p_reason text,
  p_beneficiary text default null,
  p_category text default 'Autre',
  p_receipt_path text default null
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
  reserved numeric(12,2);
  available numeric(12,2);
  next_status text;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Montant invalide'; end if;
  if p_expense_date is null or p_expense_date > current_date then raise exception 'La date de dépense ne peut pas être dans le futur'; end if;
  if p_reason is null or length(trim(p_reason)) not between 3 and 160 then raise exception 'Un motif de 3 à 160 caractères est requis'; end if;
  if p_beneficiary is not null and length(trim(p_beneficiary)) not between 2 and 120 then raise exception 'Bénéficiaire invalide'; end if;
  if p_category is null or length(trim(p_category)) not between 2 and 60 then raise exception 'Catégorie invalide'; end if;
  if p_receipt_path is not null and p_receipt_path not like p_family_id::text || '/' || p_fund_id::text || '/%' then
    raise exception 'Chemin du justificatif invalide';
  end if;

  select * into target_fund from public.funds
  where id = p_fund_id and family_id = p_family_id and active for update;
  if target_fund.id is null then raise exception 'Caisse introuvable ou inactive'; end if;
  if not public.can_record_fund(p_family_id, p_fund_id) then raise exception 'Vous n’avez pas le droit de dépenser sur cette caisse'; end if;

  select coalesce(sum(amount), 0) into collected from public.cash_payments
  where family_id = p_family_id and fund_id = p_fund_id and reversed_at is null;
  select coalesce(sum(amount), 0) into reserved from public.cash_expenses
  where family_id = p_family_id and fund_id = p_fund_id and status in ('approved', 'pending');
  available := collected - reserved;
  if p_amount > available then raise exception 'Solde insuffisant : % € disponibles', available; end if;

  next_status := case
    when target_fund.expense_approval_threshold > 0 and p_amount >= target_fund.expense_approval_threshold then 'pending'
    else 'approved'
  end;

  insert into public.cash_expenses(
    family_id, fund_id, amount, reason, expense_date, spent_by,
    beneficiary, category, receipt_path, status, approved_by, approved_at
  ) values (
    p_family_id, p_fund_id, p_amount, trim(p_reason), p_expense_date, auth.uid(),
    nullif(trim(p_beneficiary), ''), trim(p_category), nullif(trim(p_receipt_path), ''), next_status,
    case when next_status = 'approved' then auth.uid() else null end,
    case when next_status = 'approved' then now() else null end
  ) returning * into expense;

  perform public.log_admin_event(
    p_family_id,
    case when next_status = 'pending' then 'expense_pending' else 'expense_recorded' end,
    'cash_expense', expense.id::text,
    case when next_status = 'pending' then 'Dépense en attente de seconde validation' else 'Dépense enregistrée' end,
    jsonb_build_object('fund_id', p_fund_id, 'amount', p_amount, 'category', trim(p_category))
  );
  return expense;
end;
$$;

create or replace function public.review_cash_expense(
  p_expense_id uuid,
  p_decision text,
  p_note text default null
)
returns public.cash_expenses
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  expense public.cash_expenses;
begin
  if p_decision not in ('approve', 'reject') then raise exception 'Décision invalide'; end if;
  if p_note is not null and length(p_note) > 160 then raise exception 'Note trop longue'; end if;
  select * into expense from public.cash_expenses where id = p_expense_id for update;
  if expense.id is null then raise exception 'Dépense introuvable'; end if;
  if expense.status <> 'pending' then raise exception 'Cette dépense a déjà été traitée'; end if;
  if expense.spent_by = auth.uid() then raise exception 'Une autre personne habilitée doit valider cette dépense'; end if;
  if not public.can_record_fund(expense.family_id, expense.fund_id) then raise exception 'Autorisation insuffisante pour cette caisse'; end if;

  update public.cash_expenses set
    status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
    approved_by = case when p_decision = 'approve' then auth.uid() else null end,
    approved_at = case when p_decision = 'approve' then now() else null end,
    rejected_by = case when p_decision = 'reject' then auth.uid() else null end,
    rejected_at = case when p_decision = 'reject' then now() else null end,
    review_note = nullif(trim(p_note), '')
  where id = p_expense_id returning * into expense;

  perform public.log_admin_event(
    expense.family_id,
    case when p_decision = 'approve' then 'expense_approved' else 'expense_rejected' end,
    'cash_expense', expense.id::text,
    case when p_decision = 'approve' then 'Dépense validée par une seconde personne' else 'Dépense refusée' end,
    jsonb_build_object('fund_id', expense.fund_id, 'amount', expense.amount, 'note', expense.review_note)
  );
  return expense;
end;
$$;

create or replace function public.set_fund_expense_threshold(p_fund_id uuid, p_threshold numeric)
returns public.funds
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  fund public.funds;
begin
  if p_threshold is null or p_threshold < 0 then raise exception 'Seuil invalide'; end if;
  select * into fund from public.funds where id = p_fund_id for update;
  if fund.id is null then raise exception 'Caisse introuvable'; end if;
  if not public.can_manage_family(fund.family_id) then raise exception 'Autorisation administrateur requise'; end if;
  update public.funds set expense_approval_threshold = p_threshold where id = p_fund_id returning * into fund;
  perform public.log_admin_event(
    fund.family_id, 'expense_threshold_changed', 'fund', fund.id::text,
    'Seuil de double validation modifié', jsonb_build_object('threshold', p_threshold)
  );
  return fund;
end;
$$;

create or replace function public.set_member_fund_exception(
  p_member_id uuid,
  p_fund_id uuid,
  p_action text,
  p_start_month date,
  p_end_month date default null,
  p_note text default null
)
returns public.member_fund_exceptions
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  member public.family_members;
  fund public.funds;
  adjustment public.member_fund_exceptions;
  schedule public.member_fund_schedules;
  normalized_start date;
  normalized_end date;
begin
  if p_action not in ('exempt', 'suspend', 'resume', 'leave') then raise exception 'Type d’exception invalide'; end if;
  if p_start_month is null then raise exception 'Le mois de début est obligatoire'; end if;
  if p_note is not null and length(p_note) > 160 then raise exception 'Note trop longue'; end if;
  normalized_start := date_trunc('month', p_start_month)::date;
  normalized_end := date_trunc('month', coalesce(p_end_month, p_start_month))::date;
  if normalized_start < date '2021-01-01' or normalized_end < normalized_start or normalized_end > date_trunc('month', current_date)::date then
    raise exception 'Période invalide';
  end if;

  select * into member from public.family_members where id = p_member_id for update;
  select * into fund from public.funds where id = p_fund_id;
  if member.id is null or fund.id is null or member.family_id <> fund.family_id then raise exception 'Membre ou caisse introuvable'; end if;
  if not public.can_manage_family(member.family_id) then raise exception 'Autorisation administrateur requise'; end if;

  select * into schedule from public.member_fund_schedules
  where member_id = p_member_id and fund_id = p_fund_id for update;
  if schedule.id is null then
    insert into public.member_fund_schedules(
      family_id, member_id, fund_id, start_month, end_month, active, created_by, updated_by
    ) values (
      member.family_id, member.id, fund.id,
      date_trunc('month', greatest(fund.start_date, member.joined_on, date '2021-01-01'))::date,
      date_trunc('month', current_date)::date, true, auth.uid(), auth.uid()
    ) returning * into schedule;
  end if;
  perform public.sync_fund_periods(fund.id, auth.uid());

  if p_action = 'exempt' then
    update public.contribution_periods set status = 'exempt'
    where member_id = member.id and fund_id = fund.id and amount_paid = 0
      and period_start between normalized_start and normalized_end;
  elsif p_action = 'suspend' then
    update public.contribution_periods set status = 'cancelled'
    where member_id = member.id and fund_id = fund.id and amount_paid = 0
      and period_start between normalized_start and normalized_end;
  elsif p_action = 'resume' then
    update public.member_fund_schedules set active = true,
      end_month = greatest(end_month, date_trunc('month', current_date)::date), updated_by = auth.uid()
    where id = schedule.id;
    update public.contribution_periods set status = case when due_date < current_date then 'late' else 'due' end
    where member_id = member.id and fund_id = fund.id and amount_paid = 0
      and period_start between normalized_start and normalized_end;
  else
    update public.contribution_periods set status = 'cancelled'
    where member_id = member.id and fund_id = fund.id and amount_paid = 0 and period_start >= normalized_start;
    update public.member_fund_schedules set
      end_month = greatest(start_month, normalized_start - interval '1 month')::date,
      active = normalized_start > start_month,
      updated_by = auth.uid()
    where id = schedule.id;
  end if;

  insert into public.member_fund_exceptions(
    family_id, member_id, fund_id, action, start_month, end_month, note, created_by
  ) values (
    member.family_id, member.id, fund.id, p_action, normalized_start,
    case when p_action in ('exempt', 'suspend', 'resume') then normalized_end else null end,
    nullif(trim(p_note), ''), auth.uid()
  ) returning * into adjustment;

  perform public.log_admin_event(
    member.family_id, 'member_fund_exception', 'member_fund_exception', adjustment.id::text,
    'Exception de cotisation appliquée à ' || member.full_name,
    jsonb_build_object('member_id', member.id, 'fund_id', fund.id, 'action', p_action, 'start_month', normalized_start, 'end_month', adjustment.end_month)
  );
  return adjustment;
end;
$$;

create or replace function public.import_cash_payments(p_family_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  row_item jsonb;
  imported integer := 0;
  payment public.cash_payments;
begin
  if not public.can_manage_family(p_family_id) then raise exception 'Autorisation administrateur requise'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Fichier d’import invalide'; end if;
  if jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 2000 then raise exception 'L’import doit contenir entre 1 et 2 000 paiements'; end if;

  for row_item in select value from jsonb_array_elements(p_rows)
  loop
    if coalesce(row_item->>'family_id', p_family_id::text) <> p_family_id::text then raise exception 'Famille invalide dans l’import'; end if;
    payment := public.record_cash_payment(
      p_family_id,
      (row_item->>'fund_id')::uuid,
      (row_item->>'member_id')::uuid,
      (row_item->>'amount')::numeric,
      (row_item->>'payment_date')::date,
      nullif(row_item->>'note', '')
    );
    imported := imported + 1;
  end loop;

  perform public.log_admin_event(
    p_family_id, 'payments_imported', 'cash_payment_import', null,
    imported || ' paiement(s) historique(s) importé(s)', jsonb_build_object('count', imported)
  );
  return jsonb_build_object('ok', true, 'imported', imported);
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

  update public.contribution_periods period set
    amount_paid = greatest(0, period.amount_paid - allocation.total_amount),
    status = case
      when greatest(0, period.amount_paid - allocation.total_amount) >= period.amount_due then 'paid'
      when greatest(0, period.amount_paid - allocation.total_amount) > 0 then 'partial'
      when period.due_date < current_date then 'late'
      else 'due'
    end
  from (
    select period_id, sum(amount) total_amount from public.cash_payment_allocations
    where payment_id = target.id group by period_id
  ) allocation
  where period.id = allocation.period_id;

  update public.cash_payments set reversed_at = now(), reversed_by = auth.uid(), reversal_reason = trim(reason)
  where id = payment_id returning * into target;
  perform public.log_admin_event(
    target.family_id, 'payment_reversed', 'cash_payment', target.id::text,
    'Paiement annulé avec conservation de la trace', jsonb_build_object('fund_id', target.fund_id, 'amount', target.amount, 'reason', trim(reason))
  );
  return target;
end;
$$;

create or replace function public.list_payment_activity(p_family_id uuid)
returns table (
  payment_id uuid, family_id uuid, fund_id uuid, fund_name text, member_name text,
  amount numeric, method text, payment_date date, created_at timestamptz,
  reversed_at timestamptz, reversal_reason text, recorded_by_name text, reversed_by_name text
)
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
begin
  if not public.is_family_member(p_family_id) then raise exception 'Accès familial non approuvé'; end if;
  return query
  select movement.payment_id, movement.family_id, movement.fund_id, movement.fund_name,
    movement.member_name, movement.amount, movement.method, movement.payment_date,
    movement.created_at, movement.reversed_at, movement.reversal_reason,
    movement.recorded_by_name, movement.reversed_by_name
  from (
    select payment.id payment_id, payment.family_id, payment.fund_id, fund.name fund_name,
      case when public.can_record_fund(p_family_id, payment.fund_id) then member.full_name else null end member_name,
      payment.amount, payment.method, payment.payment_date, payment.created_at, payment.reversed_at,
      payment.reversal_reason,
      case when public.can_record_fund(p_family_id, payment.fund_id) then coalesce(recorder.full_name, 'Responsable habilité') else null end recorded_by_name,
      case when public.can_record_fund(p_family_id, payment.fund_id) then coalesce(reverser.full_name, 'Responsable habilité') else null end reversed_by_name,
      coalesce(payment.reversed_at, payment.created_at) sort_at
    from public.cash_payments payment
    join public.funds fund on fund.id = payment.fund_id
    join public.family_members member on member.id = payment.member_id
    left join public.profiles recorder on recorder.user_id = payment.recorded_by
    left join public.profiles reverser on reverser.user_id = payment.reversed_by
    where payment.family_id = p_family_id
    union all
    select expense.id, expense.family_id, expense.fund_id, fund.name, null::text,
      expense.amount, 'expense'::text, expense.expense_date, expense.created_at,
      null::timestamptz,
      concat_ws(' • ', expense.reason, nullif(expense.category, ''), nullif(expense.beneficiary, '')),
      case when public.can_record_fund(p_family_id, expense.fund_id) then coalesce(spender.full_name, 'Responsable habilité') else null end,
      null::text, expense.created_at
    from public.cash_expenses expense
    join public.funds fund on fund.id = expense.fund_id
    left join public.profiles spender on spender.user_id = expense.spent_by
    where expense.family_id = p_family_id and expense.status = 'approved'
  ) movement
  order by movement.sort_at desc;
end;
$$;

create or replace function public.list_admin_activity(p_family_id uuid)
returns table (
  event_id bigint, event_type text, entity_type text, entity_id text,
  summary text, details jsonb, actor_name text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
begin
  if not public.can_manage_family(p_family_id) then raise exception 'Autorisation administrateur requise'; end if;
  return query
  select event.id, event.event_type, event.entity_type, event.entity_id,
    event.summary, event.details, coalesce(profile.full_name, 'Système'), event.created_at
  from public.admin_audit_events event
  left join public.profiles profile on profile.user_id = event.actor_user_id
  where event.family_id = p_family_id
  order by event.created_at desc
  limit 100;
end;
$$;

create or replace function public.get_meeting_summary(p_family_id uuid)
returns table (
  fund_id uuid, fund_name text, monthly_amount numeric,
  total_expected numeric, total_collected numeric, total_expenses numeric,
  balance numeric, member_count bigint, up_to_date_count bigint
)
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
begin
  if not public.is_family_member(p_family_id) then raise exception 'Accès familial non approuvé'; end if;
  return query
  select fund.id, fund.name, fund.monthly_amount,
    coalesce((select sum(period.amount_due) from public.contribution_periods period where period.fund_id = fund.id and period.status not in ('exempt', 'cancelled')), 0),
    coalesce((select sum(payment.amount) from public.cash_payments payment where payment.fund_id = fund.id and payment.reversed_at is null), 0),
    coalesce((select sum(expense.amount) from public.cash_expenses expense where expense.fund_id = fund.id and expense.status = 'approved'), 0),
    coalesce((select sum(payment.amount) from public.cash_payments payment where payment.fund_id = fund.id and payment.reversed_at is null), 0)
      - coalesce((select sum(expense.amount) from public.cash_expenses expense where expense.fund_id = fund.id and expense.status = 'approved'), 0),
    (select count(*) from public.member_fund_schedules schedule join public.family_members member on member.id = schedule.member_id where schedule.fund_id = fund.id and schedule.active and member.active and member.approval_status = 'approved'),
    (select count(*) from public.member_fund_schedules schedule join public.family_members member on member.id = schedule.member_id
      where schedule.fund_id = fund.id and schedule.active and member.active and member.approval_status = 'approved'
      and not exists (select 1 from public.contribution_periods period where period.member_id = member.id and period.fund_id = fund.id and period.status not in ('exempt', 'cancelled') and period.amount_paid < period.amount_due))
  from public.funds fund
  where fund.family_id = p_family_id and fund.active
  order by fund.display_order, fund.created_at;
end;
$$;

create or replace function public.list_due_reminder_targets(p_today date default current_date)
returns table (
  family_id uuid, member_id uuid, user_id uuid, full_name text,
  total_due numeric, late_months bigint, reminder_type text
)
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
begin
  return query
  with situations as (
    select member.family_id, member.id member_id, member.user_id, member.full_name,
      sum(period.amount_due - period.amount_paid) total_due,
      count(*) filter (where period.due_date < p_today) late_months
    from public.family_members member
    join public.contribution_periods period on period.member_id = member.id
      and period.status not in ('exempt', 'cancelled') and period.amount_paid < period.amount_due
    where member.active and member.approval_status = 'approved' and member.user_id is not null
    group by member.family_id, member.id, member.user_id, member.full_name
  )
  select situation.family_id, situation.member_id, situation.user_id, situation.full_name,
    situation.total_due, situation.late_months, 'monthly'::text
  from situations situation
  where extract(day from p_today) = 1
    and exists (select 1 from public.push_subscriptions subscription where subscription.member_id = situation.member_id)
    and not exists (
      select 1 from public.due_reminder_log sent
      where sent.member_id = situation.member_id and sent.reminder_date = p_today and sent.reminder_type = 'monthly'
    );
end;
$$;

create or replace function public.audit_fund_change()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_admin_event(
      new.family_id, 'fund_created', 'fund', new.id::text,
      'Caisse créée : ' || new.name,
      jsonb_build_object('monthly_amount', new.monthly_amount, 'start_date', new.start_date)
    );
  elsif old.name is distinct from new.name
    or old.description is distinct from new.description
    or old.monthly_amount is distinct from new.monthly_amount
    or old.start_date is distinct from new.start_date
    or old.due_day is distinct from new.due_day
    or old.active is distinct from new.active then
    perform public.log_admin_event(
      new.family_id, 'fund_updated', 'fund', new.id::text,
      'Configuration de la caisse modifiée : ' || new.name,
      jsonb_build_object(
        'monthly_amount_before', old.monthly_amount,
        'monthly_amount_after', new.monthly_amount,
        'start_date_before', old.start_date,
        'start_date_after', new.start_date,
        'active', new.active
      )
    );
  end if;
  return new;
end;
$$;

create or replace function public.audit_member_access_change()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if old.approval_status is distinct from new.approval_status
    or old.access_level is distinct from new.access_level
    or old.write_fund_codes is distinct from new.write_fund_codes
    or old.role is distinct from new.role
    or old.active is distinct from new.active then
    perform public.log_admin_event(
      new.family_id, 'member_access_updated', 'family_member', new.id::text,
      'Accès modifié pour ' || new.full_name,
      jsonb_build_object(
        'approval_status', new.approval_status,
        'access_level', new.access_level,
        'write_fund_codes', new.write_fund_codes,
        'role', new.role,
        'active', new.active
      )
    );
  end if;
  return new;
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
    or old.active is distinct from new.active then
    perform public.log_admin_event(
      new.family_id, 'member_schedule_updated', 'member_fund_schedule', new.id::text,
      'Période de cotisation modifiée',
      jsonb_build_object('member_id', new.member_id, 'fund_id', new.fund_id, 'start_month', new.start_month, 'end_month', new.end_month, 'active', new.active)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists funds_admin_audit on public.funds;
create trigger funds_admin_audit after insert or update on public.funds
for each row execute function public.audit_fund_change();

drop trigger if exists family_members_access_audit on public.family_members;
create trigger family_members_access_audit after update on public.family_members
for each row execute function public.audit_member_access_change();

drop trigger if exists member_fund_schedules_admin_audit on public.member_fund_schedules;
create trigger member_fund_schedules_admin_audit after insert or update on public.member_fund_schedules
for each row execute function public.audit_schedule_change();

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'expense-receipts', 'expense-receipts', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists expense_receipts_select on storage.objects;
create policy expense_receipts_select on storage.objects for select to authenticated
using (
  bucket_id = 'expense-receipts'
  and public.can_record_fund(
    ((storage.foldername(name))[1])::uuid,
    ((storage.foldername(name))[2])::uuid
  )
);
drop policy if exists expense_receipts_insert on storage.objects;
create policy expense_receipts_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'expense-receipts'
  and public.can_record_fund(
    ((storage.foldername(name))[1])::uuid,
    ((storage.foldername(name))[2])::uuid
  )
);
drop policy if exists expense_receipts_delete on storage.objects;
create policy expense_receipts_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'expense-receipts'
  and public.can_manage_family(((storage.foldername(name))[1])::uuid)
);

revoke all on function public.log_admin_event(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.audit_fund_change() from public, anon, authenticated;
revoke all on function public.audit_member_access_change() from public, anon, authenticated;
revoke all on function public.audit_schedule_change() from public, anon, authenticated;
revoke all on function public.record_cash_expense(uuid, uuid, numeric, date, text, text, text, text) from public, anon;
revoke all on function public.review_cash_expense(uuid, text, text) from public, anon;
revoke all on function public.set_fund_expense_threshold(uuid, numeric) from public, anon;
revoke all on function public.set_member_fund_exception(uuid, uuid, text, date, date, text) from public, anon;
revoke all on function public.import_cash_payments(uuid, jsonb) from public, anon;
revoke all on function public.list_admin_activity(uuid) from public, anon;
revoke all on function public.get_meeting_summary(uuid) from public, anon;
revoke all on function public.list_due_reminder_targets(date) from public, anon, authenticated;

grant execute on function public.record_cash_expense(uuid, uuid, numeric, date, text, text, text, text) to authenticated;
grant execute on function public.review_cash_expense(uuid, text, text) to authenticated;
grant execute on function public.set_fund_expense_threshold(uuid, numeric) to authenticated;
grant execute on function public.set_member_fund_exception(uuid, uuid, text, date, date, text) to authenticated;
grant execute on function public.import_cash_payments(uuid, jsonb) to authenticated;
grant execute on function public.list_admin_activity(uuid) to authenticated;
grant execute on function public.get_meeting_summary(uuid) to authenticated;
grant execute on function public.list_due_reminder_targets(date) to service_role;
grant select, insert, update on public.due_reminder_log to service_role;
grant usage, select on sequence public.due_reminder_log_id_seq to service_role;

commit;
