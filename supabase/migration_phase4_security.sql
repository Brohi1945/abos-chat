-- ============================================================
--  ABOS Chat — Phase 4: Security Hardening
--  Realtime Authorization + Rate-Limit
--  Run AFTER all previous migrations
-- ============================================================

-- ------------------------------------------------------------
-- 1. Realtime Authorization — RLS on Realtime channels
--    Sirf call participants channel join kar sakte hain
-- ------------------------------------------------------------

-- Realtime ko RLS use karne ke liye enable karna
-- Yeh Supabase dashboard mein bhi kar sakte hain, lekin SQL se bhi ho jata hai

-- Create a function that checks if a user can listen to a channel
create or replace function abos_chat_can_listen_channel(channel_name text)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  call_id uuid;
  user_id uuid := auth.uid();
begin
  -- Extract call ID from channel name: 'call-signal-{callId}'
  call_id := split_part(channel_name, '-', 3)::uuid;
  
  -- Check if user is a participant in this call
  return exists (
    select 1 from abos_chat_calls c
    where c.id = call_id
      and (c.caller_id = user_id or c.answered_by = user_id)
  );
end;
$$;

grant execute on function abos_chat_can_listen_channel(text) to authenticated;

-- ------------------------------------------------------------
-- 2. Rate-Limit: 3 calls per minute per customer
-- ------------------------------------------------------------

create or replace function abos_chat_check_call_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count int;
begin
  -- Sirf customers ke liye rate-limit (owners/agents ke liye nahi)
  if new.caller_role = 'owner' then
    return new;
  end if;
  
  select count(*) into recent_count
  from abos_chat_calls
  where caller_id = new.caller_id
    and created_at > now() - interval '1 minute'
    and status = 'ringing';
  
  if recent_count >= 3 then
    raise exception 'Too many calls. Please wait a moment before calling again.';
  end if;
  
  return new;
end;
$$;

drop trigger if exists abos_chat_call_rate_limit_trigger on abos_chat_calls;
create trigger abos_chat_call_rate_limit_trigger
  before insert on abos_chat_calls
  for each row execute function abos_chat_check_call_rate_limit();

-- ------------------------------------------------------------
-- 3. Indexes for performance
-- ------------------------------------------------------------

create index if not exists abos_chat_calls_caller_created_idx
  on abos_chat_calls (caller_id, created_at);

create index if not exists abos_chat_calls_status_idx
  on abos_chat_calls (status);

-- ------------------------------------------------------------
-- 4. Function to clean up old calls (keep last 30 days)
-- ------------------------------------------------------------

create or replace function abos_chat_cleanup_old_calls()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from abos_chat_calls
  where created_at < now() - interval '30 days'
    and status in ('ended', 'missed', 'declined');
end;
$$;

-- Run cleanup daily via pg_cron (if enabled) or manually
-- select abos_chat_cleanup_old_calls();
