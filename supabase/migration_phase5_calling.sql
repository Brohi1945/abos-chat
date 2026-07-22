-- ============================================================
--  ABOS Chat — Phase 5: Voice/Video calling
--  Signaling (offer/answer/ICE) happens over Supabase Realtime
--  Broadcast, NOT through this table — this table only tracks call
--  state (ringing/active/ended) so all parties can see it update live
--  via postgres_changes, and so a call-log message can be inserted
--  once it's over.
-- ============================================================

create table if not exists abos_chat_calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references abos_chat_conversations(id) on delete cascade,
  caller_id uuid not null references abos_chat_profiles(id) on delete cascade,
  -- normalized like sender_role on messages: 'customer' or 'owner'
  -- (an agent's call still reads as 'owner' from the customer's side)
  caller_role text not null check (caller_role in ('customer', 'owner')),
  answered_by uuid references abos_chat_profiles(id) on delete set null,
  kind text not null check (kind in ('voice', 'video')),
  status text not null default 'ringing'
    check (status in ('ringing', 'active', 'ended', 'missed', 'declined')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds int
);

create index if not exists abos_chat_calls_conversation_idx
  on abos_chat_calls (conversation_id, created_at);

alter table abos_chat_calls enable row level security;

drop policy if exists "read calls" on abos_chat_calls;
create policy "read calls" on abos_chat_calls
  for select using (
    exists (
      select 1 from abos_chat_conversations c
      where c.id = conversation_id
        and (c.customer_id = auth.uid() or abos_chat_is_owner(auth.uid()))
    )
  );

drop policy if exists "create calls" on abos_chat_calls;
create policy "create calls" on abos_chat_calls
  for insert with check (
    caller_id = auth.uid()
    and exists (
      select 1 from abos_chat_conversations c
      where c.id = conversation_id
        and (c.customer_id = auth.uid() or abos_chat_is_owner(auth.uid()))
    )
  );

-- update covers: claiming ("accept"), ending, declining, marking missed —
-- all done by either participant, so one shared policy is enough.
drop policy if exists "update calls" on abos_chat_calls;
create policy "update calls" on abos_chat_calls
  for update using (
    exists (
      select 1 from abos_chat_conversations c
      where c.id = conversation_id
        and (c.customer_id = auth.uid() or abos_chat_is_owner(auth.uid()))
    )
  );

-- Realtime: this table needs postgres_changes events (INSERT for
-- "incoming call" ringing, UPDATE for accept/decline/hangup) — has to
-- be explicitly added to the realtime publication, new tables aren't
-- included automatically.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'abos_chat_calls'
  ) then
    alter publication supabase_realtime add table abos_chat_calls;
  end if;
end $$;

-- A message can now be a call-log entry ("Voice call · 2:15",
-- "Missed video call"), inserted once a call ends — same snapshot
-- pattern as everything else on this table.
alter table abos_chat_messages
  drop constraint if exists abos_chat_messages_kind_check;
alter table abos_chat_messages
  add constraint abos_chat_messages_kind_check
  check (kind in ('text', 'image', 'location', 'voice', 'product', 'call'));

alter table abos_chat_messages
  add column if not exists call_id uuid references abos_chat_calls(id) on delete set null;
