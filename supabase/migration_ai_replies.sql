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
-- (Postgres has no "CREATE POLICY IF NOT EXISTS" — that syntax
-- doesn't exist and throws a syntax error, which aborts this whole
-- script before the columns above even get committed. drop-then-create
-- is the correct idempotent pattern.)
drop policy if exists "owner can toggle ai_mode" on abos_chat_conversations;
create policy "owner can toggle ai_mode" on abos_chat_conversations
  for update using (
    exists (select 1 from abos_chat_profiles p where p.id = auth.uid() and p.role = 'owner')
  );

-- ------------------------------------------------------------
--  Bot profile — a system "owner" identity that AI replies are
--  attributed to (needed because abos_chat_messages.sender_id has a
--  foreign key to abos_chat_profiles). This row has no matching
--  auth.users row and can never log in — it's message-attribution
--  only, inserted here (and re-insertable safely later by
--  /api/groq-reply if it's ever missing, using the service-role key).
--
--  abos_chat_profiles.id normally has a foreign key to auth.users(id).
--  The bot's id will never exist in auth.users, so that FK has to be
--  dropped entirely for this table — NOT just marked NOT VALID, since
--  NOT VALID still enforces the check on new inserts (it only skips
--  re-validating rows that already existed before the constraint was
--  added). Dropping it is safe: abos_chat_profiles.id is still the
--  primary key, and the signup trigger only ever inserts real
--  auth.users ids anyway.
-- ------------------------------------------------------------
alter table abos_chat_profiles drop constraint if exists abos_chat_profiles_id_fkey;

insert into abos_chat_profiles (id, customer_number, name, email, role)
values (
  '00000000-0000-0000-0000-000000000001',
  'ABOS-BOT',
  'ABOS Assistant',
  null,
  'owner'
)
on conflict (id) do nothing;
