-- ============================================================
--  ABOS Chat — Sync migration
--  Run this AFTER schema.sql + migration_ai_replies.sql
--  (or on the current live DB — every statement here is
--  idempotent / safe to re-run, it will no-op where already applied)
--
--  Why this file exists: several fixes were applied directly on the
--  live Supabase project over time (via SQL editor) and were never
--  written back into this repo's schema.sql / migration_ai_replies.sql.
--  This file brings a fresh clone of the repo up to parity with what's
--  actually running in production. Some of these are not cosmetic —
--  #3 below (RLS recursion) breaks EVERY login if missing.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Bot profile: drop the FK to auth.users for this one row.
--    The "ABOS Assistant" bot profile has no matching auth.users row
--    on purpose (it can never log in — message-attribution only), so
--    the FK has to go entirely, not just be marked NOT VALID.
-- ------------------------------------------------------------
alter table abos_chat_profiles drop constraint if exists abos_chat_profiles_id_fkey;

insert into abos_chat_profiles (id, customer_number, name, email, role)
values ('00000000-0000-0000-0000-000000000001', 'ABOS-BOT', 'ABOS Assistant', null, 'owner')
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 2. AI auto-reply columns + toggle policy, re-applied correctly.
--    NOTE: this repo's migration_ai_replies.sql uses
--    "create policy if not exists" — that syntax does not exist in
--    Postgres (only certain other CREATE ... IF NOT EXISTS forms do).
--    That line throws a syntax error, which aborts the whole script,
--    so ai_mode/is_ai never actually got created when run as-is. This
--    redoes it with the correct drop-then-create pattern.
-- ------------------------------------------------------------
alter table abos_chat_conversations
  add column if not exists ai_mode boolean not null default false;

alter table abos_chat_messages
  add column if not exists is_ai boolean not null default false;

-- ------------------------------------------------------------
-- 3. Fix RLS infinite recursion (CRITICAL — without this, every read
--    of abos_chat_profiles/conversations/messages errors out, which
--    is why login could silently fail forever).
--
--    The original policies checked "is this user an owner?" by
--    querying abos_chat_profiles from WITHIN a policy defined ON
--    abos_chat_profiles itself — Postgres detects that as infinite
--    recursion. Fix: a SECURITY DEFINER helper function does the
--    ownership check with RLS bypassed internally, breaking the cycle.
-- ------------------------------------------------------------
create or replace function abos_chat_is_owner(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists(select 1 from abos_chat_profiles where id = uid and role = 'owner');
$$;

grant execute on function abos_chat_is_owner(uuid) to authenticated, anon;

drop policy if exists "read own profile" on abos_chat_profiles;
create policy "read own profile" on abos_chat_profiles
  for select using (auth.uid() = id or abos_chat_is_owner(auth.uid()));

drop policy if exists "read own conversation" on abos_chat_conversations;
create policy "read own conversation" on abos_chat_conversations
  for select using (customer_id = auth.uid() or abos_chat_is_owner(auth.uid()));

drop policy if exists "owner can toggle ai_mode" on abos_chat_conversations;
create policy "owner can toggle ai_mode" on abos_chat_conversations
  for update using (abos_chat_is_owner(auth.uid()));

drop policy if exists "read conversation messages" on abos_chat_messages;
create policy "read conversation messages" on abos_chat_messages
  for select using (
    exists (
      select 1 from abos_chat_conversations c
      where c.id = conversation_id
        and (c.customer_id = auth.uid() or abos_chat_is_owner(auth.uid()))
    )
  );

drop policy if exists "send conversation messages" on abos_chat_messages;
create policy "send conversation messages" on abos_chat_messages
  for insert with check (
    sender_id = auth.uid()
    and exists (
      select 1 from abos_chat_conversations c
      where c.id = conversation_id
        and (c.customer_id = auth.uid() or abos_chat_is_owner(auth.uid()))
    )
  );

-- ------------------------------------------------------------
-- 4. Missing policy: a customer could never update their own
--    conversation row. sendMessage() in chatApi.ts bumps
--    last_message_at after every send — for a customer sender, that
--    update was silently rejected by RLS (only the owner-toggle policy
--    existed), so the owner inbox never reordered by new customer
--    activity.
-- ------------------------------------------------------------
drop policy if exists "customer can update own conversation" on abos_chat_conversations;
create policy "customer can update own conversation" on abos_chat_conversations
  for update using (customer_id = auth.uid())
  with check (customer_id = auth.uid());

-- ------------------------------------------------------------
-- 5. Storage RLS: schema.sql creates the abos-chat-media bucket but
--    never adds storage.objects policies. With RLS on and zero
--    policies, every image/voice-note upload is silently blocked.
--    Only an INSERT policy is needed — it's a PUBLIC bucket, so reads
--    (getPublicUrl) are served directly without going through RLS at
--    all; a SELECT policy would only be needed for .list()/.download(),
--    which this app never calls.
-- ------------------------------------------------------------
drop policy if exists "chat media upload" on storage.objects;
create policy "chat media upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'abos-chat-media');

-- ------------------------------------------------------------
-- 6. Lock down the signup trigger function so it isn't listed as a
--    callable public RPC endpoint, and pin search_path on both chat
--    functions to prevent search_path hijacking.
-- ------------------------------------------------------------
alter function public.abos_chat_next_customer_number() set search_path = public;
alter function public.abos_chat_handle_new_user() set search_path = public;
revoke execute on function public.abos_chat_handle_new_user() from public;

-- ------------------------------------------------------------
-- 7. Read-receipt columns (WhatsApp-style double tick), used by
--    ChatWindow.tsx / chatApi.ts but never added by any repo SQL file.
-- ------------------------------------------------------------
alter table abos_chat_conversations
  add column if not exists customer_last_read_at timestamptz;
alter table abos_chat_conversations
  add column if not exists owner_last_read_at timestamptz;

-- ------------------------------------------------------------
-- 8. Privilege-escalation fix (found + applied in this session): a
--    logged-in customer could self-promote to 'owner' via a direct
--    client-side .update({ role: 'owner' }) call, since the "update
--    own profile" policy had no WITH CHECK and no column restriction.
--    RLS filters rows, not columns, so the real fix is a column-level
--    grant: customers may only ever update their own `name`.
-- ------------------------------------------------------------
revoke update on table abos_chat_profiles from authenticated;
grant update (name) on table abos_chat_profiles to authenticated;

-- ============================================================
--  NOT included here on purpose:
--  "abos_chat_link_existing_admin_user" — a one-off migration that
--  hardcodes a specific person's auth user id + email to grant them
--  the owner role. That's environment-specific data, not reusable
--  schema — it's already applied on your live project. If you ever
--  need to make a NEW person an owner, just use the manual SQL step
--  in the README:
--    update abos_chat_profiles set role = 'owner' where email = '...';
-- ============================================================
