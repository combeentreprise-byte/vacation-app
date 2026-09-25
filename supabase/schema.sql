-- Vacation App schema
-- Run once in the Supabase SQL Editor (Project > SQL Editor > New query).
-- Safe to re-run: uses "if not exists" / "or replace" throughout.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default 'Your Name',
  avatar_url text,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists avatar_url text;

-- Note: these reference public.profiles (not auth.users directly) so
-- PostgREST can embed profile data (e.g. `group_members(profiles(name))`)
-- when queried from the client. auth.users isn't queryable/embeddable from
-- the API layer at all, and every auth.users row already has exactly one
-- matching profiles row via the handle_new_user trigger below, so this loses
-- nothing.
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  currency text not null default '',
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  -- Surrogate key (rather than primary key (group_id, user_id)) specifically
  -- so user_id can be nullable — see the migration further down for why a
  -- deleted member's row has to survive their profile being gone. Uniqueness
  -- is still enforced below, just not as the PK.
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  joined_at timestamptz not null default now(),
  -- Null while an active member. Leaving sets this instead of deleting the
  -- row, so historical logs/balances involving this person stay intact and
  -- rejoining later reactivates the same row (see join_group below) rather
  -- than starting a fresh membership.
  left_at timestamptz,
  -- Whether this member can edit the group (name/description/currency) and
  -- promote others. Set true for the creator at group_creation (create_group
  -- below); mutable afterward via promote_to_admin.
  is_admin boolean not null default false,
  unique (group_id, user_id)
);

alter table public.group_members add column if not exists left_at timestamptz;
alter table public.group_members add column if not exists is_admin boolean not null default false;

-- Backfill for groups that already existed before is_admin was added: make
-- each group's original creator an admin of their own group, so existing
-- groups don't suddenly become uneditable by everyone.
update public.group_members gm
set is_admin = true
from public.groups g
where gm.group_id = g.id
  and gm.user_id = g.created_by
  and gm.is_admin = false;

create table if not exists public.logs (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  amount numeric not null check (amount > 0),
  currency text not null default '',
  details text not null default '',
  paid_by uuid not null references public.profiles (id),
  payer_included boolean not null default true,
  -- True for the special "debt was settled" entries created by settle_debt
  -- below, so the app can render them ("X settled their debt with Z")
  -- differently from a regular purchase.
  is_settlement boolean not null default false,
  -- amount converted into the group's CURRENT currency at whatever rate
  -- applied when the log was created (or, for settlements, just equal to
  -- amount, since those are always created directly in the group's
  -- currency already). This — never `amount` — is what balances are
  -- computed from, so a group with mixed-currency entries stays correct.
  -- change_group_currency below rescales every log's converted_amount
  -- whenever a group's currency changes, which is what keeps this
  -- "current group currency" invariant true no matter how old the log is.
  converted_amount numeric,
  created_at timestamptz not null default now()
);

alter table public.logs add column if not exists is_settlement boolean not null default false;
alter table public.logs add column if not exists converted_amount numeric;
update public.logs set converted_amount = amount where converted_amount is null;
alter table public.logs alter column converted_amount set not null;

create table if not exists public.log_members (
  -- Surrogate key (rather than primary key (log_id, user_id)) specifically
  -- so user_id can be nullable — see the migration further down for why a
  -- deleted member's slot in a log's split has to survive their profile
  -- being gone. Uniqueness is still enforced below, just not as the PK.
  id uuid primary key default gen_random_uuid(),
  log_id uuid not null references public.logs (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  unique (log_id, user_id)
);

-- Shared cache of exchange rates: one row per base currency, refreshed by
-- whichever client happens to notice it's stale (see
-- utils/exchange-rates.ts). Not user-specific data at all, so a plain
-- permissive policy is fine — no RPC needed just to cache public rates.
create table if not exists public.exchange_rates (
  base_currency text primary key,
  rates jsonb not null,
  fetched_at timestamptz not null default now()
);

