-- Jàppoo Cotiz — validation des comptes et registre général des paiements.

begin;

do $$
declare
  approval_column_was_missing boolean;
begin
  select not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'family_members'
      and column_name = 'approval_status'
  ) into approval_column_was_missing;

  if approval_column_was_missing then
    alter table public.family_members
      add column approval_status text not null default 'approved';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'family_members'
      and column_name = 'access_level'
  ) then
    alter table public.family_members
      add column access_level text not null default 'read';
  end if;

  if approval_column_was_missing then
    update public.family_members
    set
      approval_status = 'approved',
      access_level = case
        when role in ('admin', 'treasurer', 'cash_collector') then 'write'
        else 'read'
      end;
  end if;

  alter table public.family_members alter column approval_status set default 'pending';
end;
$$;

alter table public.family_members
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'family_members_approval_status_check'
  ) then
    alter table public.family_members
      add constraint family_members_approval_status_check
      check (approval_status in ('pending', 'approved', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'family_members_access_level_check'
  ) then
    alter table public.family_members
      add constraint family_members_access_level_check
      check (access_level in ('read', 'write'));
  end if;
end;
$$;

create index if not exists family_members_approval_idx
  on public.family_members(family_id, approval_status, created_at desc);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  default_family_id uuid;
  display_name text;
begin
  display_name := left(coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Nouveau membre'
  ), 120);
  if length(display_name) < 2 then display_name := 'Nouveau membre'; end if;

  insert into public.profiles(user_id, full_name)
  values (new.id, display_name)
  on conflict (user_id) do update set full_name = coalesce(public.profiles.full_name, excluded.full_name);

  select id into default_family_id
  from public.family_spaces
  where slug = 'ma-famille'
  limit 1;

  if default_family_id is not null then
    insert into public.family_members(
      family_id, user_id, full_name, role, joined_on,
      active, approval_status, access_level
    ) values (
      default_family_id, new.id, display_name, 'member', current_date,
      false, 'pending', 'read'
    )
    on conflict (family_id, user_id) where user_id is not null do nothing;
  end if;

  return new;
end;
$$;

-- Les comptes déjà présents mais encore non rattachés deviennent des demandes en attente.
insert into public.family_members(
  family_id, user_id, full_name, role, joined_on,
  active, approval_status, access_level
)
select
  family.id,
  account.id,
  case
    when length(coalesce(
      nullif(trim(account.raw_user_meta_data ->> 'full_name'), ''),
      nullif(split_part(coalesce(account.email, ''), '@', 1), '')
    )) >= 2
      then left(coalesce(
        nullif(trim(account.raw_user_meta_data ->> 'full_name'), ''),
        split_part(account.email, '@', 1)
      ), 120)
    else 'Nouveau membre'
  end,
  'member',
  current_date,
  false,
  'pending',
  'read'
from public.family_spaces family
cross join auth.users account
where family.slug = 'ma-famille'
  and not exists (
    select 1
    from public.family_members member
    where member.family_id = family.id and member.user_id = account.id
  )
on conflict (family_id, user_id) where user_id is not null do nothing;

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
    from public.family_members member
    where member.family_id = target_family_id
      and member.user_id = auth.uid()
      and member.active
      and member.approval_status = 'approved'
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
    from public.family_members member
    where member.family_id = target_family_id
      and member.user_id = auth.uid()
      and member.active
      and member.approval_status = 'approved'
      and member.access_level = 'write'
      and member.role in ('admin', 'treasurer', 'cash_collector')
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
    from public.family_members member
    where member.family_id = target_family_id
      and member.user_id = auth.uid()
      and member.active
      and member.approval_status = 'approved'
      and member.access_level = 'write'
      and member.role = 'admin'
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
    from public.family_members member
    where member.family_id = target_family_id
      and member.user_id = auth.uid()
      and member.active
      and member.approval_status = 'approved'
      and member.access_level = 'write'
      and member.role in ('admin', 'treasurer')
  );
$$;

create or replace function public.review_member_access(
  p_member_id uuid,
  p_decision text,
  p_access_level text default 'read'
)
returns public.family_members
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  target public.family_members;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'Décision invalide';
  end if;
  if p_access_level not in ('read', 'write') then
    raise exception 'Niveau d’accès invalide';
  end if;

  select * into target
  from public.family_members
  where id = p_member_id
  for update;

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
declare
  reveal_names boolean;
begin
  if not public.is_family_member(p_family_id) then
    raise exception 'Accès familial non approuvé';
  end if;

  reveal_names := public.can_record_cash(p_family_id);

  return query
  select
    payment.id,
    payment.family_id,
    payment.fund_id,
    fund.name,
    case when reveal_names then member.full_name else null end,
    payment.amount,
    payment.method,
    payment.payment_date,
    payment.created_at,
    payment.reversed_at,
    payment.reversal_reason,
    case when reveal_names then coalesce(recorder.full_name, 'Responsable habilité') else null end,
    case when reveal_names then coalesce(reverser.full_name, 'Responsable habilité') else null end
  from public.cash_payments payment
  join public.funds fund on fund.id = payment.fund_id
  join public.family_members member on member.id = payment.member_id
  left join public.profiles recorder on recorder.user_id = payment.recorded_by
  left join public.profiles reverser on reverser.user_id = payment.reversed_by
  where payment.family_id = p_family_id
  order by coalesce(payment.reversed_at, payment.created_at) desc;
end;
$$;

drop policy if exists family_members_select_scope on public.family_members;
create policy family_members_select_scope on public.family_members
for select to authenticated using (
  user_id = auth.uid()
  or public.can_manage_family(family_id)
  or (
    public.can_record_cash(family_id)
    and approval_status = 'approved'
    and active
  )
);

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.review_member_access(uuid, text, text) from public, anon;
revoke all on function public.list_payment_activity(uuid) from public, anon;
grant execute on function public.review_member_access(uuid, text, text) to authenticated;
grant execute on function public.list_payment_activity(uuid) to authenticated;

commit;
