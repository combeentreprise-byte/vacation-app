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

-- Trim any pre-existing overlong descriptions before adding the constraint
-- below, since `add constraint` validates all existing rows.
update public.groups set description = left(description, 150)
  where char_length(description) > 150;
alter table public.groups drop constraint if exists groups_description_length;
alter table public.groups add constraint groups_description_length
  check (char_length(description) <= 150);

-- Same pattern for the other free-text columns. Each limit mirrors a
-- constant in src/constants/limits.ts.
update public.groups set name = left(name, 50)
  where char_length(name) > 50;
alter table public.groups drop constraint if exists groups_name_length;
alter table public.groups add constraint groups_name_length
  check (char_length(name) <= 50);

update public.profiles set name = rtrim(left(name, 25))
  where char_length(name) > 25;
alter table public.profiles drop constraint if exists profiles_name_length;
alter table public.profiles add constraint profiles_name_length
  check (char_length(name) <= 25);

-- Which placeholder illustration + hue a group's hero shows (see HeroMotive
-- in the client) — chosen once, randomly, at create_group time and never
-- rerolled after, so it has to be stored rather than derived every render.
-- `motive` is a stable key (matches a HERO_MOTIVES entry client-side), not an
-- index, so it survives that array being reordered/extended later. No check
-- constraint on its value set, same as `currency` above: both are free-text,
-- validated app-side, since the allowed set grows over time.
alter table public.groups add column if not exists motive text;
alter table public.groups add column if not exists hue integer;
-- Existing rows predate this column and were backfilled out-of-band with the
-- same motive/hue their old hash-based derivation used to compute, so they
-- keep looking the same post-migration. Only run `set not null` below once
-- that backfill has actually landed on every row.
alter table public.groups alter column motive set not null;
alter table public.groups alter column hue set not null;

-- A real uploaded photo, picked at create_group time (see the group-photos
-- bucket further down). Nullable forever, unlike motive/hue above — "no
-- photo, show the placeholder motive" is a real, permanent state rather than
-- a migration gap, so GroupHero (src/components/hero-motive.tsx) checks this
-- first and only falls back to motive/hue when it's null.
alter table public.groups add column if not exists photo_url text;

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
-- Per-member (not per-group) so pinning a group only reorders your own group
-- list. A timestamp rather than a flag so the most recently pinned group sorts
-- first. Only ever written through set_group_pinned below.
alter table public.group_members add column if not exists pinned_at timestamptz;

-- The group's sponsor: whoever set up its group pass (set_up_plan), or
-- whoever took over when the sponsor before them left (leave_group). At most
-- one per group, always an admin as well (so every admin check covers them),
-- and on top of that they can't be removed (kick_member) and can demote
-- admins (demote_admin). Kept after the plan ends; setting up a new pass for
-- the group moves it to whoever set that one up. Cleared on leaving, like
-- is_admin, and never handed back on rejoining.
alter table public.group_members add column if not exists is_sponsor boolean not null default false;
alter table public.group_members drop constraint if exists group_members_sponsor_is_admin;
alter table public.group_members add constraint group_members_sponsor_is_admin
  check (not is_sponsor or is_admin);
create unique index if not exists group_members_one_sponsor_idx
  on public.group_members (group_id) where is_sponsor;
-- Set once someone leaves while sponsor, so leave_group never hands the role
-- back to them after a rejoin (rejoining keeps the old joined_at, which would
-- otherwise make them first in line). Setting up a new pass for the group
-- still makes them its sponsor again.
alter table public.group_members add column if not exists left_as_sponsor boolean not null default false;

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

-- Mirrors LOG_DETAILS_MAX_LENGTH in src/constants/limits.ts.
update public.logs set details = left(details, 100)
  where char_length(details) > 100;
alter table public.logs drop constraint if exists logs_details_length;
alter table public.logs add constraint logs_details_length
  check (char_length(details) <= 100);

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

-- Membership history shown in a group's Logs tab alongside its expenses:
-- who created the group, joined, left, was removed, became an admin, bought
-- a plan for the group, or was given one of its seats. Its own table rather
-- than more row types in `logs`, since logs is the ledger balances are
-- derived from (see calculateMemberBalances) and an amount-less event there
-- would have to be filtered back out of every piece of
-- balance/edit/delete/currency-rescale logic. Only ever written inside the
-- RPCs that make the change itself (create_group, join_group, leave_group,
-- kick_member, promote_to_admin, create_plan, assign_plan_seats), so an
-- event can't exist without its change or vice versa — clients get select
-- only.
--
-- actor_id is who did it: the creator, the joiner/leaver, the admin who
-- removed/promoted someone, the sponsor who bought a plan or whoever handed
-- out one of its seats, the sponsor who demoted an admin, or for
-- admin_auto_promoted / sponsor_handed_over, the admin / sponsor whose
-- leaving caused it. target_id is who it was done to (null for kinds with no
-- target). Both are "on delete set null" for the same reason as
-- logs.paid_by: a deleted account's history stays, just anonymized.
--
-- created_at defaults to clock_timestamp() rather than now(): leave_group
-- can write two events in one transaction (member_left, then
-- admin_auto_promoted), and now() is the transaction's start time, which
-- would give both the same timestamp and no defined order between them.
create table if not exists public.group_events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  kind text not null,
  actor_id uuid references public.profiles (id) on delete set null,
  target_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);

-- Mirrors GROUP_EVENT_KINDS in src/hooks/use-group-events.ts. A client
-- build older than a newly added kind just skips rows it doesn't recognize.
alter table public.group_events drop constraint if exists group_events_kind_check;
alter table public.group_events add constraint group_events_kind_check
  check (kind in (
    'group_created',
    'member_joined',
    'member_left',
    'member_kicked',
    'admin_promoted',
    'admin_auto_promoted',
    'admin_demoted',
    'sponsor_handed_over',
    'plan_started',
    'plan_seat_given',
    'plan_seat_removed'
  ));

create index if not exists group_events_group_id_created_at_idx
  on public.group_events (group_id, created_at desc);

-- What the plan looked like when a plan event happened, so the Logs tab can
-- show it as it was then (seats change afterwards, and a plan can end or be
-- upgraded). Null for every other kind. plan_started:
--   { plan_id, kind, seat_count, ends_at, will_renew, seat_holders: [uuid] }
--   (seat_holders: the seats it started with — they get no plan_seat_given
--   events of their own). plan_seat_given:
--   { plan_id, seat_count, seats_used, ends_at } (seats_used counts the one
--   just given).
alter table public.group_events add column if not exists details jsonb;

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
-- Plans (paid unlocks)
-- ---------------------------------------------------------------------------
-- Adding or editing an entry needs everyone on it (the payer, who is always
-- the caller, plus everyone it's split with) to be unlocked — see
-- check_entry_access below. Viewing, settling up and deleting your own
-- entries never do. A person is unlocked while they hold a seat on a running
-- plan. A plan is bought by its sponsor and is either "Just me" (group_id
-- null, one seat, always the sponsor's) or a group plan: tied to one group,
-- at most one running per group, with seats the sponsor hands out to that
-- group's active members. A seat unlocks its holder in every group, not just
-- the plan's own.
--
-- None of these tables are readable or writable by clients at all: every
-- read goes through get_my_access/get_group_access and every write through
-- the RPCs further down, so how someone paid or what a plan cost never
-- leaves the server.

-- Single row (the check pins its key to true). paywall_enabled starts off,
-- which leaves everyone unlocked until it's switched on by hand — and is the
-- way to switch the paywall back off if billing ever breaks.
-- free_entries_per_group mirrors FREE_ENTRIES_PER_GROUP in
-- src/constants/limits.ts, which the client only falls back to before it has
-- ever reached the server.
create table if not exists public.billing_settings (
  id boolean primary key default true check (id),
  paywall_enabled boolean not null default false,
  free_entries_per_group integer not null default 15 check (free_entries_per_group >= 0)
);

-- The free allowance was briefly 5 per person in each group
-- (free_entries_per_user). Every group now shares one pool of 15, and every
-- group starts it fresh (see free_entry_usage).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'billing_settings'
      and column_name = 'free_entries_per_user'
  ) then
    alter table public.billing_settings rename column free_entries_per_user to free_entries_per_group;
    alter table public.billing_settings alter column free_entries_per_group set default 15;
    update public.billing_settings set free_entries_per_group = 15;
  end if;
end $$;

insert into public.billing_settings (id) values (true) on conflict (id) do nothing;

-- free_test_purchases lets *every* account "buy" plans for free through
-- test_purchase_plan (the paywall can be tried for real before payments
-- exist). Switch it off once real store purchases ship.
alter table public.billing_settings
  add column if not exists free_test_purchases boolean not null default false;

-- Accounts allowed to "buy" plans for free through test_purchase_plan even
-- while free_test_purchases is off. Only ever filled in by hand.
create table if not exists public.billing_testers (
  user_id uuid primary key references public.profiles (id) on delete cascade
);

-- sponsor_id and group_id are "on delete set null" so a plan outlives its
-- sponsor's account and its group: everyone holding a seat keeps it until
-- ends_at either way. will_renew is only ever true for a subscription that
-- hasn't been cancelled. store_transaction_id makes granting a store
-- purchase safe to repeat.
-- A Trip Pass is bought before it's set up: until its sponsor picks when it
-- starts (and, for a group size, which group it's for) through set_up_plan,
-- starts_at/ends_at are null, it has no seats and doesn't count down.
-- duration is how long it runs once started. A subscription is always
-- "Just me" and starts the moment it's bought.
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid references public.profiles (id) on delete set null,
  group_id uuid references public.groups (id) on delete set null,
  kind text not null check (kind in ('trip_pass', 'subscription')),
  seat_count integer not null check (seat_count > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  duration interval not null,
  will_renew boolean not null default false,
  source text not null check (source in ('test', 'comp', 'store')),
  product_id text,
  store_transaction_id text unique,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  constraint plans_set_up_check check ((starts_at is null) = (ends_at is null))
);

-- Every plan used to start the moment it was bought.
alter table public.plans add column if not exists duration interval;
update public.plans set duration = ends_at - starts_at where duration is null;
alter table public.plans alter column duration set not null;
alter table public.plans alter column starts_at drop default;
alter table public.plans alter column starts_at drop not null;
alter table public.plans alter column ends_at drop not null;
alter table public.plans drop constraint if exists plans_set_up_check;
alter table public.plans add constraint plans_set_up_check
  check ((starts_at is null) = (ends_at is null));

create index if not exists plans_group_id_idx on public.plans (group_id);
create index if not exists plans_sponsor_id_idx on public.plans (sponsor_id);

-- Until a pass starts, its manager can take a seat back and give it to
-- someone else (remove_plan_seat) — it hasn't unlocked anyone yet — and
-- leaving or being removed from the group takes it back by itself
-- (free_pending_plan_seat), as does deleting the account (delete_account).
-- Once it has started, a seat stays with its holder for the whole plan, no
-- matter what: leaving or being removed from the group doesn't free it (they
-- stay unlocked, in any group), and neither does deleting their account —
-- user_id just becomes null, and the seat stays taken. So a sponsor can never
-- pass one seat around to cover more people than they paid for. Nothing
-- releases a started plan's seat today; released_at is kept for when
-- something will (e.g. a refund), and every check already counts only
-- unreleased seats.
create table if not exists public.plan_seats (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  assigned_at timestamptz not null default now(),
  released_at timestamptz
);

-- Seats used to be freed by deleting the account (on delete cascade).
alter table public.plan_seats alter column user_id drop not null;
alter table public.plan_seats drop constraint if exists plan_seats_user_id_fkey;
alter table public.plan_seats add constraint plan_seats_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete set null;

create unique index if not exists plan_seats_one_per_holder_idx
  on public.plan_seats (plan_id, user_id) where released_at is null;
create index if not exists plan_seats_user_id_idx on public.plan_seats (user_id);

alter table public.groups drop column if exists logged_entries;

-- How many of its free entries each group has used, shared by all its
-- members (see check_entry_access). Only ever counts up, so deleting an entry
-- doesn't hand a free one back. No row yet means none used. No client access
-- at all, or anyone could hand their group fresh free entries.
-- (Was counted per person, first across all groups, then in each group; both
-- versions had a user_id and are dropped rather than migrated, so every group
-- starts its shared pool fresh.)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'free_entry_usage' and column_name = 'user_id'
  ) then
    drop table public.free_entry_usage;
  end if;
end $$;

create table if not exists public.free_entry_usage (
  group_id uuid primary key references public.groups (id) on delete cascade,
  used integer not null default 0 check (used >= 0)
);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
-- Every notification the app sends, with its wording, is listed in
-- docs/notifications.md. They're written into `notifications` by the
-- server itself, in the same transaction as the change they're about (the
-- RPCs, a trigger on group_events and one on groups), or by the scheduled
-- send_scheduled_notifications for reminders — never by a client. The
-- send-notifications Edge Function then pushes them to the person's devices
-- (push_tokens) through Expo's push service, kicked off every minute by
-- pg_cron (trigger_notification_sender).

-- One row per person, only once they've changed something (or the app has
-- recorded their time zone): no row means the defaults. categories maps a
-- switch in Account → Notifications (NotificationCategory in
-- src/constants/notifications.ts) to on/off; a missing key is its default
-- (notification_category_on). time_zone is the device's, so dates in
-- notifications ("ends on 12 Oct") are the person's own day.
create table if not exists public.notification_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  all_muted boolean not null default false,
  categories jsonb not null default '{}'::jsonb,
  time_zone text not null default 'UTC',
  updated_at timestamptz not null default now()
);

-- One row per device that can receive pushes: an Expo push token, moved to
-- whoever signs in on that device last (register_push_token) and removed on
-- signing out (unregister_push_token) or once Expo says the app was
-- uninstalled (remove_push_tokens).
create table if not exists public.push_tokens (
  token text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  updated_at timestamptz not null default now()
);

create index if not exists push_tokens_user_id_idx on public.push_tokens (user_id);