-- Migration for databases where these tables already existed with the old
-- auth.users references (safe/idempotent: only acts if the old FK exists).
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'groups_created_by_fkey') then
    alter table public.groups drop constraint groups_created_by_fkey;
    alter table public.groups add constraint groups_created_by_fkey
      foreign key (created_by) references public.profiles (id);
  end if;

  if exists (select 1 from pg_constraint where conname = 'group_members_user_id_fkey') then
    alter table public.group_members drop constraint group_members_user_id_fkey;
    alter table public.group_members add constraint group_members_user_id_fkey
      foreign key (user_id) references public.profiles (id) on delete cascade;
  end if;

  if exists (select 1 from pg_constraint where conname = 'logs_paid_by_fkey') then
    alter table public.logs drop constraint logs_paid_by_fkey;
    alter table public.logs add constraint logs_paid_by_fkey
      foreign key (paid_by) references public.profiles (id);
  end if;

  if exists (select 1 from pg_constraint where conname = 'log_members_user_id_fkey') then
    alter table public.log_members drop constraint log_members_user_id_fkey;
    alter table public.log_members add constraint log_members_user_id_fkey
      foreign key (user_id) references public.profiles (id) on delete cascade;
  end if;
end $$;

-- Lets groups.created_by / logs.paid_by / log_members.user_id /
-- group_members.user_id survive their referenced profile being deleted (see
-- delete_account below) instead of either blocking the deletion outright or
-- cascading the row away. For logs/log_members specifically, cascading would
-- silently shrink a log's shareCount and retroactively change every other
-- member's historical balance (see calculateMemberBalances in balances.ts,
-- which treats a null paid_by/member as a shared "deleted" bucket rather
-- than dropping their slot in the split and letting the debt just vanish).
-- For group_members, cascading would make a deleted member disappear from
-- the Members tab entirely instead of showing up as "Deleted user" the same
-- way a merely-departed member shows up as "Left group" (see
-- use-group-members.tsx's mapMembers).
alter table public.groups alter column created_by drop not null;
alter table public.groups drop constraint if exists groups_created_by_fkey;
alter table public.groups add constraint groups_created_by_fkey
  foreign key (created_by) references public.profiles (id) on delete set null;

alter table public.logs alter column paid_by drop not null;
alter table public.logs drop constraint if exists logs_paid_by_fkey;
alter table public.logs add constraint logs_paid_by_fkey
  foreign key (paid_by) references public.profiles (id) on delete set null;

-- log_members previously had primary key (log_id, user_id), which blocks
-- making user_id nullable directly (a PK column can't be null) — so this
-- swaps in a surrogate id as the PK first, keeping the old pairing unique
-- via a separate constraint instead of relying on it being the PK.
alter table public.log_members add column if not exists id uuid not null default gen_random_uuid();
alter table public.log_members drop constraint if exists log_members_pkey;
alter table public.log_members add constraint log_members_pkey primary key (id);
alter table public.log_members drop constraint if exists log_members_log_id_user_id_key;
alter table public.log_members add constraint log_members_log_id_user_id_key
  unique (log_id, user_id);

alter table public.log_members alter column user_id drop not null;
alter table public.log_members drop constraint if exists log_members_user_id_fkey;
alter table public.log_members add constraint log_members_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete set null;

-- group_members previously had primary key (group_id, user_id) — same
-- surrogate-key swap as log_members above, and for the same reason (a PK
-- column can't be null).
alter table public.group_members add column if not exists id uuid not null default gen_random_uuid();
alter table public.group_members drop constraint if exists group_members_pkey;
alter table public.group_members add constraint group_members_pkey primary key (id);
alter table public.group_members drop constraint if exists group_members_group_id_user_id_key;
alter table public.group_members add constraint group_members_group_id_user_id_key
  unique (group_id, user_id);

alter table public.group_members alter column user_id drop not null;
alter table public.group_members drop constraint if exists group_members_user_id_fkey;
alter table public.group_members add constraint group_members_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Helper functions (security definer so they can check membership without
-- re-triggering RLS on the tables they read, which would otherwise recurse)
-- ---------------------------------------------------------------------------

-- left_at is null here on purpose: once someone leaves a group this stops
-- granting THEM access to it (via every policy below that calls this), while
-- everyone else's own is_group_member(group_id) check is unaffected, so they
-- keep seeing the departed member's row (and can render it grayed out)
-- instead of it vanishing along with the person's access.
create or replace function public.is_group_member(target_group_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members
    where group_id = target_group_id
      and user_id = auth.uid()
      and left_at is null
  );
$$;

create or replace function public.is_group_admin(target_group_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members
    where group_id = target_group_id
      and user_id = auth.uid()
      and left_at is null
      and is_admin = true
  );
$$;

-- gm1 (the viewer) must be an active member so a departed user can't keep
-- reading profiles through a group they've left; gm2 (the target) is
-- intentionally not filtered, so active members can still resolve a
-- departed member's name on historical logs.
create or replace function public.shares_group_with(target_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.group_members gm1
    join public.group_members gm2 on gm1.group_id = gm2.group_id
    where gm1.user_id = auth.uid()
      and gm1.left_at is null
      and gm2.user_id = target_user_id
  );
$$;

-- Auto-create a profile row whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', 'Your Name'));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Creates a group and adds the creator as its first member in one atomic
-- transaction. Doing this as two separate client-side inserts has two
-- problems: (1) a network drop between them leaves an orphaned group nobody
-- (not even its creator) can ever see, since groups_select requires
-- membership; and (2) even without a drop, selecting the just-created row
-- back to the client fails for the same reason the creator isn't a member
-- yet at that instant. security definer bypasses that bootstrapping problem
-- for this function's own inserts.
create or replace function public.create_group(
  group_name text,
  group_description text,
  group_currency text
)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  new_group public.groups;
begin
  insert into public.groups (name, description, currency, created_by)
  values (group_name, group_description, group_currency, auth.uid())
  returning * into new_group;

  insert into public.group_members (group_id, user_id, is_admin)
  values (new_group.id, auth.uid(), true);

  return new_group;
end;
$$;

grant execute on function public.create_group(text, text, text) to authenticated;

-- Superseded by the 7-arg version below (adds p_converted_amount); dropped
-- explicitly since "create or replace" can't change a function's argument
-- list in place and would otherwise leave this old overload lying around.
drop function if exists public.create_log(uuid, numeric, text, text, boolean, uuid[]);

-- Same atomicity reasoning as create_group: a log and the list of who it was
-- split with need to land together, not as two separate client calls that
-- could be interrupted in between.
create or replace function public.create_log(
  p_group_id uuid,
  p_amount numeric,
  p_converted_amount numeric,
  p_currency text,
  p_details text,
  p_payer_included boolean,
  p_member_ids uuid[]
)
returns public.logs
language plpgsql
security definer
set search_path = public
as $$
declare
  new_log public.logs;
  member_id uuid;
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'Not a member of this group';
  end if;

  insert into public.logs (group_id, amount, converted_amount, currency, details, paid_by, payer_included)
  values (p_group_id, p_amount, p_converted_amount, p_currency, p_details, auth.uid(), p_payer_included)
  returning * into new_log;

  foreach member_id in array p_member_ids loop
    insert into public.log_members (log_id, user_id) values (new_log.id, member_id);
  end loop;

  return new_log;
end;
$$;

grant execute on function public.create_log(uuid, numeric, numeric, text, text, boolean, uuid[]) to authenticated;

-- Edits a log entry the caller themselves logged (paid_by = auth.uid(), same
-- ownership scope as delete_log) — group_id and paid_by are deliberately not
-- editable (there's no "reassign this expense" concept), and settlements are
-- excluded outright since they're not created through this same form/shape
-- and editing one doesn't have well-defined semantics here. p_member_ids
-- replaces the entire split, same as create_log's insert loop — the client
-- is responsible for preserving any null (deleted-account) slots from the
-- original split rather than dropping them, exactly like create_log's own
-- caller does for a fresh entry; this function itself doesn't special-case
-- that, it just re-inserts whatever it's given.
create or replace function public.update_log(
  p_log_id uuid,
  p_amount numeric,
  p_converted_amount numeric,
  p_currency text,
  p_details text,
  p_payer_included boolean,
  p_member_ids uuid[]
)
returns public.logs
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_log public.logs;
  member_id uuid;
begin
  if not exists (
    select 1 from public.logs
    where id = p_log_id and paid_by = auth.uid() and is_settlement = false
  ) then
    raise exception 'You can only edit a log you created';
  end if;

  update public.logs
  set amount = p_amount,
      converted_amount = p_converted_amount,
      currency = p_currency,
      details = p_details,
      payer_included = p_payer_included
  where id = p_log_id
  returning * into updated_log;

  delete from public.log_members where log_id = p_log_id;
  foreach member_id in array p_member_ids loop
    insert into public.log_members (log_id, user_id) values (p_log_id, member_id);
  end loop;

  return updated_log;
end;
$$;

grant execute on function public.update_log(uuid, numeric, numeric, text, text, boolean, uuid[]) to authenticated;

-- Records that a debt between two group members was settled outside the
-- app, as a special log entry (is_settlement = true, never split further)
-- rather than a regular expense. Unlike create_log, paid_by here is
-- whichever of the two people was the debtor — which may not be the caller,
-- since either party (the debtor paying back, or the creditor marking it
-- received) can be the one who taps "Debt was settled". The two checks below
-- keep that flexibility from becoming a way to fabricate a settlement
-- between two OTHER people: the caller must be one of the two parties, and
-- the other party must actually be (or have been) a member of this group —
-- deliberately not required to still be active, since settling up with
-- someone who's since left the group is exactly the point of keeping their
-- balance visible after they leave.
create or replace function public.settle_debt(
  p_group_id uuid,
  p_paid_by uuid,
  p_other_user_id uuid,
  p_amount numeric,
  p_currency text
)
returns public.logs
language plpgsql
security definer
set search_path = public
as $$
declare
  new_log public.logs;
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'Not a member of this group';
  end if;

  if auth.uid() not in (p_paid_by, p_other_user_id) then
    raise exception 'You can only settle a debt you are a party to';
  end if;

  if p_paid_by = p_other_user_id then
    raise exception 'Cannot settle a debt with yourself';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_other_user_id
  ) then
    raise exception 'That person is not a member of this group';
  end if;

  -- Settlements are always created directly in the group's own currency
  -- (the client passes group.currency as p_currency), so converted_amount
  -- is just p_amount — no conversion needed at creation.
  insert into public.logs (group_id, amount, converted_amount, currency, details, paid_by, payer_included, is_settlement)
  values (p_group_id, p_amount, p_amount, p_currency, '', p_paid_by, false, true)
  returning * into new_log;

  insert into public.log_members (log_id, user_id) values (new_log.id, p_other_user_id);

  return new_log;
end;
$$;

grant execute on function public.settle_debt(uuid, uuid, uuid, numeric, text) to authenticated;

-- Changes a group's currency and rescales every existing log's
-- converted_amount from the old currency to the new one, so
-- calculateMemberBalances (which only ever reads converted_amount) never
-- needs to know a currency change happened. The rate comes from the shared
-- exchange_rates cache rather than a client-supplied number, so a stale or
-- manipulated rate can't be passed in — the client's only job beforehand is
-- to make sure that cache is fresh (see utils/exchange-rates.ts) before
-- calling this.
create or replace function public.change_group_currency(p_group_id uuid, p_new_currency text)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  old_currency text;
  rate numeric;
  updated_group public.groups;
begin
  if not public.is_group_admin(p_group_id) then
    raise exception 'Only an admin can change this group''s currency';
  end if;

  select currency into old_currency from public.groups where id = p_group_id;

  if old_currency = p_new_currency then
    select * into updated_group from public.groups where id = p_group_id;
    return updated_group;
  end if;

  select (rates ->> p_new_currency)::numeric into rate
  from public.exchange_rates
  where base_currency = old_currency;

  if rate is null then
    raise exception 'No cached exchange rate from % to %', old_currency, p_new_currency;
  end if;

  update public.logs
  set converted_amount = converted_amount * rate
  where group_id = p_group_id;

  update public.groups
  set currency = p_new_currency
  where id = p_group_id
  returning * into updated_group;

  return updated_group;
end;
$$;

grant execute on function public.change_group_currency(uuid, text) to authenticated;

-- Deletes a log entry the caller themselves logged (paid_by = auth.uid()),
-- e.g. to fix a mistaken entry. Scoped to your own logs only — not to
-- everyone in the group — since there's no admin/moderation concept in this
-- app; log_members for it cascade-deletes via the existing FK.
create or replace function public.delete_log(p_log_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.logs where id = p_log_id and paid_by = auth.uid()
  ) then
    raise exception 'You can only delete a log you created';
  end if;

  delete from public.logs where id = p_log_id;
end;
$$;

grant execute on function public.delete_log(uuid) to authenticated;

-- Lets a signed-in user preview a group by id before joining it (e.g. from
-- an invite link), without exposing every group in the database the way a
-- relaxed groups_select policy would (that would also leak into useGroups'
-- "select * from groups", which relies on groups_select meaning "my
-- groups"). Returns nothing if the id doesn't exist.
create or replace function public.get_group_preview(p_group_id uuid)
returns table (id uuid, name text, description text, currency text)
language sql
security definer
set search_path = public
stable
as $$
  select id, name, description, currency
  from public.groups
  where id = p_group_id;
$$;

grant execute on function public.get_group_preview(uuid) to authenticated;

-- Soft-leave: marks your own row inactive instead of deleting it, so
-- historical logs/balances stay intact for everyone else and rejoining
-- later (join_group below) reactivates this same row. Going through an RPC
-- rather than a raw client UPDATE keeps writes to this table scoped to
-- exactly "leave" and "join", instead of granting a broad UPDATE that could
-- touch any column.
--
-- Exception: if this leaves nobody else active in the group, there's no one
-- left who could ever see it again anyway (is_group_member would be false
-- for everyone), so the group itself is deleted outright instead of being
-- left behind as permanent dead weight. Deleting it cascades to
-- group_members/logs/log_members via their existing "on delete cascade" FKs.
-- The client independently checks the same "am I the last one" condition
-- before showing the confirmation dialog, so the person leaving is warned
-- first — but this server-side check is what's actually authoritative.
--
-- Separately: if the person leaving was the group's only active admin (and
-- other active members remain), the longest-standing remaining member is
-- auto-promoted — otherwise the group would be permanently stuck with no one
-- able to edit it or promote anyone else. The leaver's own is_admin is also
-- cleared here, so join_group's reactivation on a later rejoin always starts
-- them back out as a plain member rather than silently restoring admin
-- rights from a stale flag on the old row.
create or replace function public.leave_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining_active_count integer;
  next_admin_id uuid;
begin
  update public.group_members
  set left_at = now(), is_admin = false
  where group_id = p_group_id
    and user_id = auth.uid();

  select count(*) into remaining_active_count
  from public.group_members
  where group_id = p_group_id
    and left_at is null;

  if remaining_active_count = 0 then
    delete from public.groups where id = p_group_id;
    return;
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and left_at is null and is_admin = true
  ) then
    select user_id into next_admin_id
    from public.group_members
    where group_id = p_group_id and left_at is null
    order by joined_at asc
    limit 1;

    update public.group_members
    set is_admin = true
    where group_id = p_group_id and user_id = next_admin_id;
  end if;
end;
$$;

grant execute on function public.leave_group(uuid) to authenticated;

-- Promotes another active member to admin. Callable only by an existing
-- admin of the same group — not is_group_member, since only admins may
-- grant admin.
create or replace function public.promote_to_admin(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_group_admin(p_group_id) then
    raise exception 'Only an admin can promote a member';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_user_id and left_at is null
  ) then
    raise exception 'That person is not an active member of this group';
  end if;

  update public.group_members
  set is_admin = true
  where group_id = p_group_id and user_id = p_user_id;
end;
$$;

grant execute on function public.promote_to_admin(uuid, uuid) to authenticated;

-- Removes another active member from the group, admin-only. This is just
-- leave_group's same soft-delete (left_at = now(), is_admin = false) applied
-- to someone else's row instead of your own, so a kicked member's historical
-- logs/balances stay intact and they can rejoin later via an invite link
-- exactly like someone who left on their own — as a plain member, not
-- silently still an admin from a stale flag. Doesn't need leave_group's
-- zero-active-members/auto-promote handling: the caller is themselves an
-- active admin and isn't the target (self-kick is rejected below — use
-- leave_group for that), so at least one active member and admin always
-- remains after this runs.
create or replace function public.kick_member(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_group_admin(p_group_id) then
    raise exception 'Only an admin can remove a member';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'Use leave_group to remove yourself';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_user_id and left_at is null
  ) then
    raise exception 'That person is not an active member of this group';
  end if;

  update public.group_members
  set left_at = now(), is_admin = false
  where group_id = p_group_id and user_id = p_user_id;
end;
$$;

grant execute on function public.kick_member(uuid, uuid) to authenticated;

-- Joins a group, or reactivates a membership you'd previously left (same
-- row, same history) instead of erroring on the primary-key conflict a plain
-- insert would hit.
create or replace function public.join_group(p_group_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.group_members (group_id, user_id)
  values (p_group_id, auth.uid())
  on conflict (group_id, user_id) do update set left_at = null;
$$;

grant execute on function public.join_group(uuid) to authenticated;

-- Permanently deletes the caller's own account: leaves every group they're
-- still active in first (reusing leave_group's own admin hand-off /
-- auto-delete-when-empty logic rather than duplicating it here), then
-- deletes their auth.users row outright. That cascades to their profiles
-- row (profiles.id references auth.users on delete cascade) — the actual
-- identity erasure. groups.created_by, logs.paid_by, and
-- log_members.user_id are all "on delete set null" (see migration above)
-- specifically so this can never retroactively change another member's
-- historical balance; the client renders a null paid_by/member as
-- "Deleted user" instead.
create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_group_id uuid;
begin
  for target_group_id in
    select group_id from public.group_members
    where user_id = auth.uid() and left_at is null
  loop
    perform public.leave_group(target_group_id);
  end loop;

  delete from auth.users where id = auth.uid();
end;
$$;

grant execute on function public.delete_account() to authenticated;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- RLS policies only take effect once the role already has the underlying SQL
-- privilege on the table. Dashboard-created tables get this automatically;
-- tables created via the SQL Editor don't always inherit it, which is what
-- was causing "new row violates row-level security policy" on every insert.

grant usage on schema public to authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.groups to authenticated;
grant select, insert, update, delete on public.group_members to authenticated;
grant select, insert, delete on public.logs to authenticated;
grant select, insert on public.log_members to authenticated;
grant select, insert, update on public.exchange_rates to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.logs enable row level security;
alter table public.exchange_rates enable row level security;
alter table public.log_members enable row level security;

-- profiles: see your own profile, or anyone who shares a group with you.
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using (id = auth.uid() or public.shares_group_with(id));

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (id = auth.uid());

-- groups: see/edit groups you're a member of; anyone signed in can create
-- one. Previewing a group you're NOT a member of yet (e.g. from an invite
-- link) goes through get_group_preview below instead of relaxing this
-- policy, since useGroups()'s "select * from groups" also relies on this
-- policy to mean "only groups I'm actually in" for the main group list.
drop policy if exists "groups_select" on public.groups;
create policy "groups_select" on public.groups
  for select using (public.is_group_member(id));

