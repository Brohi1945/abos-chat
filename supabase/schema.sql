-- ============================================================
--  ABOS Chat — Supabase schema
--  Run this in the SAME Supabase project as ABOS
--  (Supabase Dashboard → SQL Editor → paste → Run)
-- ============================================================

-- 1. Sequence that generates the unique customer number, e.g. ABOS-000001
create sequence if not exists abos_chat_customer_seq start 1;

create or replace function abos_chat_next_customer_number()
returns text
language plpgsql
as $$
declare
  n int;
begin
  n := nextval('abos_chat_customer_seq');
  return 'ABOS-' || lpad(n::text, 6, '0');
end;
$$;

-- 2. profiles — one row per authenticated user (links to Supabase Auth).
--    role = 'customer' (default) or 'owner' (store side, sees everything).
create table if not exists abos_chat_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  customer_number text unique not null default abos_chat_next_customer_number(),
  name text,
  email text,
  role text not null default 'customer' check (role in ('customer', 'owner')),
  created_at timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function abos_chat_handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into abos_chat_profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', ''), new.email);
  return new;
end;
$$;

drop trigger if exists abos_chat_on_auth_user_created on auth.users;
create trigger abos_chat_on_auth_user_created
  after insert on auth.users
  for each row execute procedure abos_chat_handle_new_user();

-- 3. conversations — one thread per customer (talking to "the store").
create table if not exists abos_chat_conversations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references abos_chat_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create unique index if not exists abos_chat_one_conversation_per_customer
  on abos_chat_conversations (customer_id);

-- 4. messages
create table if not exists abos_chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references abos_chat_conversations(id) on delete cascade,
  sender_id uuid not null references abos_chat_profiles(id) on delete cascade,
  sender_role text not null check (sender_role in ('customer', 'owner')),
  kind text not null default 'text' check (kind in ('text', 'image', 'location', 'voice')),
  body text,               -- text content, or caption for image/voice
  media_url text,          -- Storage URL for image/voice
  lat double precision,    -- for kind = 'location'
  lng double precision,
  created_at timestamptz not null default now()
);
create index if not exists abos_chat_messages_conversation_idx
  on abos_chat_messages (conversation_id, created_at);

-- 5. Storage bucket for images/voice notes (create via Dashboard if this fails)
insert into storage.buckets (id, name, public)
values ('abos-chat-media', 'abos-chat-media', true)
on conflict (id) do nothing;

-- ============================================================
--  Row Level Security
-- ============================================================
alter table abos_chat_profiles enable row level security;
alter table abos_chat_conversations enable row level security;
alter table abos_chat_messages enable row level security;

-- Profiles: a user can read their own profile; owners can read all.
create policy "read own profile" on abos_chat_profiles
  for select using (
    auth.uid() = id
    or exists (select 1 from abos_chat_profiles p where p.id = auth.uid() and p.role = 'owner')
  );

create policy "update own profile" on abos_chat_profiles
  for update using (auth.uid() = id);

-- Conversations: customer sees their own; owner sees all.
create policy "read own conversation" on abos_chat_conversations
  for select using (
    customer_id = auth.uid()
    or exists (select 1 from abos_chat_profiles p where p.id = auth.uid() and p.role = 'owner')
  );

create policy "create own conversation" on abos_chat_conversations
  for insert with check (customer_id = auth.uid());

-- Messages: only participants (the customer who owns the conversation,
-- or any owner) can read/send.
create policy "read conversation messages" on abos_chat_messages
  for select using (
    exists (
      select 1 from abos_chat_conversations c
      where c.id = conversation_id
        and (c.customer_id = auth.uid()
             or exists (select 1 from abos_chat_profiles p where p.id = auth.uid() and p.role = 'owner'))
    )
  );

create policy "send conversation messages" on abos_chat_messages
  for insert with check (
    sender_id = auth.uid()
    and exists (
      select 1 from abos_chat_conversations c
      where c.id = conversation_id
        and (c.customer_id = auth.uid()
             or exists (select 1 from abos_chat_profiles p where p.id = auth.uid() and p.role = 'owner'))
    )
  );

-- ============================================================
--  To make someone a store owner (after they sign up once):
--  update abos_chat_profiles set role = 'owner' where email = 'owner@example.com';
-- ============================================================