-- kind is the notification's id in docs/notifications.md terms (e.g.
-- 'entry_added'), category the switch it belongs to ('always' for the ones
-- that can't be turned off). url is the app route a tap opens.
-- merge_key: notifications of the same kind about the same thing (an
-- entry payer, a group's joiners) that are still waiting to be sent are
-- merged into one ("Anna added 3 entries with you…"); merge_data holds what
-- the merged wording needs (notification_merged_body). Those wait
-- 2 minutes (send_after) so there's something to merge with.
-- dedupe_key: a reminder is only ever sent once per person (e.g.
-- 'plan_ending:<plan>:<end>').
-- sent_at: when the sender picked it up (whether or not the person had a
-- device to send it to).
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  category text not null,
  group_id uuid references public.groups (id) on delete cascade,
  title text not null,
  body text not null,
  url text,
  merge_key text,
  merge_data jsonb,
  dedupe_key text,
  send_after timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists notifications_dedupe_idx
  on public.notifications (user_id, dedupe_key) where dedupe_key is not null;
create index if not exists notifications_unsent_idx
  on public.notifications (send_after) where sent_at is null;
create index if not exists notifications_user_id_idx
  on public.notifications (user_id, created_at desc);

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

create or replace function public.is_group_sponsor(target_group_id uuid)
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
      and is_sponsor = true
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

-- When p_user_id's unlock runs out, counting only seats they held at p_at on
-- plans running at p_at — null if they weren't unlocked then. Ignores
-- billing_settings.paywall_enabled; callers apply that switch themselves.
-- Not callable by clients (see the grants section): it answers for any user.
create or replace function public.unlocked_until(p_user_id uuid, p_at timestamptz default now())
returns timestamptz
language sql
security definer
set search_path = public
stable
as $$
  select max(p.ends_at)
  from public.plan_seats s
  join public.plans p on p.id = s.plan_id
  where s.user_id = p_user_id
    and s.assigned_at <= p_at
    and (s.released_at is null or s.released_at > p_at)
    and p.starts_at <= p_at
    and p.ends_at > p_at;
$$;

-- Whether p_user_id will be unlocked at p_at, a moment that may still be
-- ahead (when a pass is set up to start): unlocked_until, plus a running
-- subscription of theirs that renews, which counts as covering any later
-- date. A subscription is treated as if it's never cancelled; whoever
-- cancels one later takes that on themselves. Callers renew lapsed test
-- subscriptions first, so a running one hasn't lapsed just for want of a
-- read. Not callable by clients, same as unlocked_until.
create or replace function public.unlocked_on(p_user_id uuid, p_at timestamptz)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.unlocked_until(p_user_id, p_at) is not null
    or exists (
      select 1
      from public.plan_seats s
      join public.plans p on p.id = s.plan_id
      where s.user_id = p_user_id
        and s.released_at is null
        and p.kind = 'subscription'
        and p.will_renew
        and p.starts_at <= now()
        and p.ends_at > now()
        and p.starts_at <= p_at
    );
$$;

-- Who hands out a group plan's seats: the group's sponsor (group_members.
-- is_sponsor) — whoever set the pass up, or whoever took over from them when
-- they left (leave_group), so a sponsor leaving or deleting their account
-- mid-trip doesn't strand the seats everyone else's unlock depends on, and
-- rejoining doesn't hand it back. Only if the group somehow has no sponsor,
-- its admins. A "Just me" plan has no one to hand seats to.
create or replace function public.can_manage_plan(p_plan_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.plans p
    where p.id = p_plan_id
      and p.group_id is not null
      and (
        public.is_group_sponsor(p.group_id)
        or (
          public.is_group_admin(p.group_id)
          and not exists (
            select 1 from public.group_members gm
            where gm.group_id = p.group_id and gm.is_sponsor
          )
        )
      )
  );
$$;

-- Takes p_user_id's seat back on p_group_id's pass that hasn't started yet,
-- called when they leave the group (leave_group) or are removed from it
-- (kick_member) — a seat that never unlocked them shouldn't stay held for
-- someone who may never come back. Its manager can give it to someone else,
-- or back to them if they rejoin, before or after the start
-- (assign_plan_seats). Records plan_seat_removed with p_actor_id (the
-- leaver themselves, or whoever removed them). Returns that pass, or null if
-- the group has none still to start. Seats on a pass that has started stay
-- with their holder (see plan_seats). Not callable by clients (see the grants
-- section).
create or replace function public.free_pending_plan_seat(
  p_group_id uuid,
  p_user_id uuid,
  p_actor_id uuid
)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
declare
  pending_plan public.plans;
begin
  select * into pending_plan
  from public.plans
  where group_id = p_group_id and starts_at > now()
  for update;

  if not found then
    return null;
  end if;

  delete from public.plan_seats
  where plan_id = pending_plan.id and user_id = p_user_id and released_at is null;

  if found then
    insert into public.group_events (group_id, kind, actor_id, target_id, details)
    values (
      p_group_id, 'plan_seat_removed', p_actor_id, p_user_id,
      jsonb_build_object(
        'plan_id', pending_plan.id,
        'seat_count', pending_plan.seat_count,
        'seats_used', (
          select count(*) from public.plan_seats
          where plan_id = pending_plan.id and released_at is null
        ),
        'starts_at', pending_plan.starts_at,
        'ends_at', pending_plan.ends_at
      )
    );
  end if;

  return pending_plan;
end;
$$;

-- Lets an entry being added or edited through, or raises PT402. It goes
-- through when the caller and every person in p_member_ids are unlocked at
-- p_at, or failing that all are now; otherwise it uses up one of p_group_id's
-- free entries (each group shares billing_settings.free_entries_per_group,
-- counted in free_entry_usage), and only once those are gone is it refused.
-- Checking now as well is what lets an entry the paywall held back (see
-- use-logs.tsx) through once everyone on it is unlocked: p_at is when it was
-- typed, which a plan bought or a seat given afterwards doesn't cover.
-- While the group has free entries, anyone can add one split with anyone;
-- after that, only unlocked people can, among themselves.
-- Skipped entirely while the paywall is off. PT402 is what the client's
-- offline queue looks for to hold an entry rather than drop it (see
-- use-logs.tsx), and PostgREST answers it with HTTP 402. A null in
-- p_member_ids is a deleted account's slot kept on an edited entry: there's
-- no one left to unlock, so it doesn't count against it.
-- (Briefly took no group id, when free entries weren't per group.)
drop function if exists public.check_entry_access(uuid[], timestamptz);
create or replace function public.check_entry_access(
  p_group_id uuid,
  p_member_ids uuid[],
  p_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.billing_settings;
  caller_unlocked boolean;
  used_count integer;
  locked_names text[];
  name_list text;
  check_at timestamptz;
begin
  select * into settings from public.billing_settings;
  if not coalesce(settings.paywall_enabled, false) then
    return;
  end if;

  perform public.renew_test_subscriptions();

  -- p_at first, then now (the same moment for an entry made just now). The
  -- refusal below explains what the last check found.
  foreach check_at in array
    case when p_at < now() then array[p_at, now()] else array[p_at] end
  loop
    caller_unlocked := public.unlocked_until(auth.uid(), check_at) is not null;

    select array_agg(coalesce(pr.name, 'Someone') order by pr.name)
    into locked_names
    from (
      select distinct member_id
      from unnest(p_member_ids) as member_id
      where member_id is not null and member_id <> auth.uid()
    ) people
    left join public.profiles pr on pr.id = people.member_id
    where public.unlocked_until(people.member_id, check_at) is null;

    if caller_unlocked and locked_names is null then
      return;
    end if;
  end loop;

  -- Locked until this commits, so two entries racing for the group's last
  -- free entry can't both get it.
  insert into public.free_entry_usage (group_id) values (p_group_id)
  on conflict (group_id) do nothing;
  select used into used_count from public.free_entry_usage
  where group_id = p_group_id
  for update;

  if used_count < settings.free_entries_per_group then
    update public.free_entry_usage set used = used + 1
    where group_id = p_group_id
    returning used into used_count;
    -- Down to the last 3, or all used: tell everyone locked in the group.
    if used_count in (settings.free_entries_per_group - 3, settings.free_entries_per_group) then
      perform public.notify_free_entries(
        p_group_id, settings.free_entries_per_group - used_count, settings.free_entries_per_group
      );
    end if;
    return;
  end if;

  if not caller_unlocked then
    raise exception 'This group''s free entries are used up, so you need an unlock to add or edit entries.'
      using errcode = 'PT402';
  end if;

  name_list := case
    when cardinality(locked_names) = 1 then locked_names[1]
    else array_to_string(locked_names[1:cardinality(locked_names) - 1], ', ')
      || ' and ' || locked_names[cardinality(locked_names)]
  end;
  raise exception '% % unlocked, so they can''t be on entries yet.',
    name_list,
    case when cardinality(locked_names) = 1 then 'isn''t' else 'aren''t' end
    using errcode = 'PT402';
end;
$$;

-- Auto-create a profile row whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Truncated to the profiles_name_length limit: the name can come from an
  -- OAuth provider's metadata, which we don't control, and an overlong one
  -- would otherwise violate the constraint and fail the whole sign-up.
  insert into public.profiles (id, name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'name', 'Your Name'), 25));
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
-- Superseded by the 6-arg version below (adds group_photo_url); dropped
-- explicitly since "create or replace" can't change a function's argument
-- list in place and would otherwise leave this old overload lying around.
drop function if exists public.create_group(text, text, text);
drop function if exists public.create_group(text, text, text, text, integer);

create or replace function public.create_group(
  group_name text,
  group_description text,
  group_currency text,
  group_motive text,
  group_hue integer,
  group_photo_url text default null
)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  new_group public.groups;
begin
  insert into public.groups (name, description, currency, motive, hue, photo_url, created_by)
  values (group_name, group_description, group_currency, group_motive, group_hue, group_photo_url, auth.uid())
  returning * into new_group;

  insert into public.group_members (group_id, user_id, is_admin)
  values (new_group.id, auth.uid(), true);

  insert into public.group_events (group_id, kind, actor_id)
  values (new_group.id, 'group_created', auth.uid());

  return new_group;
end;
$$;

grant execute on function public.create_group(text, text, text, text, integer, text) to authenticated;

-- Superseded by the 7-arg version below (adds p_converted_amount); dropped
-- explicitly since "create or replace" can't change a function's argument
-- list in place and would otherwise leave this old overload lying around.
drop function if exists public.create_log(uuid, numeric, text, text, boolean, uuid[]);
-- Superseded by the 10-arg version below (adds the offline-sync params);
-- same reason for the explicit drop.
drop function if exists public.create_log(uuid, numeric, numeric, text, text, boolean, uuid[]);

-- Same atomicity reasoning as create_group: a log and the list of who it was
-- split with need to land together, not as two separate client calls that
-- could be interrupted in between.
--
-- The last three params exist for offline entry (see use-logs.tsx's pending
-- queue), where a log can be created on the device long before it reaches
-- here:
--   p_id — the client-generated id. Makes a retry idempotent: if a previous
--     attempt landed but its response never made it back, the retry returns
--     the existing row instead of inserting the expense twice.
--   p_created_at — when the entry was actually made, not when it synced
--     (clamped to now(), so a skewed device clock can't date it in the future).
--   p_converted_currency — the currency p_converted_amount was computed in.
--     If the group's currency changed while the entry sat in the queue,
--     change_group_currency never saw it, so it's rescaled here instead,
--     from the same shared exchange_rates cache.
--
-- Also where the paywall applies (check_entry_access).
create or replace function public.create_log(
  p_group_id uuid,
  p_amount numeric,
  p_converted_amount numeric,
  p_currency text,
  p_details text,
  p_payer_included boolean,
  p_member_ids uuid[],
  p_id uuid default null,
  p_created_at timestamptz default null,
  p_converted_currency text default null
)
returns public.logs
language plpgsql
security definer
set search_path = public
as $$
declare
  new_log public.logs;
  member_id uuid;
  group_currency text;
  converted numeric := p_converted_amount;
  rate numeric;
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'Not a member of this group';
  end if;

  -- Already synced by an earlier attempt whose response never made it back.
  -- Checked before the paywall below, so that retry still gets its row back
  -- even if the group has used up its free entries or someone's plan has
  -- ended in the meantime. Only handed back if it's genuinely the caller's
  -- own retry, not someone guessing another log's id.
  if p_id is not null then
    select * into new_log from public.logs where id = p_id;
    if found then
      if new_log.paid_by is distinct from auth.uid() then
        raise exception 'Log id already in use';
      end if;
      return new_log;
    end if;
  end if;

  select currency into group_currency from public.groups where id = p_group_id;

  -- Judged at when the entry was typed rather than when it synced, so one
  -- made offline on a plan's last evening still goes through the next
  -- morning. Never more than 7 days back, which caps how far a hand-picked
  -- p_created_at could reach into a plan that has ended.
  perform public.check_entry_access(
    p_group_id,
    p_member_ids,
    greatest(least(coalesce(p_created_at, now()), now()), now() - interval '7 days')
  );

  if p_converted_currency is not null and p_converted_currency <> group_currency then
    select (rates ->> group_currency)::numeric into rate
    from public.exchange_rates
    where base_currency = p_converted_currency;

    if rate is null then
      select 1 / nullif((rates ->> p_converted_currency)::numeric, 0) into rate
      from public.exchange_rates
      where base_currency = group_currency;
    end if;

    if rate is null then
      raise exception 'No cached exchange rate from % to %', p_converted_currency, group_currency;
    end if;

    converted := p_converted_amount * rate;
  end if;

  insert into public.logs (id, group_id, amount, converted_amount, currency, details, paid_by, payer_included, created_at)
  values (
    coalesce(p_id, gen_random_uuid()),
    p_group_id,
    p_amount,
    converted,
    p_currency,
    p_details,
    auth.uid(),
    p_payer_included,
    least(p_created_at, now())
  )
  on conflict (id) do nothing
  returning * into new_log;

  if new_log.id is null then
    -- A concurrent retry of the same entry got here first (the lookup at
    -- the top ran before it committed). Same ownership check as there.
    select * into new_log from public.logs where id = p_id;
    if new_log.paid_by is distinct from auth.uid() then
      raise exception 'Log id already in use';
    end if;
    return new_log;
  end if;

  foreach member_id in array p_member_ids loop
    insert into public.log_members (log_id, user_id) values (new_log.id, member_id);
  end loop;

  perform public.notify_entry_added(new_log.id);

  return new_log;
end;
$$;

grant execute on function public.create_log(uuid, numeric, numeric, text, text, boolean, uuid[], uuid, timestamptz, text) to authenticated;

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
--
-- Editing needs everyone on the edited entry unlocked, same as adding one
-- (check_entry_access), or one unlocked person could keep raising an old
-- entry's amount and use it as a free running total for the whole group.
-- Deleting stays free (delete_log), so a mistake can always be undone.
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
  old_members uuid[];
  old_share numeric;
begin
  if not exists (
    select 1 from public.logs
    where id = p_log_id and paid_by = auth.uid() and is_settlement = false
  ) then
    raise exception 'You can only edit a log you created';
  end if;

  -- The entry as it was, for notify_entry_changed.
  old_members := array(
    select user_id from public.log_members where log_id = p_log_id and user_id is not null
  );
  old_share := public.notification_log_share(p_log_id);

  perform public.check_entry_access(
    (select group_id from public.logs where id = p_log_id),
    p_member_ids,
    now()
  );

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

  perform public.notify_entry_changed(p_log_id, old_members, old_share);

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
--
-- Never behind the paywall, unlike create_log/update_log: settling up has to
-- keep working after everyone's plan has ended. p_amount isn't checked
-- against the real balance (the app always passes the exact balance, but a
-- hand-made API call could record any amount) — a known, accepted gap.
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

  perform public.notify_settlement(new_log.id);

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

  perform public.notify_entry_deleted(p_log_id);

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
--
-- The sponsor role is handed off the same way, first: if the leaver was the
-- group's sponsor, it goes to the longest-standing remaining admin, or the
-- longest-standing remaining member if there's no other admin (who then
-- becomes an admin too, since a sponsor always is one). The leaver's
-- is_sponsor is cleared like is_admin, so they don't get it back on a
-- rejoin — the app warns them before they leave.
--
-- A seat the leaver holds on the group's pass that hasn't started yet is
-- taken back (free_pending_plan_seat); if they were the sponsor, the new one
-- gets a seat in their place when they need one.
--
-- Records a member_left event, plus a sponsor_handed_over / an
-- admin_auto_promoted one (actor = the leaver, target = the new sponsor /
-- admin) when a hand-off above happens. Only an active member can leave:
-- calling this for a group you're not active in does nothing, rather than
-- recording a second "left" or running the hand-off/delete checks on
-- someone else's behalf.
create or replace function public.leave_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining_active_count integer;
  next_admin_id uuid;
  next_sponsor_id uuid;
  was_sponsor boolean;
  pending_plan public.plans;
begin
  -- Locked, so a concurrent leave can't read the role before this clears it.
  select is_sponsor into was_sponsor
  from public.group_members
  where group_id = p_group_id
    and user_id = auth.uid()
    and left_at is null
  for update;

  if not found then
    return;
  end if;

  update public.group_members
  set left_at = now(), is_admin = false, is_sponsor = false, pinned_at = null,
    left_as_sponsor = left_as_sponsor or was_sponsor
  where group_id = p_group_id
    and user_id = auth.uid()
    and left_at is null;

  select count(*) into remaining_active_count
  from public.group_members
  where group_id = p_group_id
    and left_at is null;

  if remaining_active_count = 0 then
    delete from public.groups where id = p_group_id;
    return;
  end if;

  insert into public.group_events (group_id, kind, actor_id)
  values (p_group_id, 'member_left', auth.uid());

  -- Their seat on a pass that hasn't started goes back to whoever manages it.
  pending_plan := public.free_pending_plan_seat(p_group_id, auth.uid(), auth.uid());

  if was_sponsor then
    select user_id into next_sponsor_id
    from public.group_members
    where group_id = p_group_id and left_at is null and not left_as_sponsor
    order by is_admin desc, joined_at asc
    limit 1;

    -- Nobody left who hasn't given the role up before: the group goes
    -- without a sponsor, and its admins manage the plan (can_manage_plan).
    if next_sponsor_id is not null then
      update public.group_members
      set is_sponsor = true, is_admin = true
      where group_id = p_group_id and user_id = next_sponsor_id;

      insert into public.group_events (group_id, kind, actor_id, target_id)
      values (p_group_id, 'sponsor_handed_over', auth.uid(), next_sponsor_id);
    else
      -- G9 in docs/notifications.md (every other hand-off is notified from
      -- its group_events row).
      for next_admin_id in
        select user_id from public.group_members
        where group_id = p_group_id and left_at is null and is_admin and user_id is not null
      loop
        perform public.notify(
          next_admin_id, 'sponsor_none', 'groupChanges', p_group_id,
          (select name from public.groups where id = p_group_id),
          public.notification_name(auth.uid())
            || ' left and the group has no sponsor now — admins manage its pass',
          '/group/' || p_group_id
        );
      end loop;
      next_admin_id := null;
    end if;

    -- On a pass that hasn't started yet, the duty to hold a seat passes on
    -- with the role: the new sponsor gets one (likely the leaver's, just
    -- freed above) unless something else unlocks them when it starts (the
    -- same rule as set_up_plan) or the pass is full — then it's up to them
    -- to make room (remove_plan_seat won't take their own).
    if pending_plan.id is not null then
      perform public.renew_test_subscriptions();
      if next_sponsor_id is not null
        and not exists (
          select 1 from public.plan_seats
          where plan_id = pending_plan.id and user_id = next_sponsor_id and released_at is null
        )
        and not public.unlocked_on(next_sponsor_id, pending_plan.starts_at)
        and (
          select count(*) from public.plan_seats
          where plan_id = pending_plan.id and released_at is null
        ) < pending_plan.seat_count then
        insert into public.plan_seats (plan_id, user_id) values (pending_plan.id, next_sponsor_id);
        insert into public.group_events (group_id, kind, actor_id, target_id, details)
        values (
          p_group_id, 'plan_seat_given', auth.uid(), next_sponsor_id,
          jsonb_build_object(
            'plan_id', pending_plan.id,
            'seat_count', pending_plan.seat_count,
            'seats_used', (
              select count(*) from public.plan_seats
              where plan_id = pending_plan.id and released_at is null
            ),
            'ends_at', pending_plan.ends_at
          )
        );
      end if;
    end if;
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

    insert into public.group_events (group_id, kind, actor_id, target_id)
    values (p_group_id, 'admin_auto_promoted', auth.uid(), next_admin_id);
  end if;
end;
$$;

grant execute on function public.leave_group(uuid) to authenticated;

-- Promotes another active member to admin. Callable only by an existing
-- admin of the same group — not is_group_member, since only admins may
-- grant admin.
--
-- The update itself carries the "active, not yet an admin" conditions (not
-- a separate check beforehand), so two admins promoting the same person at
-- once can't both record an admin_promoted event: the second update
-- re-checks the row after the first commits and matches nothing. Promoting
-- someone who's already an admin is a no-op rather than an error.
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

  update public.group_members
  set is_admin = true
  where group_id = p_group_id
    and user_id = p_user_id
    and left_at is null
    and is_admin = false;

  if not found then
    if exists (
      select 1 from public.group_members
      where group_id = p_group_id and user_id = p_user_id and left_at is null
    ) then
      return;
    end if;
    raise exception 'That person is not an active member of this group';
  end if;

  insert into public.group_events (group_id, kind, actor_id, target_id)
  values (p_group_id, 'admin_promoted', auth.uid(), p_user_id);
end;
$$;

grant execute on function public.promote_to_admin(uuid, uuid) to authenticated;

-- Removes another active member from the group, admin-only. This is just
-- leave_group's same soft-delete (left_at = now(), is_admin = false, pinned_at = null) applied
-- to someone else's row instead of your own, so a kicked member's historical
-- logs/balances stay intact and they can rejoin later via an invite link
-- exactly like someone who left on their own — as a plain member, not
-- silently still an admin from a stale flag. Doesn't need leave_group's
-- zero-active-members/auto-promote handling: the caller is themselves an
-- active admin and isn't the target (self-kick is rejected below — use
-- leave_group for that), so at least one active member and admin always
-- remains after this runs.
--
-- Same conditional-update shape as promote_to_admin, for the same reason:
-- two admins removing the same person at once record one member_kicked
-- event, and the second gets the "not an active member" error.
--
-- The group's sponsor can't be removed by anyone (the update skips them),
-- so the sponsor role never needs a hand-off here. A seat the removed member
-- holds on the group's pass that hasn't started yet is taken back
-- (free_pending_plan_seat), same as when they leave.
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

  update public.group_members
  set left_at = now(), is_admin = false, pinned_at = null
  where group_id = p_group_id and user_id = p_user_id and left_at is null
    and is_sponsor = false;

  if not found then
    if exists (
      select 1 from public.group_members
      where group_id = p_group_id and user_id = p_user_id and is_sponsor
    ) then
      raise exception 'The group''s sponsor can''t be removed';
    end if;
    raise exception 'That person is not an active member of this group';
  end if;

  insert into public.group_events (group_id, kind, actor_id, target_id)
  values (p_group_id, 'member_kicked', auth.uid(), p_user_id);

  perform public.free_pending_plan_seat(p_group_id, p_user_id, auth.uid());
end;
$$;

grant execute on function public.kick_member(uuid, uuid) to authenticated;

-- Takes admin away from another active member, sponsor-only. The sponsor
-- stays an admin themselves (it's part of the role), so the group always
-- keeps at least one. Same conditional-update shape as promote_to_admin:
-- demoting someone who isn't an admin is a no-op, and two demotions at once
-- record one admin_demoted event.
create or replace function public.demote_admin(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_group_sponsor(p_group_id) then
    raise exception 'Only the group''s sponsor can demote an admin';
  end if;

  update public.group_members
  set is_admin = false
  where group_id = p_group_id
    and user_id = p_user_id
    and left_at is null
    and is_admin = true
    and is_sponsor = false;

  if not found then
    if p_user_id = auth.uid() then
      raise exception 'The sponsor is always an admin';
    end if;
    if exists (
      select 1 from public.group_members
      where group_id = p_group_id and user_id = p_user_id and left_at is null
    ) then
      return;
    end if;
    raise exception 'That person is not an active member of this group';
  end if;

  insert into public.group_events (group_id, kind, actor_id, target_id)
  values (p_group_id, 'admin_demoted', auth.uid(), p_user_id);
end;
$$;

grant execute on function public.demote_admin(uuid, uuid) to authenticated;

-- Pins/unpins a group on the caller's own group list, capped at 3 pinned
-- groups (mirrors MAX_PINNED_GROUPS in src/constants/limits.ts). An RPC
-- rather than a new self-update RLS policy on group_members, since that
-- policy would also let a member flip their own is_admin.
create or replace function public.set_group_pinned(p_group_id uuid, p_pinned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  if p_pinned and (
    select count(*) from public.group_members
    where user_id = auth.uid()
      and left_at is null
      and pinned_at is not null
      and group_id <> p_group_id
  ) >= 3 then
    raise exception 'You can pin at most 3 groups';
  end if;

  update public.group_members
  set pinned_at = case
    when not p_pinned then null
    else coalesce(pinned_at, now())
  end
  where group_id = p_group_id
    and user_id = auth.uid();
end;
$$;

grant execute on function public.set_group_pinned(uuid, boolean) to authenticated;

-- Joins a group, or reactivates a membership you'd previously left (same
-- row, same history) instead of erroring on the primary-key conflict a plain
-- insert would hit. Records a member_joined event only when one of those
-- actually happened — opening an invite link to a group you're already
-- active in leaves the row untouched (the conflict update's `where` doesn't
-- match), so it isn't recorded as another join.
create or replace function public.join_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A group holds at most 15 active members (GROUP_MEMBER_LIMIT in
  -- src/constants/limits.ts). Locked until this commits, so two people
  -- joining at once can't both take the last place.
  perform 1 from public.groups where id = p_group_id for update;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = auth.uid() and left_at is null
  ) and (
    select count(*) from public.group_members
    where group_id = p_group_id and left_at is null
  ) >= 15 then
    raise exception 'This group is full — it already has 15 members';
  end if;

  insert into public.group_members (group_id, user_id)
  values (p_group_id, auth.uid())
  on conflict (group_id, user_id) do update set left_at = null
    where group_members.left_at is not null;

  if found then
    insert into public.group_events (group_id, kind, actor_id)
    values (p_group_id, 'member_joined', auth.uid());
  end if;
end;
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
-- "Deleted user" instead. Their seats on passes that haven't started yet
-- are freed for someone else (they never unlocked anyone, and a deleted
-- account's seat can't be taken back by hand: remove_plan_seat has no one
-- to name); seats on started plans stay taken, just anonymized
-- (plan_seats.user_id is "on delete set null", see plan_seats), and plans
-- they sponsored keep running for everyone else (plans.sponsor_id is "on
-- delete set null").
create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_group_id uuid;
begin
  -- So leave_group's member_left notification says the account was deleted.
  perform set_config('app.deleting_account', 'on', true);

  for target_group_id in
    select group_id from public.group_members
    where user_id = auth.uid() and left_at is null
  loop
    perform public.leave_group(target_group_id);
  end loop;

  delete from public.plan_seats s
  using public.plans p
  where s.plan_id = p.id
    and s.user_id = auth.uid()
    and s.released_at is null
    and p.starts_at > now();

  delete from auth.users where id = auth.uid();
end;
$$;

grant execute on function public.delete_account() to authenticated;

-- Creates a bought plan. Not callable by clients (see the grants section):
-- today its only caller is test_purchase_plan, later whatever grants a
-- verified store purchase, which p_store_transaction_id makes safe to
-- repeat. A subscription is always "Just me" and starts right away, with its
-- one seat for the sponsor. A Trip Pass (any size) starts out not set up —
-- no group, no start, no seats — until its sponsor sets it up (set_up_plan).
-- (Used to take the group and its first seat holders, and start at once.)
drop function if exists public.create_plan(
  uuid, uuid, text, integer, interval, boolean, text, uuid[], text, text
);
create or replace function public.create_plan(
  p_sponsor_id uuid,
  p_kind text,
  p_seat_count integer,
  p_duration interval,
  p_will_renew boolean,
  p_source text,
  p_product_id text default null,
  p_store_transaction_id text default null
)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
declare
  new_plan public.plans;
begin
  if p_store_transaction_id is not null then
    select * into new_plan from public.plans where store_transaction_id = p_store_transaction_id;
    if found then
      return new_plan;
    end if;
  end if;

  if p_kind = 'subscription' then
    if p_seat_count <> 1 then
      raise exception 'A subscription is just for yourself';
    end if;

    insert into public.plans (
      sponsor_id, kind, seat_count, starts_at, ends_at, duration, will_renew, source,
      product_id, store_transaction_id
    )
    values (
      p_sponsor_id, p_kind, 1, now(), now() + p_duration, p_duration, p_will_renew, p_source,
      p_product_id, p_store_transaction_id
    )
    returning * into new_plan;

    insert into public.plan_seats (plan_id, user_id) values (new_plan.id, p_sponsor_id);
    return new_plan;
  end if;

  insert into public.plans (
    sponsor_id, kind, seat_count, duration, will_renew, source, product_id, store_transaction_id
  )
  values (
    p_sponsor_id, p_kind, p_seat_count, p_duration, p_will_renew, p_source, p_product_id,
    p_store_transaction_id
  )
  returning * into new_plan;

  return new_plan;
end;
$$;

-- Where a bought Trip Pass's start may go: now at the earliest (an earlier
-- one, e.g. the start of today, just means now), and within a year.
create or replace function public.plan_start_from(p_starts_at timestamptz)
returns timestamptz
language plpgsql
stable
as $$
declare
  plan_start timestamptz := greatest(coalesce(p_starts_at, now()), now());
begin
  if plan_start > now() + interval '1 year' then
    raise exception 'Pick a start within the next year';
  end if;
  return plan_start;
end;
$$;

-- Sets up a bought Trip Pass: when it starts (null for right away) and, for
-- a group size, which group it's for and who gets its first seats. Only its
-- sponsor, once. A group can only have one plan that hasn't ended (running
-- or still to start), so it never has two sponsors; the group row is locked
-- first so two passes can't be set up for it at once. Records plan_started
-- for a group pass, which also makes its sponsor the group's sponsor
-- (group_members.is_sponsor); the seats it starts with don't get plan_seat_given
-- events of their own. A "Just me" pass's one seat always goes to the
-- sponsor.
create or replace function public.set_up_plan(
  p_plan_id uuid,
  p_group_id uuid,
  p_starts_at timestamptz,
  p_member_ids uuid[] default '{}'
)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
declare
  target_plan public.plans;
  plan_start timestamptz;
  member_id uuid;
begin
  select * into target_plan from public.plans where id = p_plan_id for update;

  if not found or target_plan.sponsor_id is distinct from auth.uid() then
    raise exception 'Only the person who bought this pass can set it up';
  end if;

  if target_plan.starts_at is not null then
    raise exception 'This pass is already set up';
  end if;

  plan_start := public.plan_start_from(p_starts_at);

  if target_plan.seat_count = 1 then
    if p_group_id is not null then
      raise exception 'A "Just me" pass isn''t for one group';
    end if;

    update public.plans
    set starts_at = plan_start, ends_at = plan_start + duration
    where id = p_plan_id
    returning * into target_plan;

    insert into public.plan_seats (plan_id, user_id) values (p_plan_id, auth.uid());
    return target_plan;
  end if;

  if p_group_id is null then
    raise exception 'Pick a group for this pass';
  end if;

  perform 1 from public.groups where id = p_group_id for update;

  if not public.is_group_member(p_group_id) then
    raise exception 'Only an active member can set up a pass for this group';
  end if;

  if exists (
    select 1 from public.plans where group_id = p_group_id and ends_at > now()
  ) then
    raise exception 'This group already has a plan';
  end if;

  if (
    select count(distinct m) from unnest(p_member_ids) as m where m is not null
  ) > target_plan.seat_count then
    raise exception 'More people picked than the pass has seats';
  end if;

  -- The sponsor can only skip their own seat while another plan unlocks
  -- them when this one starts (the app warns when that one ends first, but
  -- allows it) — a renewing subscription always does (unlocked_on).
  -- Coalesced: a null in p_member_ids would otherwise make the "picked
  -- themselves" test null and skip this check.
  perform public.renew_test_subscriptions();
  if not coalesce(auth.uid() = any(p_member_ids), false)
    and not public.unlocked_on(auth.uid(), plan_start) then
    raise exception 'You need a seat on your own pass';
  end if;

  update public.plans
  set group_id = p_group_id, starts_at = plan_start, ends_at = plan_start + duration
  where id = p_plan_id
  returning * into target_plan;

  -- Setting up a pass makes you the group's sponsor (see
  -- group_members.is_sponsor). Whoever had it from an earlier plan stays an
  -- admin. Cleared first: there's at most one sponsor per group.
  update public.group_members
  set is_sponsor = false
  where group_id = p_group_id and is_sponsor and user_id is distinct from auth.uid();

  update public.group_members
  set is_sponsor = true, is_admin = true, left_as_sponsor = false
  where group_id = p_group_id and user_id = auth.uid();

  for member_id in
    select distinct m from unnest(p_member_ids) as m where m is not null
  loop
    if not exists (
      select 1 from public.group_members
      where group_id = p_group_id and user_id = member_id and left_at is null
    ) then
      raise exception 'That person is not an active member of this group';
    end if;
    insert into public.plan_seats (plan_id, user_id) values (p_plan_id, member_id);
  end loop;

  -- After the seats, so seat_holders lists them.
  insert into public.group_events (group_id, kind, actor_id, details)
  values (
    p_group_id, 'plan_started', auth.uid(),
    jsonb_build_object(
      'plan_id', target_plan.id,
      'kind', target_plan.kind,
      'seat_count', target_plan.seat_count,
      'starts_at', target_plan.starts_at,
      'ends_at', target_plan.ends_at,
      'will_renew', target_plan.will_renew,
      'seat_holders', coalesce(
        (select jsonb_agg(user_id) from public.plan_seats
         where plan_id = target_plan.id and user_id is not null),
        '[]'::jsonb
      )
    )
  );

  return target_plan;
end;
$$;

grant execute on function public.set_up_plan(uuid, uuid, timestamptz, uuid[]) to authenticated;

-- Moves a set-up Trip Pass's start (null for right away) until it has
-- started, keeping its length and seats. A "Just me" pass by its sponsor, a
-- group pass by whoever hands out its seats (can_manage_plan).
create or replace function public.reschedule_plan(p_plan_id uuid, p_starts_at timestamptz)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
declare
  target_plan public.plans;
  plan_start timestamptz;
  group_sponsor_id uuid;
  seat_holder_id uuid;
begin
  select * into target_plan from public.plans where id = p_plan_id for update;

  if not found
    or (target_plan.group_id is null and target_plan.sponsor_id is distinct from auth.uid())
    or (target_plan.group_id is not null and not public.can_manage_plan(p_plan_id)) then
    raise exception 'Only whoever manages this pass can change its start';
  end if;

  if target_plan.starts_at is null then
    raise exception 'Set this pass up first';
  end if;

  if target_plan.starts_at <= now() then
    raise exception 'This pass has already started';
  end if;

  plan_start := public.plan_start_from(p_starts_at);

  -- The same rule as set_up_plan: the group's sponsor (whoever took over if
  -- the buyer left — see leave_group), without a seat on it, needs another
  -- plan unlocking them on the new start (unlocked_on). A group without a
  -- sponsor has no one it applies to.
  select user_id into group_sponsor_id
  from public.group_members
  where group_id = target_plan.group_id and is_sponsor and left_at is null;

  perform public.renew_test_subscriptions();
  if group_sponsor_id is not null
    and not exists (
      select 1 from public.plan_seats
      where plan_id = p_plan_id and user_id = group_sponsor_id and released_at is null
    )
    and not public.unlocked_on(group_sponsor_id, plan_start) then
    if group_sponsor_id = auth.uid() then
      raise exception 'Nothing else unlocks you by then, so give yourself a seat on this pass first';
    end if;
    raise exception 'Nothing else unlocks its sponsor by then, so they need a seat on this pass first';
  end if;

  update public.plans
  set starts_at = plan_start, ends_at = plan_start + duration
  where id = p_plan_id
  returning * into target_plan;

  -- P7 in docs/notifications.md.
  if target_plan.group_id is not null then
    for seat_holder_id in
      select user_id from public.plan_seats
      where plan_id = p_plan_id and released_at is null and user_id is not null
    loop
      perform public.notify(
        seat_holder_id, 'plan_rescheduled', 'plans', target_plan.group_id,
        (select name from public.groups where id = target_plan.group_id),
        public.notification_name(auth.uid()) || ' moved the Trip Pass — it now runs from '
          || public.notification_date(target_plan.starts_at, seat_holder_id) || ' to '
          || public.notification_date(target_plan.ends_at, seat_holder_id),
        '/group-plan?groupId=' || target_plan.group_id
      );
    end loop;
  end if;

  return target_plan;