drop policy if exists "groups_insert" on public.groups;
create policy "groups_insert" on public.groups
  for insert with check (created_by = auth.uid());

-- Only admins can edit name/description/currency (currency changes also go
-- through change_group_currency, which enforces the same check itself).
drop policy if exists "groups_update" on public.groups;
create policy "groups_update" on public.groups
  for update using (public.is_group_admin(id));

-- group_members: see membership rows (active and departed) for your own
-- groups. The insert/delete policies below are no longer exercised by the
-- app itself (join_group/leave_group above go through security definer RPCs
-- instead, so writes stay scoped to exactly those two operations), but are
-- left in place rather than removed.
drop policy if exists "group_members_select" on public.group_members;
create policy "group_members_select" on public.group_members
  for select using (public.is_group_member(group_id));

drop policy if exists "group_members_insert" on public.group_members;
create policy "group_members_insert" on public.group_members
  for insert with check (user_id = auth.uid());

drop policy if exists "group_members_delete" on public.group_members;
create policy "group_members_delete" on public.group_members
  for delete using (user_id = auth.uid());

-- Not exercised by the app (promote_to_admin/leave_group's auto-promote go
-- through security definer RPCs), kept for the same defense-in-depth
-- reasoning as the other unused policies in this file.
drop policy if exists "group_members_update" on public.group_members;
create policy "group_members_update" on public.group_members
  for update using (public.is_group_admin(group_id));

