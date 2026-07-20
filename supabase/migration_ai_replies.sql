-- ============================================================
--  ABOS Chat — AI auto-reply migration
--  Run AFTER schema.sql, in the same Supabase project.
-- ============================================================

-- Per-conversation toggle: when true, customer messages trigger an
-- automatic Groq-generated reply (via /api/groq-reply). Owner can
-- flip this per-conversation from the Inbox screen at any time.
alter table abos_chat_conversations
  add column if not exists ai_mode boolean not null default false;

-- Marks a message as AI-generated (vs a human owner reply) so the UI
-- can show a small "AI" badge.
alter table abos_chat_messages
  add column if not exists is_ai boolean not null default false;

-- Owners are allowed to flip ai_mode on their conversations.
create policy if not exists "owner can toggle ai_mode" on abos_chat_conversations
  for update using (
    exists (select 1 from abos_chat_profiles p where p.id = auth.uid() and p.role = 'owner')
  );

-- ------------------------------------------------------------
--  Bot profile — a system "owner" identity that AI replies are
--  attributed to (needed because abos_chat_messages.sender_id has a
--  foreign key to abos_chat_profiles). This row has no matching
--  auth.users row and can never log in — it's message-attribution
--  only, inserted by the server-side /api/groq-reply function using
--  the service-role key (RLS doesn't block service-role writes).
-- ------------------------------------------------------------
insert into abos_chat_profiles (id, customer_number, name, email, role)
values (
  '00000000-0000-0000-0000-000000000001',
  'ABOS-BOT',
  'ABOS Assistant',
  null,
  'owner'
)
on conflict (id) do nothing;

-- Note: abos_chat_profiles.id normally references auth.users(id) with
-- a foreign key. If your Supabase setup enforces that FK strictly and
-- this insert fails, run this first to relax it for the bot row only:
--
--   alter table abos_chat_profiles drop constraint if exists abos_chat_profiles_id_fkey;
--   alter table abos_chat_profiles add constraint abos_chat_profiles_id_fkey
--     foreign key (id) references auth.users(id) on delete cascade
--     not valid; -- allows the existing bot row through without
--                -- re-validating every row, new rows still checked.