end;
$$;

grant execute on function public.reschedule_plan(uuid, timestamptz) to authenticated;

-- Adds seats to a running group plan, ending when it does: how a sponsor
-- makes room for someone who joined late. Not callable by clients, same as
-- create_plan.
create or replace function public.add_plan_seats(p_plan_id uuid, p_count integer)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_plan public.plans;
begin
  if p_count < 1 then
    raise exception 'Add at least one seat';
  end if;

  update public.plans
  set seat_count = seat_count + p_count
  where id = p_plan_id and group_id is not null and ends_at > now()
  returning * into updated_plan;

  if not found then
    raise exception 'That plan has ended';
  end if;

  return updated_plan;
end;
$$;

-- Whether the caller can make free test purchases: everyone while
-- billing_settings.free_test_purchases is on, otherwise billing_testers.
create or replace function public.can_test_purchase()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select (select free_test_purchases from public.billing_settings)
    or exists (select 1 from public.billing_testers where user_id = auth.uid());
$$;

-- Stand-ins for real store purchases until payments exist: free, and only
-- for callers who pass can_test_purchase. p_period is one of PLAN_PERIODS and
-- p_seat_count one of the sizes in src/constants/plans.ts ('week' and
-- 'two_weeks' make a Trip Pass of 1 ("Just me"), 4, 8 or 15 seats, set up
-- afterwards through set_up_plan; 'month' and 'year' a subscription, always
-- 1 seat). A test subscription renews (for free, see
-- renew_test_subscriptions) until it's cancelled through
-- test_set_plan_renewal, like a store one will.
-- (Used to take the group and its first seat holders too.)
drop function if exists public.test_purchase_plan(uuid, text, integer, uuid[]);
create or replace function public.test_purchase_plan(p_period text, p_seat_count integer)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
declare
  plan_kind text;
  plan_duration interval;