-- logs: any member of the group can read and add entries.
drop policy if exists "logs_select" on public.logs;
create policy "logs_select" on public.logs
  for select using (public.is_group_member(group_id));

drop policy if exists "logs_insert" on public.logs;
create policy "logs_insert" on public.logs
  for insert with check (public.is_group_member(group_id) and paid_by = auth.uid());

-- Not exercised by the app (delete_log above goes through a security
-- definer RPC), kept for the same defense-in-depth reasoning as the unused
-- group_members insert/delete policies elsewhere in this file.
drop policy if exists "logs_delete" on public.logs;
create policy "logs_delete" on public.logs
  for delete using (paid_by = auth.uid());

-- log_members: readable/insertable by members of the log's group.
drop policy if exists "log_members_select" on public.log_members;
create policy "log_members_select" on public.log_members
  for select using (
    exists (
      select 1 from public.logs
      where logs.id = log_members.log_id
        and public.is_group_member(logs.group_id)
    )
  );

drop policy if exists "log_members_insert" on public.log_members;
create policy "log_members_insert" on public.log_members
  for insert with check (
    exists (
      select 1 from public.logs
      where logs.id = log_members.log_id
        and public.is_group_member(logs.group_id)
    )
  );

-- exchange_rates: shared public market data, not tied to any user or group,
-- so any signed-in client can read it or refresh a stale row.
drop policy if exists "exchange_rates_select" on public.exchange_rates;
create policy "exchange_rates_select" on public.exchange_rates
  for select using (true);

drop policy if exists "exchange_rates_upsert" on public.exchange_rates;
create policy "exchange_rates_upsert" on public.exchange_rates
  for insert with check (true);

drop policy if exists "exchange_rates_update" on public.exchange_rates;
create policy "exchange_rates_update" on public.exchange_rates
  for update using (true);

-- ---------------------------------------------------------------------------
-- Storage (profile pictures)
-- ---------------------------------------------------------------------------
-- Public bucket: avatars aren't sensitive (roughly as exposed as a name
-- already is via profiles_select), and a public URL means the client can
-- render one directly without a signed-URL round trip. Each user gets a
-- single object at "{user_id}/avatar.jpg", overwritten on every re-upload
-- (upsert: true from the client) rather than accumulating old versions.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars_public_select" on storage.objects;
create policy "avatars_public_select" on storage.objects
  for select using (bucket_id = 'avatars');

-- storage.foldername(name) splits the object path on "/"; requiring its
-- first segment to equal the caller's own uid is what confines every write
-- to "{own_user_id}/..." and stops one user overwriting another's avatar.
drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own" on storage.objects
  for update using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own" on storage.objects
  for delete using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );
