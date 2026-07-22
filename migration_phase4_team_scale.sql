-- ============================================================
--  ABOS Chat — Phase 4: Team & Scale
--  Run AFTER schema.sql + migration_ai_replies.sql +
--  migration_sync_with_live_db.sql + migration_sync_phase1.sql +
--  migration_ai_reply_webhook.sql + "1 supabase"/migration_phase2_3_foundation.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. Agent role — a store can now have multiple staff logins, not
--    just one "owner". Agents get the same inbox access as owner
--    (fine-grained per-agent permission is a later phase).
-- ------------------------------------------------------------
alter table abos_chat_profiles drop constraint if exists abos_chat_profiles_role_check;
alter table abos_chat_profiles add constraint abos_chat_profiles_role_check
  check (role in ('customer', 'owner', 'agent'));

-- abos_chat_is_owner() is used by every RLS policy in this app —
-- redefining it to also treat 'agent' as staff instantly gives agents
-- the same data access as owner everywhere, with zero other changes.
create or replace function abos_chat_is_owner(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists(select 1 from abos_chat_profiles where id = uid and role in ('owner', 'agent'));
$$;

-- Message-level snapshot of who actually sent it (name + title), the
-- same "snapshot not live reference" pattern already used for
-- product_snapshot — survives renames/deletes, and needs no extra
-- join or RLS opening on abos_chat_profiles for customers to read.
alter table abos_chat_messages
  add column if not exists sender_name text,
  add column if not exists sender_title text check (sender_title in ('Owner', 'Agent'));

-- ------------------------------------------------------------
-- 2. Conversation status + tags
-- ------------------------------------------------------------
alter table abos_chat_conversations
  add column if not exists status text not null default 'open'
    check (status in ('open', 'pending', 'resolved', 'urgent'));
alter table abos_chat_conversations
  add column if not exists tags text[] not null default '{}';

create index if not exists abos_chat_conversations_status_idx
  on abos_chat_conversations (status);

-- ------------------------------------------------------------
-- 3. Owner inbox RPC — recreated with status/tags (return type
--    changed, so it must be dropped first).
-- ------------------------------------------------------------
drop function if exists abos_chat_owner_inbox();
create function abos_chat_owner_inbox()
returns table (
  id uuid,
  customer_id uuid,
  ai_mode boolean,
  status text,
  tags text[],
  last_message_at timestamptz,
  customer_last_read_at timestamptz,
  owner_last_read_at timestamptz,
  customer_number text,
  customer_name text,
  customer_email text,
  unread_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    c.id, c.customer_id, c.ai_mode, c.status, c.tags, c.last_message_at,
    c.customer_last_read_at, c.owner_last_read_at,
    p.customer_number, p.name, p.email,
    (
      select count(*) from abos_chat_messages m
      where m.conversation_id = c.id
        and m.sender_role = 'customer'
        and (c.owner_last_read_at is null or m.created_at > c.owner_last_read_at)
    ) as unread_count
  from abos_chat_conversations c
  join abos_chat_profiles p on p.id = c.customer_id
  where abos_chat_is_owner(auth.uid())
  order by c.last_message_at desc nulls last;
$$;

revoke execute on function abos_chat_owner_inbox() from public;
grant execute on function abos_chat_owner_inbox() to authenticated;

-- ------------------------------------------------------------
-- 4. Owner-side search — customer name/number/email/tags AND message
--    body content, in one RPC so the UI doesn't need two code paths.
-- ------------------------------------------------------------
create or replace function abos_chat_search_conversations(term text)
returns table (
  id uuid,
  customer_id uuid,
  ai_mode boolean,
  status text,
  tags text[],
  last_message_at timestamptz,
  customer_last_read_at timestamptz,
  owner_last_read_at timestamptz,
  customer_number text,
  customer_name text,
  customer_email text,
  unread_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    c.id, c.customer_id, c.ai_mode, c.status, c.tags, c.last_message_at,
    c.customer_last_read_at, c.owner_last_read_at,
    p.customer_number, p.name, p.email,
    (
      select count(*) from abos_chat_messages m
      where m.conversation_id = c.id
        and m.sender_role = 'customer'
        and (c.owner_last_read_at is null or m.created_at > c.owner_last_read_at)
    ) as unread_count
  from abos_chat_conversations c
  join abos_chat_profiles p on p.id = c.customer_id
  where abos_chat_is_owner(auth.uid())
    and (
      p.name ilike '%' || term || '%'
      or p.email ilike '%' || term || '%'
      or p.customer_number ilike '%' || term || '%'
      or exists (select 1 from unnest(c.tags) t where t ilike '%' || term || '%')
      or exists (
        select 1 from abos_chat_messages m
        where m.conversation_id = c.id and m.body ilike '%' || term || '%'
      )
    )
  order by c.last_message_at desc nulls last;
$$;

revoke execute on function abos_chat_search_conversations(text) from public;
grant execute on function abos_chat_search_conversations(text) to authenticated;

-- ------------------------------------------------------------
-- 5. Broadcast / campaign messages
-- ------------------------------------------------------------
create table if not exists abos_chat_broadcasts (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references abos_chat_profiles(id) on delete cascade,
  body text not null,
  target_tag text,              -- null = all customers
  recipient_count int not null default 0,
  created_at timestamptz not null default now()
);

alter table abos_chat_broadcasts enable row level security;

drop policy if exists "owner reads broadcasts" on abos_chat_broadcasts;
create policy "owner reads broadcasts" on abos_chat_broadcasts
  for select using (abos_chat_is_owner(auth.uid()));

alter table abos_chat_messages
  add column if not exists broadcast_id uuid references abos_chat_broadcasts(id) on delete set null;

-- One RPC does the whole broadcast atomically: insert the broadcast
-- record, fan the message out to every matching conversation, and
-- bump last_message_at on each — all server-side so a dropped
-- connection mid-send can't leave it half-delivered.
create or replace function abos_chat_send_broadcast(
  sender_name text,
  sender_title text,
  body text,
  target_tag text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  sender uuid := auth.uid();
  new_broadcast_id uuid;
  sent_count int;
begin
  if not abos_chat_is_owner(sender) then
    raise exception 'Only store staff can send broadcasts';
  end if;

  insert into abos_chat_broadcasts (sender_id, body, target_tag)
  values (sender, body, target_tag)
  returning id into new_broadcast_id;

  insert into abos_chat_messages (
    conversation_id, sender_id, sender_role, kind, body,
    sender_name, sender_title, broadcast_id
  )
  select c.id, sender, 'owner', 'text', body, sender_name, sender_title, new_broadcast_id
  from abos_chat_conversations c
  where target_tag is null or target_tag = any(c.tags);

  get diagnostics sent_count = row_count;

  update abos_chat_broadcasts set recipient_count = sent_count where id = new_broadcast_id;

  update abos_chat_conversations set last_message_at = now()
  where target_tag is null or target_tag = any(tags);

  return new_broadcast_id;
end;
$$;

revoke execute on function abos_chat_send_broadcast(text, text, text, text) from public;
grant execute on function abos_chat_send_broadcast(text, text, text, text) to authenticated;

-- ============================================================
--  To make someone a staff agent (after they sign up once):
--  update abos_chat_profiles set role = 'agent' where email = 'staff@example.com';
-- ============================================================
