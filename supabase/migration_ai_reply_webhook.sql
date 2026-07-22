-- ============================================================
--  ABOS Chat — AI reply moves from client-triggered to server-triggered
--  Run AFTER schema.sql + migration_ai_replies.sql + migration_sync_with_live_db.sql
-- ============================================================
--
-- Previously the customer's own browser called POST /api/groq-reply
-- right after sending a text message. That endpoint had to accept a
-- real user session token and verify the caller server-side — it
-- worked, but the endpoint was reachable by any authenticated user.
--
-- This migration moves the trigger into Postgres itself: whenever a
-- customer text message is inserted on a conversation with
-- ai_mode = true, a trigger calls /api/groq-reply directly via
-- pg_net — no browser involvement, and the endpoint no longer needs
-- to trust user sessions at all, only a shared secret.
--
-- ⚠️  DO NOT commit real secret values to git. The two vault.create_secret
-- calls below use placeholders — replace them and run manually in the
-- SQL Editor (or keep them out of version control entirely and only
-- ever run this section by hand). Everything else in this file is
-- safe to commit as-is.
--
-- 2026-07-22 update: two fixes based on production testing —
--  1. timeout_milliseconds was left at pg_net's default of 5000ms.
--     Groq's tool-calling loop can legitimately take longer than 5s,
--     so pg_net was marking the call "timed out" even though the
--     Vercel function kept running and inserted the reply late. Raised
--     to 25000ms (still well under /api/groq-reply's maxDuration).
--  2. Now passes the new message's id in the webhook body, so the
--     handler can debounce (see api/groq-reply.js) instead of using a
--     blanket "skip if we replied in the last 20s" rule that silently
--     dropped fast follow-up messages forever.

create extension if not exists pg_net with schema extensions;

-- Run these two with your own values (not committed to git):
--
-- select vault.create_secret(
--   'https://YOUR-DEPLOYED-URL.vercel.app/api/groq-reply',
--   'abos_chat_ai_webhook_url',
--   'Endpoint the DB trigger calls when a customer sends a text message and ai_mode is on'
-- );
--
-- select vault.create_secret(
--   'GENERATE-A-LONG-RANDOM-STRING-HERE',
--   'abos_chat_ai_webhook_secret',
--   'Shared secret sent as a header to /api/groq-reply. Must match AI_REPLY_WEBHOOK_SECRET in Vercel env vars.'
-- );

create or replace function abos_chat_trigger_ai_reply()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  webhook_url text;
  webhook_secret text;
  ai_on boolean;
begin
  -- Only fire for customer text messages that aren't already AI-generated.
  if new.kind <> 'text' or new.sender_role <> 'customer' or new.is_ai then
    return new;
  end if;

  select ai_mode into ai_on from abos_chat_conversations where id = new.conversation_id;
  if not coalesce(ai_on, false) then
    return new;
  end if;

  select decrypted_secret into webhook_url from vault.decrypted_secrets where name = 'abos_chat_ai_webhook_url';
  select decrypted_secret into webhook_secret from vault.decrypted_secrets where name = 'abos_chat_ai_webhook_secret';

  if webhook_url is null or webhook_secret is null then
    return new; -- not configured yet, no-op rather than error the insert
  end if;

  -- pg_net queues this async — does not block or slow down the message insert.
  perform net.http_post(
    url := webhook_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-abos-chat-webhook-secret', webhook_secret
    ),
    body := jsonb_build_object(
      'conversationId', new.conversation_id,
      'messageId', new.id,
      'messageCreatedAt', new.created_at
    ),
    timeout_milliseconds := 25000
  );

  return new;
end;
$$;

-- Same defense-in-depth pattern as the signup trigger: not directly
-- callable as a public RPC (it also only works in a trigger context).
revoke execute on function abos_chat_trigger_ai_reply() from public;

drop trigger if exists abos_chat_ai_reply_trigger on abos_chat_messages;
create trigger abos_chat_ai_reply_trigger
  after insert on abos_chat_messages
  for each row execute function abos_chat_trigger_ai_reply();