begin
  if not public.can_test_purchase() then
    raise exception 'Purchases aren''t available yet';
  end if;

  select periods.kind, periods.duration into plan_kind, plan_duration
  from (values
    ('week', 'trip_pass', interval '7 days'),
    ('two_weeks', 'trip_pass', interval '14 days'),
    ('month', 'subscription', interval '1 month'),
    ('year', 'subscription', interval '1 year')
  ) as periods (period, kind, duration)
  where periods.period = p_period;

  if plan_kind is null then
    raise exception 'Unknown plan length';
  end if;

  if p_seat_count not in (1, 4, 8, 15) or (plan_kind = 'subscription' and p_seat_count <> 1) then
    raise exception 'Unknown plan size';
  end if;

  -- One running subscription at a time (cancelled ones included, until they
  -- run out): a monthly one can only be upgraded to yearly, through
  -- test_upgrade_subscription. Locked on the caller's profile so two
  -- purchases at once can't both get past this.
  if plan_kind = 'subscription' then
    perform 1 from public.profiles where id = auth.uid() for update;
    -- Renewed first, like every other read of subscriptions: a lapsed one
    -- that's still set to renew counts too.
    perform public.renew_test_subscriptions();
    if exists (
      select 1 from public.plans
      where sponsor_id = auth.uid()
        and kind = 'subscription'
        and starts_at <= now()
        and ends_at > now()
    ) then
      raise exception 'You already have a subscription';
    end if;
  end if;

  return public.create_plan(
    auth.uid(), plan_kind, p_seat_count, plan_duration, plan_kind = 'subscription', 'test'
  );
end;
$$;

grant execute on function public.test_purchase_plan(text, integer) to authenticated;

-- Test subscriptions renew themselves, for free, the way a store one will
-- through its webhook: each lapsed one still set to renew gets as many
-- terms added as it missed (one at a time, so a month term keeps landing on
-- the same day the way generate_series in get_my_access's billing_dates
-- counts them) — but only while its sponsor could still make test
-- purchases, so switching those off lets them run out. There's no
-- scheduler, so whatever reads or checks access (get_my_access,
-- get_group_access, check_entry_access) runs this first, and nothing ever
-- sees one lapse.
create or replace function public.renew_test_subscriptions()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  loop
    update public.plans p
    set ends_at = p.ends_at + p.duration
    where p.source = 'test'
      and p.kind = 'subscription'
      and p.will_renew
      and p.ends_at <= now()
      and (
        (select free_test_purchases from public.billing_settings)
        or exists (select 1 from public.billing_testers t where t.user_id = p.sponsor_id)
      );
    exit when not found;
  end loop;
end;
$$;

create index if not exists plans_renewing_idx on public.plans (ends_at) where will_renew;

-- Cancelling a running test subscription (it runs to the end of the term
-- it's in, then ends), or taking that back before it runs out — what the
-- store's own subscription settings will do for a real one, whose webhook
-- then sets will_renew. Only its sponsor can.
create or replace function public.test_set_plan_renewal(p_plan_id uuid, p_will_renew boolean)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
declare
  target_plan public.plans;
begin
  -- Turned back on, it'd only renew while test purchases are allowed.
  if p_will_renew and not public.can_test_purchase() then
    raise exception 'Purchases aren''t available yet';
  end if;

  perform public.renew_test_subscriptions();

  update public.plans
  set will_renew = p_will_renew
  where id = p_plan_id
    and sponsor_id = auth.uid()
    and kind = 'subscription'
    and source = 'test'
    and starts_at <= now()
    and ends_at > now()
  returning * into target_plan;

  if not found then
    raise exception 'This subscription has ended or isn''t yours';
  end if;

  return target_plan;
end;
$$;

grant execute on function public.test_set_plan_renewal(uuid, boolean) to authenticated;

-- Upgrading a running monthly test subscription (cancelled or not) to
-- yearly: the monthly one ends now and a renewing yearly one starts in its
-- place, so each keeps its own billing history (a store upgrade will refund
-- the rest of the month the same way). There's no way back to monthly.
-- Only its sponsor can.
create or replace function public.test_upgrade_subscription(p_plan_id uuid)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_test_purchase() then
    raise exception 'Purchases aren''t available yet';
  end if;

  perform public.renew_test_subscriptions();

  update public.plans
  set ends_at = now(), will_renew = false
  where id = p_plan_id
    and sponsor_id = auth.uid()
    and kind = 'subscription'
    and source = 'test'
    and duration = interval '1 month'
    and starts_at <= now()
    and ends_at > now();

  if not found then
    raise exception 'Only a running monthly subscription can be upgraded';
  end if;

  return public.create_plan(auth.uid(), 'subscription', 1, interval '1 year', true, 'test');
end;
$$;

grant execute on function public.test_upgrade_subscription(uuid) to authenticated;

create or replace function public.test_add_plan_seats(p_plan_id uuid, p_count integer)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_test_purchase() then
    raise exception 'Purchases aren''t available yet';
  end if;

  if not public.can_manage_plan(p_plan_id) then
    raise exception 'Only this group''s sponsor can add seats';
  end if;

  if p_count not between 1 and 12 then
    raise exception 'Unknown number of seats';
  end if;

  return public.add_plan_seats(p_plan_id, p_count);
end;
$$;

grant execute on function public.test_add_plan_seats(uuid, integer) to authenticated;

-- Upgrades a running group plan in place: to a bigger size (one of the
-- group sizes, never below the seats already taken), and/or a 1-week Trip
-- Pass to a 2-week one. Lengthening sets the end from the plan's start, so
-- a Trip Pass always lasts exactly its length. Seats keep their holders and
-- end with the plan. Not callable by clients, same as create_plan.
create or replace function public.upgrade_plan(
  p_plan_id uuid,
  p_seat_count integer,
  p_period text default null
)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
declare
  current_plan public.plans;
  new_ends_at timestamptz;
  old_plan public.plans;
  group_name text;
  upgrader text;
  recipient uuid;
  seats_free integer;
begin
  select * into current_plan from public.plans
  where id = p_plan_id and group_id is not null and ends_at > now()
  for update;

  if not found then
    raise exception 'That plan has ended';
  end if;

  if p_seat_count not in (4, 8, 15) and p_seat_count <> current_plan.seat_count then
    raise exception 'Unknown plan size';
  end if;

  if p_seat_count < current_plan.seat_count then
    raise exception 'A plan can only get bigger';
  end if;

  new_ends_at := current_plan.ends_at;
  if p_period is not null then
    if current_plan.kind <> 'trip_pass' or p_period <> 'two_weeks' then
      raise exception 'Only a Trip Pass can be made longer, to 2 weeks';
    end if;
    new_ends_at := greatest(current_plan.ends_at, current_plan.starts_at + interval '14 days');
  end if;

  if p_seat_count = current_plan.seat_count and new_ends_at = current_plan.ends_at then
    raise exception 'That''s the plan you already have';
  end if;

  old_plan := current_plan;

  update public.plans
  set seat_count = p_seat_count, ends_at = new_ends_at,
    duration = new_ends_at - current_plan.starts_at
  where id = p_plan_id
  returning * into current_plan;

  -- P8 / P9 in docs/notifications.md. Whoever upgraded it (the sponsor, for
  -- a store purchase granted without a session).
  select name into group_name from public.groups where id = current_plan.group_id;
  upgrader := public.notification_name(coalesce(auth.uid(), current_plan.sponsor_id));

  if current_plan.seat_count > old_plan.seat_count then
    seats_free := current_plan.seat_count - (
      select count(*) from public.plan_seats where plan_id = p_plan_id and released_at is null
    );
    for recipient in
      select gm.user_id from public.group_members gm
      where gm.group_id = current_plan.group_id and gm.left_at is null and gm.user_id is not null
        and not exists (
          select 1 from public.plan_seats s
          where s.plan_id = p_plan_id and s.user_id = gm.user_id and s.released_at is null
        )
    loop
      perform public.notify(
        recipient, 'plan_more_seats', 'plans', current_plan.group_id, group_name,
        'The Trip Pass now has ' || current_plan.seat_count || ' seats, ' || seats_free
          || ' of them free — ask ' || upgrader || ' for one',
        '/group-plan?groupId=' || current_plan.group_id
      );
    end loop;
  end if;

  if current_plan.ends_at > old_plan.ends_at then
    for recipient in
      select user_id from public.plan_seats
      where plan_id = p_plan_id and released_at is null and user_id is not null
    loop
      perform public.notify(
        recipient, 'plan_extended', 'plans', current_plan.group_id, group_name,
        upgrader || ' extended the Trip Pass — you''re unlocked until '
          || public.notification_date(current_plan.ends_at, recipient) || ' now',
        '/group/' || current_plan.group_id
      );
    end loop;
  end if;

  return current_plan;
end;
$$;

create or replace function public.test_upgrade_plan(
  p_plan_id uuid,
  p_seat_count integer,
  p_period text default null
)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_test_purchase() then
    raise exception 'Purchases aren''t available yet';
  end if;

  if not public.can_manage_plan(p_plan_id) then
    raise exception 'Only this group''s sponsor can upgrade its plan';
  end if;

  return public.upgrade_plan(p_plan_id, p_seat_count, p_period);
end;
$$;

grant execute on function public.test_upgrade_plan(uuid, integer, text) to authenticated;

-- Hands seats on a running group plan to active members of its group: the
-- sponsor picking people after paying, or giving a seat to someone who
-- joined late. Manager-only (can_manage_plan). The plan row is locked first
-- so two managers can't both hand out its last seat. Someone already holding
-- a seat is skipped rather than rejected, and it's all or nothing: one bad id
-- rolls back the seats handed out before it.
create or replace function public.assign_plan_seats(p_plan_id uuid, p_user_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_plan public.plans;
  target_id uuid;
begin
  select * into target_plan from public.plans where id = p_plan_id for update;

  if not found or not public.can_manage_plan(p_plan_id) then
    raise exception 'Only this group''s sponsor can hand out its seats';
  end if;

  if target_plan.ends_at <= now() then
    raise exception 'This plan has already ended';
  end if;

  for target_id in
    select distinct u from unnest(p_user_ids) as u where u is not null
  loop
    if exists (
      select 1 from public.plan_seats
      where plan_id = p_plan_id and user_id = target_id and released_at is null
    ) then
      continue;
    end if;

    if not exists (
      select 1 from public.group_members
      where group_id = target_plan.group_id and user_id = target_id and left_at is null
    ) then
      raise exception 'That person is not an active member of this group';
    end if;

    if (
      select count(*) from public.plan_seats
      where plan_id = p_plan_id and released_at is null
    ) >= target_plan.seat_count then
      raise exception 'There are no seats left on this plan';
    end if;

    insert into public.plan_seats (plan_id, user_id) values (p_plan_id, target_id);
    insert into public.group_events (group_id, kind, actor_id, target_id, details)
    values (
      target_plan.group_id, 'plan_seat_given', auth.uid(), target_id,
      jsonb_build_object(
        'plan_id', p_plan_id,
        'seat_count', target_plan.seat_count,
        'seats_used', (
          select count(*) from public.plan_seats
          where plan_id = p_plan_id and released_at is null
        ),
        'ends_at', target_plan.ends_at
      )
    );
  end loop;
end;
$$;

grant execute on function public.assign_plan_seats(uuid, uuid[]) to authenticated;

-- Takes a seat back from p_user_id on a group pass that hasn't started yet,
-- so its manager can give it to someone else (assign_plan_seats). Once the
-- pass has started, its seats are locked in (see plan_seats). The seat never
-- unlocked anyone, so its row is simply deleted. The group sponsor's own seat
-- can only go while another plan unlocks them when this one starts (a
-- renewing subscription always does) — the same rule as set_up_plan, held by
-- whoever has the role now, not the buyer once they've left. (Leaving or
-- being removed from the group takes a seat back by itself:
-- free_pending_plan_seat.) Records plan_seat_removed.
create or replace function public.remove_plan_seat(p_plan_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_plan public.plans;
begin
  select * into target_plan from public.plans where id = p_plan_id for update;

  if not found or not public.can_manage_plan(p_plan_id) then
    raise exception 'Only this group''s sponsor can change its seats';
  end if;

  if target_plan.starts_at is null or target_plan.starts_at <= now() then
    raise exception 'Seats are locked in once the pass has started';
  end if;

  delete from public.plan_seats
  where plan_id = p_plan_id and user_id = p_user_id and released_at is null;

  if not found then
    raise exception 'That person doesn''t have a seat on this pass';
  end if;

  perform public.renew_test_subscriptions();
  if exists (
      select 1 from public.group_members
      where group_id = target_plan.group_id
        and user_id = p_user_id
        and is_sponsor
        and left_at is null
    )
    and not public.unlocked_on(p_user_id, target_plan.starts_at) then
    if p_user_id = auth.uid() then
      raise exception 'Nothing else unlocks you by then, so you need a seat on this pass';
    end if;
    raise exception 'Nothing else unlocks the group''s sponsor by then, so they need a seat on this pass';
  end if;

  insert into public.group_events (group_id, kind, actor_id, target_id, details)
  values (
    target_plan.group_id, 'plan_seat_removed', auth.uid(), p_user_id,
    jsonb_build_object(
      'plan_id', p_plan_id,
      'seat_count', target_plan.seat_count,
      'seats_used', (
        select count(*) from public.plan_seats
        where plan_id = p_plan_id and released_at is null
      ),
      'starts_at', target_plan.starts_at,
      'ends_at', target_plan.ends_at
    )
  );
end;
$$;

grant execute on function public.remove_plan_seat(uuid, uuid) to authenticated;

-- Fills in details for plan events recorded before it existed, as closely
-- as the plan tables allow: a plan_started matches the plan its sponsor
-- bought in that group within a few seconds of it, whose starting seats are
-- the ones assigned in the same transaction (assigned_at = created_at); a
-- plan_seat_given matches the latest plan to start in the group before it.
-- seat_count and ends_at are today's, which may differ after an upgrade.
update public.group_events e
set details = jsonb_build_object(
  'plan_id', p.id,
  'kind', p.kind,
  'seat_count', p.seat_count,
  'ends_at', p.ends_at,
  'will_renew', p.will_renew,
  'seat_holders', coalesce(
    (select jsonb_agg(s.user_id) from public.plan_seats s
     where s.plan_id = p.id and s.user_id is not null and s.assigned_at = p.created_at),
    '[]'::jsonb
  )
)
from public.plans p
where e.kind = 'plan_started' and e.details is null
  and p.group_id = e.group_id and p.sponsor_id is not distinct from e.actor_id
  and abs(extract(epoch from p.created_at - e.created_at)) < 5;

update public.group_events e
set details = jsonb_build_object(
  'plan_id', p.id,
  'seat_count', p.seat_count,
  'seats_used', (
    select count(*) from public.plan_seats s
    where s.plan_id = p.id and s.assigned_at <= e.created_at
  ),
  'ends_at', p.ends_at
)
from public.plans p
where e.kind = 'plan_seat_given' and e.details is null
  and p.id = (
    select p2.id from public.plans p2
    where p2.group_id = e.group_id and p2.starts_at <= e.created_at
    order by p2.starts_at desc limit 1
  );

-- Seats used to be movable to someone else once their holder had left the
-- group; now a seat stays with its holder no matter what (see plan_seats).
drop function if exists public.move_plan_seat(uuid, uuid, uuid);

-- The caller's own access: the paywall switch and free allowance, the plan
-- currently unlocking them (the one that lasts longest, if several do — a
-- renewing subscription counting as lasting forever), every
-- running plan they sponsor or hold a seat on, every Trip Pass of theirs that
-- hasn't started yet, whether they've ever had a plan, and whether they can
-- make test purchases. The only way a client reads any of this (the tables
-- themselves aren't readable). Not stable: it renews lapsed test
-- subscriptions first.
create or replace function public.get_my_access()
returns jsonb
language plpgsql
security definer
set search_path = public
volatile
as $$
declare
  result jsonb;
begin
  perform public.renew_test_subscriptions();

  select jsonb_build_object(
    'paywall_enabled', s.paywall_enabled,
    'free_entries_per_group', s.free_entries_per_group,
    'can_test_purchase', public.can_test_purchase(),
    -- Has ever bought a plan or held a seat on one (ended ones included):
    -- the paywall only explains plans to people who haven't.
    'has_had_plan', exists (select 1 from public.plans where sponsor_id = auth.uid())
      or exists (select 1 from public.plan_seats where user_id = auth.uid()),
    'covering_plan', (
      select jsonb_build_object(
        'id', p.id,
        'kind', p.kind,
        'group_id', p.group_id,
        'sponsor_id', p.sponsor_id,
        'sponsor_name', pr.name,
        'ends_at', p.ends_at,
        'will_renew', p.will_renew,
        'duration_days', round(extract(epoch from p.duration) / 86400)
      )
      from public.plan_seats ps
      join public.plans p on p.id = ps.plan_id
      left join public.profiles pr on pr.id = p.sponsor_id
      where ps.user_id = auth.uid()
        and ps.released_at is null
        and p.starts_at <= now()
        and p.ends_at > now()
      -- A renewing subscription first: it counts as never running out, so
      -- it outlasts any pass.
      order by p.will_renew desc, p.ends_at desc
      limit 1
    ),
    'active_plans', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'kind', p.kind,
          'group_id', p.group_id,
          'group_name', g.name,
          'sponsor_id', p.sponsor_id,
          'sponsor_name', pr.name,
          'has_seat', exists (
            select 1 from public.plan_seats x
            where x.plan_id = p.id and x.user_id = auth.uid() and x.released_at is null
          ),
          'seat_count', p.seat_count,
          'seats_used', (
            select count(*) from public.plan_seats x
            where x.plan_id = p.id and x.released_at is null
          ),
          'starts_at', p.starts_at,
          'ends_at', p.ends_at,
          'will_renew', p.will_renew,
          'duration_days', round(extract(epoch from p.duration) / 86400),
          'source', p.source,
          -- When a subscription has been charged: the start of every term
          -- so far (renewals add one term at a time, the way this counts).
          'billing_dates', case when p.kind = 'subscription' then (
            select jsonb_agg(d order by d)
            from generate_series(p.starts_at, p.ends_at - interval '1 second', p.duration) d
          ) end
        )
        order by p.ends_at desc
      )
      from public.plans p
      left join public.groups g on g.id = p.group_id
      left join public.profiles pr on pr.id = p.sponsor_id
      where p.starts_at <= now()
        and p.ends_at > now()
        and (
          p.sponsor_id = auth.uid()
          or exists (
            select 1 from public.plan_seats x
            where x.plan_id = p.id and x.user_id = auth.uid() and x.released_at is null
          )
        )
    ), '[]'::jsonb),
    -- Trip Passes that haven't started: bought but not set up yet (only the
    -- sponsor's own; starts_at null, listed first), or set up to start
    -- later — including group passes the caller manages without a seat (an
    -- admin once the sponsor has left), so they can move its start too.
    'upcoming_plans', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'kind', p.kind,
          'group_id', p.group_id,
          'group_name', g.name,
          'sponsor_id', p.sponsor_id,
          'sponsor_name', pr.name,
          'has_seat', exists (
            select 1 from public.plan_seats x
            where x.plan_id = p.id and x.user_id = auth.uid() and x.released_at is null
          ),
          'seat_count', p.seat_count,
          'seats_used', (
            select count(*) from public.plan_seats x
            where x.plan_id = p.id and x.released_at is null
          ),
          'starts_at', p.starts_at,
          'ends_at', p.ends_at,
          'duration_days', round(extract(epoch from p.duration) / 86400)
        )
        order by p.starts_at nulls first, p.created_at
      )
      from public.plans p
      left join public.groups g on g.id = p.group_id
      left join public.profiles pr on pr.id = p.sponsor_id
      where (p.starts_at is null or p.starts_at > now())
        and (
          p.sponsor_id = auth.uid()
          or exists (
            select 1 from public.plan_seats x
            where x.plan_id = p.id and x.user_id = auth.uid() and x.released_at is null
          )
          or public.can_manage_plan(p.id)
        )
    ), '[]'::jsonb),
    -- Plans that have ended which the caller sponsored or held a seat on,
    -- most recently ended first, for the hidden "Former plans" list.
    'past_plans', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'kind', p.kind,
          'group_id', p.group_id,
          'group_name', g.name,
          'sponsor_id', p.sponsor_id,
          'sponsor_name', pr.name,
          'seat_count', p.seat_count,
          'starts_at', p.starts_at,
          'ends_at', p.ends_at,
          'duration_days', round(extract(epoch from p.duration) / 86400)
        )
        order by p.ends_at desc
      )
      from (
        select * from public.plans p
        where p.ends_at <= now()
          and (
            p.sponsor_id = auth.uid()
            or exists (
              select 1 from public.plan_seats x
              where x.plan_id = p.id and x.user_id = auth.uid()
            )
          )
        order by p.ends_at desc
        limit 50
      ) p
      left join public.groups g on g.id = p.group_id
      left join public.profiles pr on pr.id = p.sponsor_id
    ), '[]'::jsonb),
    -- The caller's groups that already have a plan that hasn't ended
    -- (running or still to start), so setting up a group pass can show them
    -- as taken: a group only has one at a time (set_up_plan).
    'groups_with_plans', coalesce((
      select jsonb_agg(
        jsonb_build_object('group_id', p.group_id, 'starts_at', p.starts_at, 'ends_at', p.ends_at)
      )
      from public.plans p
      where p.ends_at > now()
        and p.group_id is not null
        and public.is_group_member(p.group_id)
    ), '[]'::jsonb)
  )
  into result
  from public.billing_settings s;

  return result;
