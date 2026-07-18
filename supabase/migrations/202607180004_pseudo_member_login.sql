-- Connexion des membres par pseudo et code à 6 chiffres.
-- Un jeton de revendication à usage unique permet de rattacher une session
-- Supabase anonyme uniquement après vérification du code.

begin;

create extension if not exists pgcrypto with schema extensions;

alter table public.family_members
  add column if not exists pseudo text,
  add column if not exists login_code_hash text,
  add column if not exists login_code_issued_at timestamptz,
  add column if not exists failed_login_attempts integer not null default 0,
  add column if not exists locked_until timestamptz;

alter table public.family_members
  drop constraint if exists family_members_pseudo_check;
alter table public.family_members
  add constraint family_members_pseudo_check check (
    pseudo is null
    or (
      length(trim(pseudo)) between 2 and 40
      and pseudo !~ '[[:cntrl:]]'
    )
  );

create unique index if not exists family_members_family_pseudo_unique
  on public.family_members(family_id, lower(trim(pseudo)))
  where pseudo is not null;

create table if not exists public.member_login_claims (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.family_members(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists member_login_claims_member_idx
  on public.member_login_claims(member_id, expires_at desc);

alter table public.member_login_claims enable row level security;
revoke all on public.member_login_claims from public, anon, authenticated;

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
  on conflict (user_id) do update
    set full_name = coalesce(public.profiles.full_name, excluded.full_name);

  -- Les sessions anonymes sont rattachées seulement après validation du code.
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;

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

create or replace function public.request_pseudo_membership(p_pseudo text)
returns jsonb
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  normalized_pseudo text;
  default_family_id uuid;
  target public.family_members;
begin
  normalized_pseudo := regexp_replace(trim(coalesce(p_pseudo, '')), '\s+', ' ', 'g');
  if length(normalized_pseudo) < 2 or length(normalized_pseudo) > 40
    or normalized_pseudo ~ '[[:cntrl:]]' then
    raise exception 'Le pseudo doit contenir entre 2 et 40 caractères';
  end if;

  select id into default_family_id
  from public.family_spaces
  where slug = 'ma-famille'
  limit 1;
  if default_family_id is null then raise exception 'Espace familial indisponible'; end if;

  select * into target
  from public.family_members
  where family_id = default_family_id
    and lower(trim(pseudo)) = lower(normalized_pseudo)
  for update;

  if target.id is not null then
    if target.approval_status = 'rejected' then
      update public.family_members
      set
        full_name = normalized_pseudo,
        pseudo = normalized_pseudo,
        active = false,
        approval_status = 'pending',
        access_level = 'read',
        write_fund_codes = '{}'::text[],
        reviewed_at = null,
        reviewed_by = null,
        login_code_hash = null,
        login_code_issued_at = null,
        failed_login_attempts = 0,
        locked_until = null
      where id = target.id;
    end if;
    return jsonb_build_object('status', 'received');
  end if;

  if (
    select count(*) from public.family_members
    where family_id = default_family_id and approval_status = 'pending'
  ) >= 50 then
    raise exception 'Trop de demandes sont en attente. Contactez un administrateur.';
  end if;

  insert into public.family_members(
    family_id, user_id, full_name, pseudo, role, joined_on,
    active, approval_status, access_level, write_fund_codes
  ) values (
    default_family_id, null, normalized_pseudo, normalized_pseudo, 'member', current_date,
    false, 'pending', 'read', '{}'::text[]
  );

  return jsonb_build_object('status', 'received');
end;
$$;

drop function if exists public.review_member_access(uuid, text, text, text[]);
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

create or replace function public.reset_member_login_code(p_member_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
set row_security = off
as $$
declare
  target public.family_members;
  access_code text;
begin
  select * into target from public.family_members where id = p_member_id for update;
  if target.id is null or target.pseudo is null then raise exception 'Membre avec pseudo introuvable'; end if;
  if not public.can_manage_family(target.family_id) then raise exception 'Autorisation administrateur requise'; end if;
  if not target.active or target.approval_status <> 'approved' then raise exception 'Ce membre n’est pas validé'; end if;

  access_code := lpad(floor(random() * 1000000)::integer::text, 6, '0');
  update public.family_members
  set
    login_code_hash = crypt(access_code, gen_salt('bf', 10)),
    login_code_issued_at = now(),
    failed_login_attempts = 0,
    locked_until = null
  where id = p_member_id;
  return access_code;
end;
$$;

create or replace function public.prepare_member_login(p_pseudo text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
set row_security = off
as $$
declare
  target public.family_members;
  normalized_pseudo text;
  claim_token text;
  next_attempts integer;
begin
  normalized_pseudo := regexp_replace(trim(coalesce(p_pseudo, '')), '\s+', ' ', 'g');
  if p_code !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'message', 'Pseudo ou code incorrect');
  end if;

  select member.* into target
  from public.family_members member
  join public.family_spaces family on family.id = member.family_id
  where family.slug = 'ma-famille'
    and lower(trim(member.pseudo)) = lower(normalized_pseudo)
    and member.active
    and member.approval_status = 'approved'
  for update of member;

  if target.id is null or target.login_code_hash is null then
    return jsonb_build_object('ok', false, 'message', 'Pseudo ou code incorrect');
  end if;
  if target.locked_until is not null and target.locked_until > now() then
    return jsonb_build_object('ok', false, 'message', 'Trop de tentatives. Réessayez dans 15 minutes.');
  end if;

  if crypt(p_code, target.login_code_hash) <> target.login_code_hash then
    next_attempts := target.failed_login_attempts + 1;
    update public.family_members
    set
      failed_login_attempts = case when next_attempts >= 5 then 0 else next_attempts end,
      locked_until = case when next_attempts >= 5 then now() + interval '15 minutes' else null end
    where id = target.id;
    return jsonb_build_object(
      'ok', false,
      'message', case when next_attempts >= 5
        then 'Trop de tentatives. Réessayez dans 15 minutes.'
        else 'Pseudo ou code incorrect'
      end
    );
  end if;

  update public.family_members
  set failed_login_attempts = 0, locked_until = null
  where id = target.id;

  delete from public.member_login_claims
  where member_id = target.id;

  claim_token := gen_random_uuid()::text;
  insert into public.member_login_claims(member_id, token_hash, expires_at)
  values (
    target.id,
    encode(digest(claim_token, 'sha256'), 'hex'),
    now() + interval '5 minutes'
  );

  return jsonb_build_object('ok', true, 'claim_token', claim_token);
end;
$$;

create or replace function public.claim_member_login(p_claim_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
set row_security = off
as $$
declare
  target_claim public.member_login_claims;
  target_member public.family_members;
begin
  if auth.uid() is null
    or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is not true then
    raise exception 'Session membre anonyme requise';
  end if;

  select * into target_claim
  from public.member_login_claims
  where token_hash = encode(digest(coalesce(p_claim_token, ''), 'sha256'), 'hex')
    and consumed_at is null
    and expires_at > now()
  for update;
  if target_claim.id is null then raise exception 'Code de connexion expiré'; end if;

  select * into target_member
  from public.family_members
  where id = target_claim.member_id
    and active
    and approval_status = 'approved'
  for update;
  if target_member.id is null then raise exception 'Accès membre indisponible'; end if;

  update public.family_members
  set user_id = auth.uid()
  where id = target_member.id
  returning * into target_member;

  update public.profiles
  set full_name = target_member.full_name
  where user_id = auth.uid();

  update public.member_login_claims
  set consumed_at = now()
  where id = target_claim.id;

  return to_jsonb(target_member) - 'login_code_hash';
end;
$$;

revoke all on function public.request_pseudo_membership(text) from public;
grant execute on function public.request_pseudo_membership(text) to anon, authenticated;
revoke all on function public.prepare_member_login(text, text) from public;
grant execute on function public.prepare_member_login(text, text) to anon, authenticated;
revoke all on function public.claim_member_login(text) from public, anon;
grant execute on function public.claim_member_login(text) to authenticated;
revoke all on function public.reset_member_login_code(uuid) from public, anon;
grant execute on function public.reset_member_login_code(uuid) to authenticated;
revoke all on function public.review_member_access(uuid, text, text, text[]) from public, anon;
grant execute on function public.review_member_access(uuid, text, text, text[]) to authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

commit;
