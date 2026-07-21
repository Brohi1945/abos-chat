-- ============================================================
--  ABOS Chat — Phase 2 + 3 foundation
--  Run AFTER schema.sql + migration_ai_replies.sql +
--  migration_sync_with_live_db.sql + migration_ai_reply_webhook.sql +
--  migration_sync_phase1.sql
-- ============================================================

-- Phase 2: unread badge counts for the owner inbox, computed in one
-- server-side query instead of the client loading every conversation's
-- full message history just to count unread ones.
create or replace function abos_chat_owner_inbox()
returns table (
  id uuid,
  customer_id uuid,
  ai_mode boolean,
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
    c.id, c.customer_id, c.ai_mode, c.last_message_at,
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

-- Phase 3: rich message cards. A message can now optionally carry a
-- product snapshot (name/price/stock at the moment it was sent — not
-- a live reference, so the card stays accurate even if price/stock
-- changes later).
alter table abos_chat_messages
  add column if not exists product_snapshot jsonb;

alter table abos_chat_messages
  drop constraint if exists abos_chat_messages_kind_check;
alter table abos_chat_messages
  add constraint abos_chat_messages_kind_check
  check (kind in ('text','image','location','voice','product'));