end;
$$;

grant execute on function public.get_my_access() to authenticated;

-- One group's access picture, for its active members: free entries left,
-- its plan (if any — running, or set up to start later), and for every member — including ones who left,
-- since an entry being edited can still include them — when their unlock
-- runs out, whether it renews, and whether they hold one of this group's
-- seats.
-- (Not stable: it renews lapsed test subscriptions first.)
create or replace function public.get_group_access(p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
volatile
as $$
declare
  settings public.billing_settings;
  used_count integer;
  running public.plans;
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'Not a member of this group';
  end if;

  perform public.renew_test_subscriptions();

  select * into settings from public.billing_settings;
  select coalesce((
    select used from public.free_entry_usage
    where group_id = p_group_id
  ), 0)
  into used_count;
  -- Running, or set up to start later: a group has at most one that hasn't
  -- ended (set_up_plan). Its seat holders are only unlocked once it starts.
  select * into running from public.plans
  where group_id = p_group_id and ends_at > now();

  return jsonb_build_object(
    'paywall_enabled', coalesce(settings.paywall_enabled, false),
    -- The group's own: everyone in it shares one pool.
    'free_entries_left', greatest(coalesce(settings.free_entries_per_group, 0) - used_count, 0),
    'plan', case when running.id is null then null else jsonb_build_object(
      'id', running.id,
      'kind', running.kind,
      'sponsor_id', running.sponsor_id,
      'seat_count', running.seat_count,
      'seats_used', (
        select count(*) from public.plan_seats
        where plan_id = running.id and released_at is null
      ),
      -- Held by accounts that have since been deleted: still taken (see
      -- plan_seats), but there's no member left to list them under.
      'deleted_seats', (
        select count(*) from public.plan_seats
        where plan_id = running.id and released_at is null and user_id is null
      ),
      'starts_at', running.starts_at,
      'ends_at', running.ends_at,
      'will_renew', running.will_renew,
      'duration_days', round(extract(epoch from running.duration) / 86400),
      'can_manage', public.can_manage_plan(running.id)
    ) end,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', gm.user_id,
        'unlocked_until', cover.ends_at,
        'will_renew', coalesce(cover.will_renew, false),
        -- How long the plan unlocking them runs, for how early its end gets
        -- pointed out.
        'unlock_days', round(extract(epoch from cover.duration) / 86400),
        'has_seat', running.id is not null and exists (
          select 1 from public.plan_seats s
          where s.plan_id = running.id and s.user_id = gm.user_id and s.released_at is null
        )
      ))
      from public.group_members gm
      left join lateral (
        select p.ends_at, p.will_renew, p.duration
        from public.plan_seats s
        join public.plans p on p.id = s.plan_id
        where s.user_id = gm.user_id
          and s.released_at is null
          and p.starts_at <= now()
          and p.ends_at > now()
        -- Same as get_my_access's covering_plan: a renewing subscription
        -- first, since it counts as never running out.
        order by p.will_renew desc, p.ends_at desc
        limit 1
      ) cover on true
      where gm.group_id = p_group_id and gm.user_id is not null
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.get_group_access(uuid) to authenticated;

-- Backfill for groups whose pass was set up before group_members.is_sponsor
-- existed: their latest pass's sponsor if they're still in the group,
-- otherwise whoever leave_group would have handed it to. Only touches
-- groups without a sponsor, which after this can't happen again for a group
-- that's had a pass, so re-running the file changes nothing.
update public.group_members gm
set is_sponsor = true, is_admin = true
from (
  select distinct on (group_id) group_id, sponsor_id
  from public.plans
  where group_id is not null and starts_at is not null
  order by group_id, starts_at desc
) latest
where gm.group_id = latest.group_id
  and gm.user_id = latest.sponsor_id
  and gm.left_at is null
  and not gm.left_as_sponsor
  and not exists (
    select 1 from public.group_members s where s.group_id = gm.group_id and s.is_sponsor
  );

update public.group_members gm
set is_sponsor = true, is_admin = true
where gm.id in (
  select distinct on (m.group_id) m.id
  from public.group_members m
  where m.left_at is null
    and not m.left_as_sponsor
    and exists (
      select 1 from public.plans p
      where p.group_id = m.group_id and p.starts_at is not null
    )
    and not exists (
      select 1 from public.group_members s where s.group_id = m.group_id and s.is_sponsor
    )
  order by m.group_id, m.is_admin desc, m.joined_at asc
);

-- ---------------------------------------------------------------------------
-- Notifications (see the tables above and docs/notifications.md)
-- ---------------------------------------------------------------------------

-- A settings row a client wrote has to be usable by every notify() call
-- after it: an unknown time zone or a non-boolean switch would otherwise
-- fail there instead (and lose that person's notifications).
create or replace function public.check_notification_settings()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if jsonb_typeof(new.categories) <> 'object' or exists (
    select 1 from jsonb_each(new.categories) where jsonb_typeof(value) <> 'boolean'
  ) then
    raise exception 'Notification categories must be on/off switches';
  end if;
  perform now() at time zone new.time_zone;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists notification_settings_check on public.notification_settings;
create trigger notification_settings_check
  before insert or update on public.notification_settings
  for each row execute function public.check_notification_settings();

-- Mirrors DEFAULT_NOTIFICATION_CATEGORIES in src/constants/notifications.ts:
-- everything is on by default except entries you're not part of. The plan
-- switches don't apply while plans are hidden from this person
-- (plansVisible in AccessProvider), so nothing about plans is sent then.
create or replace function public.notification_category_on(p_user_id uuid, p_category text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select case
    when p_category = 'always' then true
    when p_category in ('plans', 'reminders') and not (
      coalesce((select paywall_enabled or free_test_purchases from public.billing_settings), false)
      or exists (select 1 from public.billing_testers where user_id = p_user_id)
    ) then false
    else coalesce(
      (
        select not s.all_muted
          and coalesce((s.categories ->> p_category)::boolean, p_category <> 'otherExpenses')
        from public.notification_settings s
        where s.user_id = p_user_id
      ),
      p_category <> 'otherExpenses'
    )
  end;
$$;

create or replace function public.notification_name(p_user_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select name from public.profiles where id = p_user_id), 'Someone');
$$;

-- "45", "11.25", "34.50" — whole amounts without decimals, like the Logs tab.
create or replace function public.notification_amount(p_amount numeric)
returns text
language sql
immutable
as $$
  select case
    when round(p_amount, 2) = trunc(p_amount) then trunc(p_amount)::text
    else to_char(round(p_amount, 2), 'FM999999999990.00')
  end;
$$;

-- "Ben", "Ben and Carl", "Ben, Carl and Dana", and past p_max names
-- "Ben, Carl and 3 others".
create or replace function public.notification_join_names(p_names text[], p_max integer default 3)
returns text
language sql
immutable
as $$
  select case
    when n = 0 then ''
    when n = 1 then p_names[1]
    when n <= p_max then array_to_string(p_names[1:n - 1], ', ') || ' and ' || p_names[n]
    else array_to_string(p_names[1:p_max - 1], ', ') || ' and ' || (n - p_max + 1) || ' others'
  end
  from (select coalesce(cardinality(p_names), 0) as n) counted;
$$;

create or replace function public.notification_time_zone(p_user_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select time_zone from public.notification_settings where user_id = p_user_id),
    'UTC'
  );
$$;

-- "12 Oct" in the recipient's time zone, with the year only when it isn't
-- this year — formatAccessDate in src/utils/access.ts.
create or replace function public.notification_date(p_at timestamptz, p_user_id uuid)
returns text
language sql
stable
as $$
  select to_char(local_at, 'FMDD Mon')
    || case
      when extract(year from local_at) <> extract(year from now() at time zone tz)
        then ' ' || to_char(local_at, 'YYYY')
      else ''
    end
  from (
    select tz, p_at at time zone tz as local_at
    from (select public.notification_time_zone(p_user_id) as tz) zone
  ) dated;
