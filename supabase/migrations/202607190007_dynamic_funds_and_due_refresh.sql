-- Caisses extensibles et mensualités automatiquement maintenues jusqu'au mois courant.

begin;

alter table public.funds
  drop constraint if exists funds_code_check;

alter table public.family_members
  drop constraint if exists family_members_write_fund_codes_check;
alter table public.family_members
  add constraint family_members_write_fund_codes_check check (
    cardinality(write_fund_codes) <= 50
    and array_position(write_fund_codes, null) is null
  );

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
        date_trunc('month', greatest(fund_record.start_date, new.joined_on, date '2021-01-01'))::date,
        date_trunc('month', current_date)::date,
        true,
        auth.uid(),
        auth.uid()
      )
      on conflict (member_id, fund_id) do update set
        end_month = greatest(
          public.member_fund_schedules.end_month,
          date_trunc('month', current_date)::date
        ),
        active = true,
        updated_by = auth.uid();

      perform public.sync_fund_periods(fund_record.id, coalesce(auth.uid(), new.user_id));
    end loop;
  end if;
  return new;
end;
$$;

create or replace function public.review_member_access(
  p_member_id uuid,
  p_decision text,
  p_access_level text default 'read',
  p_write_fund_codes text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
set row_security = off
as $$
declare
  target public.family_members;
  normalized_codes text[];
  access_code text;
  should_issue_code boolean := false;
begin
  if p_decision not in ('approve', 'reject') then raise exception 'Décision invalide'; end if;
  if p_access_level not in ('read', 'write') then raise exception 'Niveau d’accès invalide'; end if;

  select * into target from public.family_members where id = p_member_id for update;
  if target.id is null then raise exception 'Compte introuvable'; end if;
  if not public.can_manage_family(target.family_id) then raise exception 'Autorisation administrateur requise'; end if;
  if target.role = 'admin' and target.approval_status = 'approved' then
    raise exception 'Les droits d’un administrateur ne peuvent pas être modifiés ici';
  end if;

  select coalesce(array_agg(valid.code order by valid.code), '{}'::text[])
  into normalized_codes
  from (
    select distinct fund.code
    from unnest(coalesce(p_write_fund_codes, '{}'::text[])) requested(code)
    join public.funds fund
      on fund.family_id = target.family_id
      and fund.code = requested.code
      and fund.active
  ) valid;

  if p_access_level = 'write' and cardinality(normalized_codes) = 0 then
    raise exception 'Choisissez au moins une caisse pour le droit d’écriture';
  end if;
  if cardinality(normalized_codes) <> cardinality(coalesce(p_write_fund_codes, '{}'::text[])) then
    raise exception 'Caisse autorisée invalide';
  end if;

  should_issue_code := p_decision = 'approve'
    and target.pseudo is not null
    and (target.approval_status <> 'approved' or target.login_code_hash is null);

  if should_issue_code then
    access_code := lpad(floor(random() * 1000000)::integer::text, 6, '0');
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
      reviewed_by = auth.uid(),
      login_code_hash = case when should_issue_code then crypt(access_code, gen_salt('bf', 10)) else login_code_hash end,
      login_code_issued_at = case when should_issue_code then now() else login_code_issued_at end,
      failed_login_attempts = case when should_issue_code then 0 else failed_login_attempts end,
      locked_until = case when should_issue_code then null else locked_until end
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
      reviewed_by = auth.uid(),
      login_code_hash = null,
      login_code_issued_at = null,
      failed_login_attempts = 0,
      locked_until = null
    where id = p_member_id
    returning * into target;
  end if;

  return jsonb_build_object(
    'member', to_jsonb(target) - 'login_code_hash',
    'access_code', access_code
  );
end;
$$;

create or replace function public.create_fund(
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
  target_family_id uuid;
  new_fund public.funds;
  next_order integer;
begin
  select member.family_id into target_family_id
  from public.family_members member
  where member.user_id = auth.uid()
    and member.role = 'admin'
    and member.active
    and member.approval_status = 'approved'
    and member.access_level = 'write'
  limit 1;

  if target_family_id is null then raise exception 'Autorisation administrateur requise'; end if;
  if p_name is null or length(trim(p_name)) < 3 or length(trim(p_name)) > 80 then raise exception 'Nom de caisse invalide'; end if;
  if p_description is not null and length(p_description) > 160 then raise exception 'Description trop longue'; end if;
  if p_monthly_amount is null or p_monthly_amount <= 0 then raise exception 'Montant mensuel invalide'; end if;
  if p_start_date is null or p_start_date > current_date or p_start_date < date '2021-01-01' then raise exception 'Date de début invalide'; end if;
  if p_due_day not between 1 and 28 then raise exception 'Jour d’échéance invalide'; end if;
  if exists (
    select 1 from public.funds
    where family_id = target_family_id and lower(trim(name)) = lower(trim(p_name)) and active
  ) then raise exception 'Une caisse active porte déjà ce nom'; end if;

  select coalesce(max(display_order), 0) + 1 into next_order
  from public.funds where family_id = target_family_id;

  insert into public.funds(
    family_id, code, name, description, monthly_amount,
    frequency, start_date, due_day, display_order, active
  ) values (
    target_family_id,
    'fund-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    trim(p_name),
    nullif(trim(p_description), ''),
    p_monthly_amount,
    'monthly',
    date_trunc('month', p_start_date)::date,
    p_due_day,
    next_order,
    true
  ) returning * into new_fund;

  insert into public.member_fund_schedules(
    family_id, member_id, fund_id, start_month, end_month, active,
    created_by, updated_by
  )
  select
    target_family_id,
    member.id,
    new_fund.id,
    date_trunc('month', greatest(new_fund.start_date, member.joined_on, date '2021-01-01'))::date,
    date_trunc('month', current_date)::date,
    true,
    auth.uid(),
    auth.uid()
  from public.family_members member
  where member.family_id = target_family_id
    and member.active
    and member.approval_status = 'approved'
  on conflict (member_id, fund_id) do nothing;

  perform public.sync_fund_periods(new_fund.id, auth.uid());
  return new_fund;
end;
$$;

create or replace function public.refresh_due_periods(p_family_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  fund_record public.funds;
  refreshed integer := 0;
begin
  if not public.can_record_cash(p_family_id) then
    raise exception 'Autorisation de saisie requise';
  end if;

  for fund_record in
    select * from public.funds
    where family_id = p_family_id and active
    order by display_order, created_at
  loop
    if public.can_record_fund(p_family_id, fund_record.id) then
      insert into public.member_fund_schedules(
        family_id, member_id, fund_id, start_month, end_month, active,
        created_by, updated_by
      )
      select
        p_family_id,
        member.id,
        fund_record.id,
        date_trunc('month', greatest(fund_record.start_date, member.joined_on, date '2021-01-01'))::date,
        date_trunc('month', current_date)::date,
        true,
        auth.uid(),
        auth.uid()
      from public.family_members member
      where member.family_id = p_family_id
        and member.active
        and member.approval_status = 'approved'
      on conflict (member_id, fund_id) do update set
        end_month = greatest(
          public.member_fund_schedules.end_month,
          excluded.end_month
        ),
        updated_by = auth.uid()
      where public.member_fund_schedules.active;

      refreshed := refreshed + public.sync_fund_periods(fund_record.id, auth.uid());
    end if;
  end loop;

  return refreshed;
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

  insert into public.member_fund_schedules(
    family_id, member_id, fund_id, start_month, end_month, active,
    created_by, updated_by
  ) values (
    p_family_id,
    p_member_id,
    p_fund_id,
    date_trunc('month', greatest(target_fund.start_date, target_member.joined_on, date '2021-01-01'))::date,
    date_trunc('month', current_date)::date,
    true,
    auth.uid(),
    auth.uid()
  )
  on conflict (member_id, fund_id) do update set
    end_month = greatest(
      public.member_fund_schedules.end_month,
      excluded.end_month
    ),
    active = true,
    updated_by = auth.uid();

  perform public.sync_fund_periods(target_fund.id, auth.uid());

  select coalesce(sum(amount_due - amount_paid), 0) into outstanding
  from public.contribution_periods
  where fund_id = p_fund_id
    and member_id = p_member_id
    and status not in ('exempt', 'cancelled')
    and amount_paid < amount_due;

  if outstanding <= 0 then
    raise exception 'Ce membre est déjà à jour pour cette caisse';
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

-- Rattrapage des membres déjà validés et prolongation des périodes existantes.
insert into public.member_fund_schedules(
  family_id, member_id, fund_id, start_month, end_month, active
)
select
  member.family_id,
  member.id,
  fund.id,
  date_trunc('month', greatest(fund.start_date, member.joined_on, date '2021-01-01'))::date,
  date_trunc('month', current_date)::date,
  true
from public.family_members member
join public.funds fund on fund.family_id = member.family_id and fund.active
where member.active and member.approval_status = 'approved'
on conflict (member_id, fund_id) do update set
  end_month = greatest(public.member_fund_schedules.end_month, excluded.end_month)
where public.member_fund_schedules.active;

select public.sync_fund_periods(id, null)
from public.funds
where active;

revoke all on function public.create_fund(text, text, numeric, date, integer) from public, anon;
revoke all on function public.refresh_due_periods(uuid) from public, anon;
revoke all on function public.review_member_access(uuid, text, text, text[]) from public, anon;
revoke all on function public.record_cash_payment(uuid, uuid, uuid, numeric, date, text) from public, anon;
revoke all on function public.handle_member_schedule() from public, anon, authenticated;

grant execute on function public.create_fund(text, text, numeric, date, integer) to authenticated;
grant execute on function public.refresh_due_periods(uuid) to authenticated;
grant execute on function public.review_member_access(uuid, text, text, text[]) to authenticated;
grant execute on function public.record_cash_payment(uuid, uuid, uuid, numeric, date, text) to authenticated;

commit;