$$;

-- "today", "tomorrow", "in 2 days", counted in calendar days where the
-- recipient is.
create or replace function public.notification_days_until(p_at timestamptz, p_user_id uuid)
returns text
language sql
stable
as $$
  select case days
    when 0 then 'today'
    when 1 then 'tomorrow'
    else 'in ' || days || ' days'
  end
  from (
    select (p_at at time zone tz)::date - (now() at time zone tz)::date as days
    from (select public.notification_time_zone(p_user_id) as tz) zone
  ) counted;
$$;

-- What a merged notification says (see notifications.merge_key).
create or replace function public.notification_merged_body(p_kind text, p_data jsonb)
returns text
language sql
immutable
as $$
  select case p_kind
    when 'entry_added' then
      (p_data ->> 'actor') || ' added ' || (p_data ->> 'count') || ' entries with you — your share is '
        || public.notification_amount((p_data ->> 'total')::numeric) || ' ' || (p_data ->> 'currency')
    when 'entry_added_other' then
      (p_data ->> 'actor') || ' added ' || (p_data ->> 'count') || ' entries ('
        || public.notification_amount((p_data ->> 'total')::numeric) || ' ' || (p_data ->> 'currency') || ')'
    when 'member_joined' then
      public.notification_join_names(array(select jsonb_array_elements_text(p_data -> 'names')))
        || ' joined the group'
  end;
$$;

-- Queues one notification for p_user_id, unless it's about something they
-- did themselves (anything but an 'always' one), they're no longer active in
-- p_group_id (unless p_require_member is false — e.g. telling someone they
-- were removed), or they've turned its category off. See the notifications
-- table for p_merge_key/p_merge_data and p_dedupe_key. Never fails the
-- change it's about: anything going wrong here only loses the notification.
-- Not callable by clients (see the grants section).
create or replace function public.notify(
  p_user_id uuid,
  p_kind text,
  p_category text,
  p_group_id uuid,
  p_title text,
  p_body text,
  p_url text,
  p_merge_key text default null,
  p_merge_data jsonb default null,
  p_dedupe_key text default null,
  p_require_member boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.notifications;
  merged jsonb;
begin
  if p_user_id is null or p_title is null or p_body is null then
    return;
  end if;

  if p_user_id = auth.uid() and p_category <> 'always' then
    return;
  end if;

  if p_require_member and p_group_id is not null and not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_user_id and left_at is null
  ) then
    return;
  end if;

  if not public.notification_category_on(p_user_id, p_category) then
    return;
  end if;

  if p_merge_key is not null then
    select * into existing
    from public.notifications
    where user_id = p_user_id and merge_key = p_merge_key and sent_at is null
    order by created_at desc
    limit 1
    for update;

    if found then
      merged := coalesce(existing.merge_data, '{}'::jsonb) || jsonb_build_object(
        'count',
        coalesce((existing.merge_data ->> 'count')::integer, 1)
          + coalesce((p_merge_data ->> 'count')::integer, 1),
        'total',
        coalesce((existing.merge_data ->> 'total')::numeric, 0)
          + coalesce((p_merge_data ->> 'total')::numeric, 0),
        'names',
        coalesce(
          (
            select jsonb_agg(name order by first_at)
            from (
              select name, min(ordinality) as first_at
              from jsonb_array_elements_text(
                coalesce(existing.merge_data -> 'names', '[]'::jsonb)
                  || coalesce(p_merge_data -> 'names', '[]'::jsonb)
              ) with ordinality as names (name, ordinality)
              group by name
            ) distinct_names
          ),
          '[]'::jsonb
        )
      );

      update public.notifications
      set merge_data = merged,
        body = coalesce(public.notification_merged_body(kind, merged), body)
      where id = existing.id;
      return;
    end if;
  end if;

  insert into public.notifications (
    user_id, kind, category, group_id, title, body, url, merge_key, merge_data, dedupe_key,
    send_after
  )
  values (
    p_user_id, p_kind, p_category, p_group_id, p_title, p_body, p_url, p_merge_key,
    p_merge_data, p_dedupe_key,
    case when p_merge_key is not null then now() + interval '2 minutes' else now() end
  )
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
exception when others then
  raise warning 'notify(%, %) failed: %', p_user_id, p_kind, sqlerrm;
end;
$$;

-- Who hands out the seats of p_group_id's pass, to tell them about free
-- seats: its active sponsor, or its admins if it has none (can_manage_plan).
create or replace function public.notification_plan_managers(p_group_id uuid)
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select user_id from public.group_members
  where group_id = p_group_id and left_at is null and user_id is not null
    and (
      is_sponsor
      or (
        is_admin and not exists (
          select 1 from public.group_members s
          where s.group_id = p_group_id and s.is_sponsor and s.left_at is null
        )
      )
    );
$$;

create or replace function public.notification_seats(p_count integer)
returns text
language sql
immutable
as $$
  select p_count || case when p_count = 1 then ' seat' else ' seats' end;
$$;

-- One share of an entry, the way calculateMemberBalances splits it.
create or replace function public.notification_log_share(p_log_id uuid)
returns numeric
language sql
security definer
set search_path = public
stable
as $$
  select l.converted_amount / nullif(
    (select count(*) from public.log_members m where m.log_id = l.id)
      + case when l.payer_included then 1 else 0 end,
    0
  )
  from public.logs l
  where l.id = p_log_id;
$$;

-- What p_other_id owes p_user_id in p_group_id (negative: p_user_id owes
-- them) — calculateMemberBalances for one pair.
create or replace function public.notification_pair_balance(
  p_group_id uuid,
  p_user_id uuid,
  p_other_id uuid
)
returns numeric
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(sum(
    case
      when l.paid_by = p_user_id and m.user_id = p_other_id then share.amount
      when l.paid_by = p_other_id and m.user_id = p_user_id then -share.amount
      else 0
    end
  ), 0)
  from public.logs l
  join public.log_members m on m.log_id = l.id
  cross join lateral (select public.notification_log_share(l.id) as amount) share
  where l.group_id = p_group_id;
$$;

-- '"Dinner"', or null for an entry without a description.
create or replace function public.notification_entry_label(p_details text)
returns text
language sql
immutable
as $$
  select case when coalesce(btrim(p_details), '') = '' then null else '"' || p_details || '"' end;
$$;

-- E1 / O1: a new entry, to everyone in the group but its payer.
create or replace function public.notify_entry_added(p_log_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  entry public.logs;
  grp public.groups;
  payer text;
  share numeric;
  label text;
  split_names text[];
  recipient uuid;
begin
  select * into entry from public.logs where id = p_log_id;
  select * into grp from public.groups where id = entry.group_id;
  payer := public.notification_name(entry.paid_by);
  share := public.notification_log_share(entry.id);
  label := public.notification_entry_label(entry.details);

  select array_agg(coalesce(pr.name, 'Deleted user') order by pr.name)
  into split_names
  from public.log_members m
  left join public.profiles pr on pr.id = m.user_id
  where m.log_id = entry.id;

  for recipient in
    select user_id from public.group_members
    where group_id = grp.id and left_at is null and user_id is not null
      and user_id is distinct from entry.paid_by
  loop
    if exists (
      select 1 from public.log_members where log_id = entry.id and user_id = recipient
    ) then
      perform public.notify(
        recipient, 'entry_added', 'myExpenses', grp.id, grp.name,
        payer || ' paid ' || public.notification_amount(entry.converted_amount) || ' ' || grp.currency
          || coalesce(' for ' || label, '')
          || ' — your share is ' || public.notification_amount(share) || ' ' || grp.currency,
        '/group/' || grp.id,
        'entry_added:' || grp.id || ':' || entry.paid_by,
        jsonb_build_object('count', 1, 'total', share, 'currency', grp.currency, 'actor', payer)
      );
    else
      perform public.notify(
        recipient, 'entry_added_other', 'otherExpenses', grp.id, grp.name,
        payer || ' paid ' || public.notification_amount(entry.converted_amount) || ' ' || grp.currency
          || coalesce(' for ' || label, '')
          || coalesce(', split with ' || nullif(public.notification_join_names(split_names), ''), ''),
        '/group/' || grp.id,
        'entry_added_other:' || grp.id || ':' || entry.paid_by,
        jsonb_build_object(
          'count', 1, 'total', entry.converted_amount, 'currency', grp.currency, 'actor', payer
        )
      );
    end if;
  end loop;
end;
$$;

-- E2 / E3 / E4: an edited entry, to the people whose share changed, who were
-- added to it or who were taken off it. p_old_members/p_old_share are the
-- entry as it was before the edit.
create or replace function public.notify_entry_changed(
  p_log_id uuid,
  p_old_members uuid[],
  p_old_share numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  entry public.logs;
  grp public.groups;
  payer text;
  share numeric;
  label text;
  new_members uuid[];
  recipient uuid;
  was_in boolean;
  is_in boolean;
begin
  select * into entry from public.logs where id = p_log_id;
  select * into grp from public.groups where id = entry.group_id;
  payer := public.notification_name(entry.paid_by);
  share := public.notification_log_share(entry.id);
  label := coalesce(public.notification_entry_label(entry.details), 'an entry');
  new_members := array(
    select user_id from public.log_members where log_id = entry.id and user_id is not null
  );

  for recipient in
    select distinct u from unnest(coalesce(p_old_members, '{}') || new_members) as u
    where u is not null and u is distinct from entry.paid_by
  loop
    was_in := recipient = any(p_old_members);
    is_in := recipient = any(new_members);

    if was_in and is_in then
      if round(p_old_share, 2) is distinct from round(share, 2) then
        perform public.notify(
          recipient, 'entry_changed', 'myExpenses', grp.id, grp.name,
          payer || ' changed ' || label || ' — your share is now '
            || public.notification_amount(share) || ' ' || grp.currency
            || ' (was ' || public.notification_amount(p_old_share) || ' ' || grp.currency || ')',
          '/group/' || grp.id
        );
      end if;
    elsif is_in then
      perform public.notify(
        recipient, 'entry_joined', 'myExpenses', grp.id, grp.name,
        payer || ' added you to ' || label || ' — your share is '
          || public.notification_amount(share) || ' ' || grp.currency,
        '/group/' || grp.id
      );
    else
      perform public.notify(
        recipient, 'entry_left', 'myExpenses', grp.id, grp.name,
        payer || ' took you off ' || label || ' — you no longer owe a share of it',
        '/group/' || grp.id
      );
    end if;
  end loop;
end;
$$;

-- E5: an entry about to be deleted (called before the delete), to everyone
-- who was on it. A deleted settle-up goes to the one who was paid back.
create or replace function public.notify_entry_deleted(p_log_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  entry public.logs;
  grp public.groups;
  payer text;
  share numeric;
  recipient uuid;
begin
  select * into entry from public.logs where id = p_log_id;
  select * into grp from public.groups where id = entry.group_id;
  payer := public.notification_name(entry.paid_by);
  share := public.notification_log_share(entry.id);

  for recipient in
    select user_id from public.log_members
    where log_id = entry.id and user_id is not null and user_id is distinct from entry.paid_by
  loop
    if entry.is_settlement then
      perform public.notify(
        recipient, 'settlement_deleted', 'settlements', grp.id, grp.name,
        payer || ' deleted their ' || public.notification_amount(entry.converted_amount) || ' '
          || grp.currency || ' settle-up with you — it''s no longer in your balance',
        '/group/' || grp.id
      );
    else
      perform public.notify(
        recipient, 'entry_deleted', 'myExpenses', grp.id, grp.name,
        payer || ' deleted '
          || coalesce(public.notification_entry_label(entry.details), 'an entry')
          || ' (' || public.notification_amount(entry.converted_amount) || ' ' || grp.currency
          || ') — your ' || public.notification_amount(share) || ' ' || grp.currency
          || ' share is gone from your balance',
        '/group/' || grp.id
      );
    end if;
  end loop;
end;
$$;

-- S1 / S2 / O2: a settle-up just recorded by settle_debt.
create or replace function public.notify_settlement(p_log_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  entry public.logs;
  grp public.groups;
  debtor uuid;
  creditor uuid;
  amount text;
  square text;
  recipient uuid;
begin
  select * into entry from public.logs where id = p_log_id;
  select * into grp from public.groups where id = entry.group_id;
  debtor := entry.paid_by;
  select user_id into creditor from public.log_members where log_id = entry.id limit 1;
  amount := public.notification_amount(entry.converted_amount) || ' ' || grp.currency;
  square := case
    when abs(public.notification_pair_balance(grp.id, debtor, creditor)) < 0.005
      then ' — you''re all square'
    else ''
  end;

  if auth.uid() = debtor then
    perform public.notify(
      creditor, 'settlement_paid', 'settlements', grp.id, grp.name,
      public.notification_name(debtor) || ' paid you back ' || amount || square,
      '/group/' || grp.id
    );
  else
    perform public.notify(
      debtor, 'settlement_marked', 'settlements', grp.id, grp.name,
      public.notification_name(creditor) || ' marked your ' || amount || ' debt as paid' || square,
      '/group/' || grp.id
    );
  end if;

  for recipient in
    select user_id from public.group_members
    where group_id = grp.id and left_at is null and user_id is not null
      and user_id is distinct from debtor and user_id is distinct from creditor
  loop
    perform public.notify(
      recipient, 'settlement_other', 'otherExpenses', grp.id, grp.name,
      public.notification_name(debtor) || ' paid ' || public.notification_name(creditor)
        || ' back ' || amount,
      '/group/' || grp.id
    );
  end loop;
end;
$$;

-- G1–G4: an admin editing the group, either directly (name, description,
-- photo — the columns clients can update) or through change_group_currency.
create or replace function public.notify_group_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor text;
  change text;
  recipient uuid;
begin
  if auth.uid() is null then
    return new;
  end if;
  actor := public.notification_name(auth.uid());

  for change in
    select message from (values
      (1, case when new.name is distinct from old.name
        then actor || ' renamed "' || old.name || '" to "' || new.name || '"' end),
      (2, case when new.description is distinct from old.description
        then actor || ' changed the group''s description' end),
      (3, case when new.photo_url is distinct from old.photo_url
        then actor || case when new.photo_url is null
          then ' removed the group''s photo' else ' changed the group''s photo' end end),
      (4, case when new.currency is distinct from old.currency
        then actor || ' changed the group''s currency from ' || old.currency || ' to '
          || new.currency || ' — all balances are now in ' || new.currency end)
    ) as changes (position, message)
    where message is not null
    order by position
  loop
    for recipient in
      select user_id from public.group_members
      where group_id = new.id and left_at is null and user_id is not null
    loop
      perform public.notify(
        recipient, 'group_changed', 'groupChanges', new.id, new.name, change, '/group/' || new.id
      );
    end loop;
  end loop;

  return new;
end;
$$;

drop trigger if exists groups_notify on public.groups;
create trigger groups_notify
  after update on public.groups
  for each row execute function public.notify_group_changed();

-- Everything recorded in group_events (membership, roles, seats) is
-- notified from here, so each RPC that records one doesn't need its own
-- notification code. Runs inside that RPC's transaction, after its event is
-- inserted — which is why some cases look at state the RPC hasn't changed
-- yet (a removed member's seat is still there when member_kicked is
-- recorded) or will change next (leave_group gives a new sponsor a seat
-- after recording sponsor_handed_over).
create or replace function public.notify_group_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  grp public.groups;
  actor text := public.notification_name(new.actor_id);
  target text := public.notification_name(new.target_id);
  group_url text := '/group/' || new.group_id;
  plan_url text := '/group-plan?groupId=' || new.group_id;
  recipient uuid;
  pass public.plans;
  holders uuid[];
  seats_taken integer;
  seats_free integer;
  message text;
  message_url text;
begin
  select * into grp from public.groups where id = new.group_id;
  if not found then
    return new;
  end if;

  case new.kind
  when 'member_joined' then
    for recipient in
      select user_id from public.group_members
      where group_id = grp.id and left_at is null and user_id is not null
    loop
      perform public.notify(
        recipient, 'member_joined', 'members', grp.id, grp.name,
        -- Rejoining reactivates the old row, which keeps its joined_at.
        case
          when exists (
            select 1 from public.group_members
            where group_id = grp.id and user_id = new.actor_id and joined_at < now()
          ) then actor || ' is back in the group'
          else actor || ' joined the group'
        end,
        group_url,
        'member_joined:' || grp.id,
        jsonb_build_object('names', jsonb_build_array(actor))
      );
    end loop;

    -- P6: someone locked joined while the group's pass has seats to give.
    select * into pass from public.plans
    where group_id = grp.id and starts_at is not null and ends_at > now()
    order by starts_at
    limit 1;
    if found then
      seats_free := pass.seat_count - (
        select count(*) from public.plan_seats where plan_id = pass.id and released_at is null
      );
      perform public.renew_test_subscriptions();
      if seats_free > 0
        and not exists (
          select 1 from public.plan_seats
          where plan_id = pass.id and user_id = new.actor_id and released_at is null
        )
        and not public.unlocked_on(new.actor_id, greatest(now(), pass.starts_at)) then
        for recipient in select public.notification_plan_managers(grp.id) loop
          perform public.notify(
            recipient, 'plan_member_locked', 'plans', grp.id, grp.name,
            actor || ' joined and isn''t unlocked — you have ' || seats_free || ' free '
              || case when seats_free = 1 then 'seat' else 'seats' end || ' on the Trip Pass',
            plan_url
          );
        end loop;
      end if;
    end if;

  when 'member_left' then
    message := case
      when current_setting('app.deleting_account', true) = 'on'
        then actor || ' deleted their account and left the group. Their past entries stay, as "Deleted user"'
      else actor || ' left the group'
    end;
    for recipient in
      select user_id from public.group_members
      where group_id = grp.id and left_at is null and user_id is not null
    loop
      perform public.notify(recipient, 'member_left', 'members', grp.id, grp.name, message, group_url);
    end loop;

  when 'member_kicked' then
    -- kick_member frees their seat on a pass that hasn't started right after
    -- recording this, so it's still there.
    perform public.notify(
      new.target_id, 'removed_from_group', 'aboutMe', grp.id, 'Removed from ' || grp.name,
      case
        when exists (
          select 1 from public.plan_seats s
          join public.plans p on p.id = s.plan_id
          where p.group_id = grp.id and p.starts_at > now()
            and s.user_id = new.target_id and s.released_at is null
        ) then actor || ' removed you from the group, and your seat on its pass went back to the group'
        else actor || ' removed you from the group. Your past entries stay, and an invite link brings you back'
      end,
      '/',
      p_require_member => false
    );
    for recipient in
      select user_id from public.group_members
      where group_id = grp.id and left_at is null and user_id is not null
    loop
      perform public.notify(
        recipient, 'member_removed', 'members', grp.id, grp.name,
        actor || ' removed ' || target || ' from the group', group_url
      );
    end loop;

  when 'admin_promoted', 'admin_auto_promoted', 'admin_demoted' then
    perform public.notify(
      new.target_id, new.kind, 'aboutMe', grp.id, grp.name,
      case new.kind
        when 'admin_promoted' then
          actor || ' made you an admin — you can now edit the group and manage its members'
        when 'admin_auto_promoted' then
          actor || ' left, so you''re now an admin — you can edit the group and manage its members'
        else actor || ' removed you as admin'
      end,
      group_url
    );
    message := case new.kind
      when 'admin_promoted' then actor || ' made ' || target || ' an admin'
      when 'admin_auto_promoted' then target || ' is now an admin, since ' || actor || ' left'
      else actor || ' removed ' || target || ' as admin'
    end;
    for recipient in
      select user_id from public.group_members
      where group_id = grp.id and left_at is null and user_id is not null
        and user_id is distinct from new.target_id
    loop
      perform public.notify(recipient, new.kind || '_other', 'groupChanges', grp.id, grp.name, message, group_url);
    end loop;

  when 'sponsor_handed_over' then
    message := actor || ' left the group, so you''ve taken over as sponsor — you manage its pass and its seats';
    message_url := group_url;
    -- On a pass that hasn't started, leave_group goes on to give the new
    -- sponsor a seat the same way (or can't, when it's full).
    select * into pass from public.plans where group_id = grp.id and starts_at > now();
    if found then
      perform public.renew_test_subscriptions();
      if not exists (
          select 1 from public.plan_seats
          where plan_id = pass.id and user_id = new.target_id and released_at is null
        )
        and not public.unlocked_on(new.target_id, pass.starts_at) then
        message_url := plan_url;
        if (
          select count(*) from public.plan_seats where plan_id = pass.id and released_at is null
        ) < pass.seat_count then
          message := actor || ' left the group, so you''ve taken over as sponsor and got their seat on the pass that starts on '
            || public.notification_date(pass.starts_at, new.target_id);
        else
          message := actor || ' left, so you''re the sponsor now. The pass starting on '
            || public.notification_date(pass.starts_at, new.target_id)
            || ' is full — take a seat back from someone and give it to yourself before then';
        end if;
      end if;
    end if;
    perform public.notify(
      new.target_id, 'became_sponsor', 'aboutMe', grp.id, 'You''re now the sponsor of ' || grp.name,
      message, message_url
    );
    for recipient in
      select user_id from public.group_members
      where group_id = grp.id and left_at is null and user_id is not null
        and user_id is distinct from new.target_id
    loop
      perform public.notify(
        recipient, 'sponsor_handed_over_other', 'groupChanges', grp.id, grp.name,
        target || ' is now the group''s sponsor, since ' || actor || ' left', group_url
      );
    end loop;

  when 'plan_started' then
    select * into pass from public.plans where id = (new.details ->> 'plan_id')::uuid;
    if not found then
      return new;
    end if;
    holders := array(
      select value::uuid from jsonb_array_elements_text(coalesce(new.details -> 'seat_holders', '[]'::jsonb))
    );
    seats_free := pass.seat_count - cardinality(holders);
    for recipient in
      select user_id from public.group_members
      where group_id = grp.id and left_at is null and user_id is not null
    loop
      if recipient = any(holders) then
        if pass.starts_at <= now() then
          perform public.notify(
            recipient, 'plan_seat_at_setup', 'plans', grp.id, grp.name || ' is unlocked',
            actor || ' set up a Trip Pass and gave you a seat — you can add entries until '
              || public.notification_date(pass.ends_at, recipient),
            group_url
          );
        else
          perform public.notify(
            recipient, 'plan_seat_at_setup', 'plans', grp.id, grp.name,
            actor || ' set up a Trip Pass starting on ' || public.notification_date(pass.starts_at, recipient)
              || ' and gave you a seat — you''ll be unlocked until '
              || public.notification_date(pass.ends_at, recipient),
            group_url
          );
        end if;
      elsif seats_free > 0 then
        perform public.notify(
          recipient, 'plan_set_up', 'plans', grp.id, grp.name,
          actor || ' set up a Trip Pass for the group — ' || seats_free || ' of ' || pass.seat_count
            || ' seats are still free. Ask ' || actor || ' for one',
          plan_url
        );
      else
        perform public.notify(
          recipient, 'plan_set_up', 'plans', grp.id, grp.name,
          actor || ' set up a Trip Pass for the group (all ' || pass.seat_count || ' seats are taken)',
          group_url
        );
      end if;
    end loop;

  when 'plan_seat_given' then
    -- Given by leave_group to a new sponsor: their became_sponsor says so.
    if new.target_id = new.actor_id or not exists (
      select 1 from public.group_members
      where group_id = grp.id and user_id = new.actor_id and left_at is null
    ) then
      return new;
    end if;
    select * into pass from public.plans where id = (new.details ->> 'plan_id')::uuid;
    if not found then
      return new;
    end if;
    perform public.notify(
      new.target_id, 'plan_seat_given', 'plans', grp.id, grp.name,
      actor || ' gave you a seat on the group''s Trip Pass — '
        || case
          when pass.starts_at <= now() then
            'you can add entries until ' || public.notification_date(pass.ends_at, new.target_id)
          else
            'you''ll be unlocked from ' || public.notification_date(pass.starts_at, new.target_id)
              || ' to ' || public.notification_date(pass.ends_at, new.target_id)
        end,
      group_url
    );

  when 'plan_seat_removed' then
    select * into pass from public.plans where id = (new.details ->> 'plan_id')::uuid;
    if not found then
      return new;
    end if;
    if new.actor_id is distinct from new.target_id then
      -- Taken back by whoever manages the pass. (Someone removed from the
      -- group isn't an active member any more, so only gets
      -- removed_from_group.)
      perform public.notify(
        new.target_id, 'plan_seat_removed', 'plans', grp.id, grp.name,
        actor || ' took back your seat on the group''s Trip Pass — you won''t be unlocked when it starts on '
          || public.notification_date(pass.starts_at, new.target_id),
        plan_url
      );
    elsif not exists (
      -- Their own, by leaving. Not when the sponsor left: whoever takes over
      -- is told about the pass in became_sponsor.
      select 1 from public.group_members
      where group_id = grp.id and user_id = new.actor_id and left_as_sponsor
    ) or exists (
      select 1 from public.group_members where group_id = grp.id and is_sponsor and left_at is null
    ) then
      seats_taken := coalesce((new.details ->> 'seats_used')::integer, 0);
      seats_free := pass.seat_count - seats_taken;
      for recipient in select public.notification_plan_managers(grp.id) loop
        perform public.notify(
          recipient, 'plan_seat_freed', 'plans', grp.id, grp.name,
          actor || ' left, so their seat on the Trip Pass is free again — ' || seats_free || ' of '
            || pass.seat_count || ' seats free',
          plan_url
        );
      end loop;
    end if;

  else
    null;
  end case;

  return new;
end;
$$;

drop trigger if exists group_events_notify on public.group_events;
create trigger group_events_notify
  after insert on public.group_events
  for each row execute function public.notify_group_event();

-- R10 / R11: called by check_entry_access when a group is down to its last
-- 3 free entries, and when it has used them all, for everyone in it who
-- isn't unlocked.
create or replace function public.notify_free_entries(p_group_id uuid, p_left integer, p_total integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  grp public.groups;
  recipient uuid;
begin
  select * into grp from public.groups where id = p_group_id;
  for recipient in
    select user_id from public.group_members
    where group_id = p_group_id and left_at is null and user_id is not null
      and public.unlocked_until(user_id) is null
  loop
    perform public.notify(
      recipient,
      case when p_left = 0 then 'free_entries_used' else 'free_entries_low' end,
      'reminders', p_group_id, grp.name,
      case
        when p_left = 0 then
          'All ' || p_total || ' free entries in this group are used. Unlock to keep adding entries'
        else
          p_left || ' free ' || case when p_left = 1 then 'entry' else 'entries' end
            || ' left in this group. Unlock to keep adding entries once they''re used'
      end,
      '/paywall',
      p_dedupe_key => case when p_left = 0 then 'free_entries_used:' else 'free_entries_low:' end
        || p_group_id
    );
  end loop;
end;
$$;

-- Mirrors PLAN_PRICES in src/constants/plans.ts for the two subscriptions
-- (always "Just me"), for the renewal reminder. Placeholders, like those.
create or replace function public.notification_subscription_price(p_duration interval)
returns text
language sql
immutable
as $$
  select case when p_duration >= interval '1 year' then '29.99 EUR' else '3.99 EUR' end;
$$;

-- The reminders (R1–R9 in docs/notifications.md) and P10 (a pass set up to
-- start later has started): run every 10 minutes by pg_cron. Each is sent
-- once per person (dedupe_key), keyed on the date it's about, so a pass
-- that's moved or lengthened gets a fresh one. None of the "ending" ones go
-- to someone something else keeps unlocked past that date (unlocked_on).
create or replace function public.send_scheduled_notifications()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  pass public.plans;
  grp public.groups;
  recipient uuid;
  member_id uuid;
  member_until timestamptz;
  seats_taken integer;
  started_event_at timestamptz;
  epoch text;
begin
  perform public.renew_test_subscriptions();

  -- R1 / R1b / R2: a Trip Pass ending within 2 days.
  for pass in
    select * from public.plans
    where kind = 'trip_pass' and starts_at <= now()
      and ends_at > now() and ends_at <= now() + interval '2 days'
  loop
    select * into grp from public.groups where id = pass.group_id;
    epoch := extract(epoch from pass.ends_at)::bigint::text;
    for recipient in
      select user_id from public.plan_seats
      where plan_id = pass.id and released_at is null and user_id is not null
    loop
      if public.unlocked_on(recipient, pass.ends_at) then
        continue;
      end if;
      perform public.notify(
        recipient, 'plan_ending', 'reminders', null,
        'Your Trip Pass ends ' || public.notification_days_until(pass.ends_at, recipient),
        case when grp.id is not null then grp.name || '''s pass runs' else 'It runs' end
          || ' until ' || public.notification_date(pass.ends_at, recipient)
          || '. After that, adding entries needs a new unlock — settling up always works',
        case when grp.id is not null then '/group/' || grp.id else '/plans' end,
        p_dedupe_key => 'plan_ending:' || pass.id || ':' || epoch
      );
    end loop;

    if grp.id is not null and pass.sponsor_id is not null and not exists (
      select 1 from public.plan_seats
      where plan_id = pass.id and user_id = pass.sponsor_id and released_at is null
    ) then
      perform public.notify(
        pass.sponsor_id, 'plan_ending_sponsor', 'reminders', null,
        grp.name || '''s Trip Pass ends ' || public.notification_days_until(pass.ends_at, pass.sponsor_id),
        'It runs until ' || public.notification_date(pass.ends_at, pass.sponsor_id),
        '/group-plan?groupId=' || grp.id,
        p_dedupe_key => 'plan_ending:' || pass.id || ':' || epoch
      );
    end if;
  end loop;

  -- R3 / R3b: a Trip Pass that ended in the last day.
  for pass in
    select * from public.plans
    where kind = 'trip_pass' and ends_at <= now() and ends_at > now() - interval '1 day'
  loop
    select * into grp from public.groups where id = pass.group_id;
    for recipient in
      select user_id from public.plan_seats
      where plan_id = pass.id and released_at is null and user_id is not null
      union
      select pass.sponsor_id where pass.sponsor_id is not null
    loop
      if public.unlocked_on(recipient, now()) then
        continue;
      end if;
      perform public.notify(
        recipient, 'plan_ended', 'reminders', null, 'Your Trip Pass has ended',
        case when grp.id is not null then grp.name || '''s pass ended. ' else '' end
          || 'Your entries and balances stay — unlock again to add new ones',
        '/paywall',
        p_dedupe_key => 'plan_ended:' || pass.id
      );
    end loop;
  end loop;

  -- R4 / R5: a subscription renewing, or (cancelled) ending, within 2 days.
  for pass in
    select * from public.plans
    where kind = 'subscription' and sponsor_id is not null and starts_at <= now()
      and ends_at > now() and ends_at <= now() + interval '2 days'
  loop
    epoch := extract(epoch from pass.ends_at)::bigint::text;
    if pass.will_renew then
      perform public.notify(
        pass.sponsor_id, 'subscription_renewing', 'reminders', null,
        'Your subscription renews ' || public.notification_days_until(pass.ends_at, pass.sponsor_id),
        'Your ' || case when pass.duration >= interval '1 year' then 'yearly' else 'monthly' end
          || ' subscription renews on ' || public.notification_date(pass.ends_at, pass.sponsor_id)
          || ' for ' || public.notification_subscription_price(pass.duration)
          || '. You can cancel it until then',
        '/subscription?planId=' || pass.id,
        p_dedupe_key => 'subscription_renewing:' || pass.id || ':' || epoch
      );
    elsif not public.unlocked_on(pass.sponsor_id, pass.ends_at) then
      perform public.notify(
        pass.sponsor_id, 'subscription_ending', 'reminders', null,
        'Your subscription ends ' || public.notification_days_until(pass.ends_at, pass.sponsor_id),
        'You''re unlocked until ' || public.notification_date(pass.ends_at, pass.sponsor_id)
          || '. Resume it to stay unlocked',
        '/subscription?planId=' || pass.id,
        p_dedupe_key => 'subscription_ending:' || pass.id || ':' || epoch
      );
    end if;
  end loop;

  -- R6: a cancelled subscription that ended in the last day. (One upgraded
  -- to yearly ends too, but the yearly one keeps its holder unlocked.)
  for pass in
    select * from public.plans
    where kind = 'subscription' and sponsor_id is not null and not will_renew
      and ends_at <= now() and ends_at > now() - interval '1 day'
  loop
    if not public.unlocked_on(pass.sponsor_id, now()) then
      perform public.notify(
        pass.sponsor_id, 'subscription_ended', 'reminders', null, 'Your subscription has ended',
        'Your entries and balances stay — unlock again to add new ones',
        '/paywall',
        p_dedupe_key => 'subscription_ended:' || pass.id
      );
    end if;
  end loop;

  -- R7: a Trip Pass bought 3 days ago or more and still not set up.
  for pass in
    select * from public.plans
    where kind = 'trip_pass' and starts_at is null and sponsor_id is not null
      and created_at <= now() - interval '3 days'
  loop
    perform public.notify(
      pass.sponsor_id, 'plan_not_set_up', 'reminders', null, 'Your Trip Pass is ready',
      'Set it up to choose your group and when it starts — it won''t count down until you do',
      '/plan-setup?planId=' || pass.id,
      p_dedupe_key => 'plan_not_set_up:' || pass.id
    );
  end loop;

  -- R8: a group pass starting within a day that still has free seats.
  for pass in
    select * from public.plans
    where group_id is not null and starts_at > now() and starts_at <= now() + interval '1 day'
  loop
    seats_taken := (
      select count(*) from public.plan_seats where plan_id = pass.id and released_at is null
    );
    if seats_taken >= pass.seat_count then
      continue;
    end if;
    select * into grp from public.groups where id = pass.group_id;
    epoch := extract(epoch from pass.starts_at)::bigint::text;
    for recipient in select public.notification_plan_managers(grp.id) loop
      perform public.notify(
        recipient, 'plan_starting_free_seats', 'reminders', grp.id,
        grp.name || '''s Trip Pass starts ' || public.notification_days_until(pass.starts_at, recipient),
        (pass.seat_count - seats_taken) || ' of ' || pass.seat_count
          || ' seats are still free — give them out so everyone''s unlocked from the start',
        '/group-plan?groupId=' || grp.id,
        p_dedupe_key => 'plan_starting_free_seats:' || pass.id || ':' || epoch
      );
    end loop;
  end loop;

  -- R9: someone in a group whose running pass has free seats, without a seat
  -- on it, whose unlock ends within 2 days and before the pass does.
  for pass in
    select * from public.plans
    where group_id is not null and starts_at <= now() and ends_at > now()
  loop
    seats_taken := (
      select count(*) from public.plan_seats where plan_id = pass.id and released_at is null
    );
    if seats_taken >= pass.seat_count then
      continue;
    end if;
    select * into grp from public.groups where id = pass.group_id;
    for member_id in
      select gm.user_id from public.group_members gm
      where gm.group_id = grp.id and gm.left_at is null and gm.user_id is not null
        and not exists (
          select 1 from public.plan_seats s
          where s.plan_id = pass.id and s.user_id = gm.user_id and s.released_at is null
        )
    loop
      member_until := public.unlocked_until(member_id);
      if member_until is null or member_until > now() + interval '2 days'
        or member_until >= pass.ends_at or public.unlocked_on(member_id, member_until) then
        continue;
      end if;
      for recipient in select public.notification_plan_managers(grp.id) loop
        perform public.notify(
          recipient, 'member_unlock_ending', 'reminders', grp.id, grp.name,
          public.notification_name(member_id) || '''s unlock ends on '
            || public.notification_date(member_until, recipient)
            || ', before the Trip Pass does — give them a seat to keep them unlocked',
          '/group-plan?groupId=' || grp.id,
          p_dedupe_key => 'member_unlock_ending:' || pass.id || ':' || member_id || ':'
            || extract(epoch from member_until)::bigint
        );
      end loop;
    end loop;
  end loop;

  -- P10: a group pass set up to start later has started.
  for pass in
    select * from public.plans
    where group_id is not null and starts_at <= now() and starts_at > now() - interval '1 day'
  loop
    select max(created_at) into started_event_at
    from public.group_events
    where group_id = pass.group_id and kind = 'plan_started'
      and details ->> 'plan_id' = pass.id::text;
    if started_event_at is null or started_event_at >= pass.starts_at - interval '1 minute' then
      continue;
    end if;
    select * into grp from public.groups where id = pass.group_id;
    for recipient in
      select user_id from public.plan_seats
      where plan_id = pass.id and released_at is null and user_id is not null
    loop
      perform public.notify(
        recipient, 'plan_started', 'plans', grp.id, grp.name || ' is unlocked',
        'The Trip Pass has started — you can add entries until '
          || public.notification_date(pass.ends_at, recipient),
        '/group/' || grp.id,
        p_dedupe_key => 'plan_started:' || pass.id || ':' || extract(epoch from pass.starts_at)::bigint
      );
    end loop;
  end loop;
end;
$$;

-- X1: always sent, even for a change made from the same phone (it can't
-- tell which device did it). Not for a first password on an account that
-- signed up with Google.
create or replace function public.notify_password_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(old.encrypted_password, '') <> ''
    and new.encrypted_password is distinct from old.encrypted_password then
    perform public.notify(
      new.id, 'password_changed', 'always', null, 'Your password was changed',
      'If this wasn''t you, reset your password right away', '/account'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_password_changed on auth.users;
create trigger on_auth_user_password_changed
  after update of encrypted_password on auth.users
  for each row execute function public.notify_password_changed();

-- Called by the app once it has a push token (on every launch, so a token
-- moves to whoever signed in on that device last).
create or replace function public.register_push_token(p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  if p_token !~ '^Expo(nent)?PushToken\[[^\]]{1,200}\]$' then
    raise exception 'Not an Expo push token';
  end if;

  insert into public.push_tokens (token, user_id, platform, updated_at)
  values (p_token, auth.uid(), p_platform, now())
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform, updated_at = now();
end;
$$;

grant execute on function public.register_push_token(text, text) to authenticated;

-- Called by the app right before signing out, so that device stops getting
-- this account's notifications.
create or replace function public.unregister_push_token(p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.push_tokens where token = p_token and user_id = auth.uid();
$$;

grant execute on function public.unregister_push_token(text) to authenticated;

-- The send-notifications Edge Function's two calls (service role only):
-- takes every notification that's due, marking it sent, with the push
-- tokens of the person it's for (none: nothing to send it to)…
create or replace function public.claim_due_notifications(p_limit integer default 500)
returns table (id uuid, title text, body text, url text, tokens text[])
language sql
security definer
set search_path = public
as $$
  with due as (
    select n.id from public.notifications n
    where n.sent_at is null and n.send_after <= now()
    order by n.send_after
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.notifications n
    set sent_at = now()
    from due
    where n.id = due.id
    returning n.id, n.user_id, n.title, n.body, n.url
  )
  select c.id, c.title, c.body, c.url,
    coalesce(array_agg(t.token) filter (where t.token is not null), '{}')
  from claimed c
  left join public.push_tokens t on t.user_id = c.user_id
  group by c.id, c.title, c.body, c.url;
$$;

-- …and forgets tokens Expo says no longer reach a device (the app was
-- uninstalled).
create or replace function public.remove_push_tokens(p_tokens text[])
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.push_tokens where token = any(p_tokens);
$$;

-- Run every minute by pg_cron: calls the send-notifications Edge Function
-- when anything is due. Its address and shared secret live in Vault
-- ('project_url', 'notifications_cron_secret' — set by hand, see CLAUDE.md),
-- not in this file.
create or replace function public.trigger_notification_sender()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  project_url text;
  cron_secret text;
begin
  if not exists (
    select 1 from public.notifications where sent_at is null and send_after <= now()
  ) then
    return;
  end if;

  select decrypted_secret into project_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into cron_secret
  from vault.decrypted_secrets where name = 'notifications_cron_secret';
  if project_url is null or cron_secret is null then
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/send-notifications',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cron_secret),
    body := '{}'::jsonb
  );
end;
$$;

-- Supabase has both extensions; skipped where it doesn't (e.g. a local test
-- database). cron.schedule replaces a job of the same name.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
    and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron;
    perform cron.schedule(
      'send-notifications', '* * * * *', 'select public.trigger_notification_sender()'
    );
    perform cron.schedule(
      'notification-reminders', '*/10 * * * *', 'select public.send_scheduled_notifications()'
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- RLS policies only take effect once the role already has the underlying SQL
-- privilege on the table. Dashboard-created tables get this automatically;
-- tables created via the SQL Editor don't always inherit it, which is what
-- was causing "new row violates row-level security policy" on every insert.

grant usage on schema public to authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.exchange_rates to authenticated;
-- Supabase's default privileges grant every new public table in full to
-- anon and authenticated. These are taken back to exactly what clients need
-- rather than left to RLS alone:
--   group_events: read-only to clients (see the table above).
--   logs/log_members: entries are only ever written by create_log,
--     update_log and settle_debt, which is where the paywall lives
--     (check_entry_access); a direct insert would skip it. Deleting your own
--     log directly stays allowed (the logs_delete policy), since deleting is
--     always free.
--   groups: only ever created through create_group, and only these columns
--     written directly (updateGroup in use-groups.tsx). Column grants only work once the table-wide ones are gone,
--     and revoking a table privilege also revokes its column privileges, so
--     this order is what keeps re-running the file safe.
--   group_members: read-only to clients. Every membership change goes
--     through an RPC (join_group, leave_group, kick_member,
--     promote_to_admin, demote_admin, set_group_pinned, set_up_plan), which
--     is where the admin/sponsor rules live; a direct update would let an
--     admin strip the sponsor's role or remove them.
--   The plan tables: no client access at all (see "Plans" above).
revoke all on public.group_members from anon, authenticated;
grant select on public.group_members to authenticated;

revoke all on public.group_events from anon, authenticated;
grant select on public.group_events to authenticated;

revoke all on public.logs from anon, authenticated;
grant select, delete on public.logs to authenticated;

revoke all on public.log_members from anon, authenticated;
grant select on public.log_members to authenticated;

revoke all on public.groups from anon, authenticated;
grant select, delete on public.groups to authenticated;
grant update (name, description, motive, hue, photo_url) on public.groups to authenticated;

revoke all on public.billing_settings, public.billing_testers, public.plans, public.plan_seats,
  public.free_entry_usage
  from anon, authenticated;

-- Notifications: your own settings are read and written directly
-- (NotificationsProvider), your own notifications only read, and push
-- tokens only through register_push_token/unregister_push_token.
revoke all on public.notification_settings, public.notifications, public.push_tokens
  from anon, authenticated;
grant select, insert, update on public.notification_settings to authenticated;
grant select on public.notifications to authenticated;

-- Internal plan functions, only ever called from inside the security
-- definer functions above (which run as their owner). unlocked_until and
-- unlocked_on answer for any user, and create_plan/add_plan_seats/upgrade_plan hand out plans
-- for free, so
-- clients can't call any of them directly. Supabase's default privileges
-- grant every new function to anon and authenticated by name, which is why
-- revoking from public alone wouldn't be enough.
revoke all on function public.unlocked_until(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.unlocked_on(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.can_manage_plan(uuid) from public, anon, authenticated;
revoke all on function public.free_pending_plan_seat(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.can_test_purchase() from public, anon, authenticated;
revoke all on function public.renew_test_subscriptions() from public, anon, authenticated;
-- Notifications: notify() and its helpers send or answer for anyone, and
-- the sender's two functions are for the send-notifications Edge Function
-- (service role) alone.
revoke all on function public.notify(
  uuid, text, text, uuid, text, text, text, text, jsonb, text, boolean
) from public, anon, authenticated;
revoke all on function public.notification_category_on(uuid, text) from public, anon, authenticated;
revoke all on function public.notification_name(uuid) from public, anon, authenticated;
revoke all on function public.notification_time_zone(uuid) from public, anon, authenticated;
revoke all on function public.notification_date(timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.notification_days_until(timestamptz, uuid)
  from public, anon, authenticated;
revoke all on function public.notification_plan_managers(uuid) from public, anon, authenticated;
revoke all on function public.notification_log_share(uuid) from public, anon, authenticated;
revoke all on function public.notification_pair_balance(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.notify_entry_added(uuid) from public, anon, authenticated;
revoke all on function public.notify_entry_changed(uuid, uuid[], numeric)
  from public, anon, authenticated;
revoke all on function public.notify_entry_deleted(uuid) from public, anon, authenticated;
revoke all on function public.notify_settlement(uuid) from public, anon, authenticated;
revoke all on function public.notify_free_entries(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.notify_group_changed() from public, anon, authenticated;
revoke all on function public.notify_group_event() from public, anon, authenticated;
revoke all on function public.notify_password_changed() from public, anon, authenticated;
revoke all on function public.send_scheduled_notifications() from public, anon, authenticated;
revoke all on function public.trigger_notification_sender() from public, anon, authenticated;
revoke all on function public.claim_due_notifications(integer) from public, anon, authenticated;
revoke all on function public.remove_push_tokens(text[]) from public, anon, authenticated;
revoke all on function public.check_entry_access(uuid, uuid[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.create_plan(
  uuid, text, integer, interval, boolean, text, text, text
) from public, anon, authenticated;
revoke all on function public.add_plan_seats(uuid, integer) from public, anon, authenticated;
revoke all on function public.upgrade_plan(uuid, integer, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.logs enable row level security;
alter table public.exchange_rates enable row level security;
alter table public.log_members enable row level security;
alter table public.group_events enable row level security;
-- No policies at all on these: clients have no grants on them either (see
-- above), and every read/write goes through a security definer function.
alter table public.billing_settings enable row level security;
alter table public.billing_testers enable row level security;
alter table public.free_entry_usage enable row level security;
alter table public.plans enable row level security;
alter table public.plan_seats enable row level security;
alter table public.notification_settings enable row level security;
alter table public.notifications enable row level security;
-- No policies: only ever touched through register_push_token,
-- unregister_push_token and the sender's functions.
alter table public.push_tokens enable row level security;

drop policy if exists "notification_settings_own" on public.notification_settings;
create policy "notification_settings_own" on public.notification_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
  for select using (user_id = auth.uid());

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

-- Not exercised: clients no longer have insert on groups at all (see the
-- grants section) — creating one goes through create_group. Kept for the
-- same defense-in-depth reasoning as the other unused policies in this file.
drop policy if exists "groups_insert" on public.groups;
create policy "groups_insert" on public.groups
  for insert with check (created_by = auth.uid());

-- Only admins can edit name/description/currency (currency changes also go
-- through change_group_currency, which enforces the same check itself).
drop policy if exists "groups_update" on public.groups;
create policy "groups_update" on public.groups
  for update using (public.is_group_admin(id));

-- group_members: see membership rows (active and departed) for your own
-- groups. Clients can't write them at all (see the grants section), so
-- there are no insert/update/delete policies.
drop policy if exists "group_members_select" on public.group_members;
create policy "group_members_select" on public.group_members
  for select using (public.is_group_member(group_id));

drop policy if exists "group_members_insert" on public.group_members;
drop policy if exists "group_members_delete" on public.group_members;
drop policy if exists "group_members_update" on public.group_members;

-- logs: any member of the group can read its entries. Adding one only goes
-- through create_log/settle_debt (see the grants section for why there's no
-- insert policy anymore).
drop policy if exists "logs_select" on public.logs;
create policy "logs_select" on public.logs
  for select using (public.is_group_member(group_id));

drop policy if exists "logs_insert" on public.logs;

-- Not exercised by the app (delete_log above goes through a security
-- definer RPC), kept for the same defense-in-depth reasoning as the other
-- unused policies in this file.
drop policy if exists "logs_delete" on public.logs;
create policy "logs_delete" on public.logs
  for delete using (paid_by = auth.uid());

-- log_members: readable by members of the log's group, and only ever
-- written by the RPCs that write the log itself.
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

-- group_events: readable by the group's active members, same as logs. No
-- insert/update/delete policy at all — every event is written by the
-- security definer RPC that made the change it records (see group_events
-- above), never directly by a client.
drop policy if exists "group_events_select" on public.group_events;
create policy "group_events_select" on public.group_events
  for select using (public.is_group_member(group_id));

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

-- ---------------------------------------------------------------------------
-- Storage (group photos)
-- ---------------------------------------------------------------------------
-- Same reasoning as avatars above (public bucket, own-uid-prefixed path), but
-- without a fixed "/photo" slot: one user creates many groups, each getting
-- its own random object key, uploaded once at create_group time and never
-- replaced (no editing a group's photo after creation yet) — so no
-- update/delete policy is needed here, only select + insert.

insert into storage.buckets (id, name, public)
values ('group-photos', 'group-photos', true)
on conflict (id) do nothing;

drop policy if exists "group_photos_public_select" on storage.objects;
create policy "group_photos_public_select" on storage.objects
  for select using (bucket_id = 'group-photos');

drop policy if exists "group_photos_insert_own" on storage.objects;
create policy "group_photos_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'group-photos' and (storage.foldername(name))[1] = auth.uid()::text
  );
