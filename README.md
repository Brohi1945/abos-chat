   # ABOS Chat

Standalone messaging app for ABOS customers — separate repo, **same Supabase project and same Vercel account** as ABOS.

Phase 1 of the plan: customer accounts with a unique ABOS number, plus a working text/image/location/voice-note chat between a customer and the store. Voice/video calling is a later phase (see bottom).

## What's built

- **Signup/Login** (Supabase Auth, email + password)
- **Unique customer number** — auto-generated on signup, format `ABOS-000001`, `ABOS-000002`, ... (via a Postgres sequence + trigger, see `supabase/schema.sql`)
- **One conversation per customer** with "the store" (like a WhatsApp Business chat)
- **Text messages**, real-time (Supabase Realtime — no refresh needed)
- **Image sharing** (uploads to Supabase Storage)
- **Location sharing** (browser geolocation → shown as an embedded map, no Google API key needed)
- **Voice notes** (record in-browser, uploads to Supabase Storage, playable inline)
- **Owner inbox** — a store-side view that lists every customer conversation and lets the owner reply. Anyone whose email is in `VITE_OWNER_EMAILS` (or whose `abos_chat_profiles.role = 'owner'` in the DB) sees this instead of the single-conversation customer view.
- **AI auto-reply (Groq)** — per-conversation toggle in the owner inbox. When ON, a customer's text message triggers a server-side call to Groq (same model ABOS's assistant uses) which generates and inserts a reply automatically. When OFF, only the human owner replies. The owner can flip this per-customer at any time — full manual control stays available even with AI on elsewhere.

## Setup

### 1. Run the SQL schema

Open your ABOS Supabase project → **SQL Editor** → paste the contents of `supabase/schema.sql` → **Run**.

This creates new tables (`abos_chat_profiles`, `abos_chat_conversations`, `abos_chat_messages`), a storage bucket (`abos-chat-media`), and Row Level Security policies. **It does not touch any existing ABOS tables** (`products`, `orders`, `customers`, etc.) — everything is prefixed `abos_chat_*` to stay out of the way.

Then run `supabase/migration_ai_replies.sql` (same SQL Editor) — adds the `ai_mode` toggle, the `is_ai` message flag, and a system "ABOS Assistant" profile that AI replies get attributed to.

### 2. Environment variables

```
cp .env.example .env
```

Fill in the **same** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` that ABOS uses (Vercel → ABOS project → Settings → Environment Variables).

Set `VITE_OWNER_EMAILS` to the email(s) that should see the owner inbox (comma-separated if more than one).

For AI auto-reply, also set:
- `GROQ_API_KEY` — same key ABOS uses for its assistant
- `SUPABASE_SERVICE_ROLE_KEY` — from Supabase → Settings → API → **service_role** key (not the anon key). This is server-only — it's read by `/api/groq-reply.js`, never shipped to the browser. Keep it secret.

### 3. Install & run

```
npm install
npm run dev
```

### 4. Make yourself the owner

Sign up once through the app with the email you put in `VITE_OWNER_EMAILS`, then in Supabase SQL Editor:

```sql
update abos_chat_profiles set role = 'owner' where email = 'owner@example.com';
```

Log out and back in — you'll now see the Inbox view instead of a single chat.

## Deploy

Push this repo to GitHub, then in Vercel: **New Project → import this repo** (same Vercel account as ABOS, but a **separate project** — it gets its own URL, e.g. `abos-chat.vercel.app`, or attach a subdomain like `chat.yourdomain.com`). Vercel auto-detects the `api/` folder as serverless functions, same as ABOS — no extra config needed.

Add all five env vars in Vercel's project settings: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_OWNER_EMAILS`, `GROQ_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

## Connecting to ABOS

Simplest integration: add a "Chat with us" link/button somewhere in ABOS (e.g. the Store screen) pointing at your deployed `abos-chat` URL. Customers sign up once here (separate login from ABOS admin) and get their unique number.

A tighter integration (e.g. single sign-on so customers don't need a second password, or auto-creating a conversation from an ABOS order) is possible later but is a separate, bigger piece of work — flag it when you're ready and we'll scope it.

## Folder structure

```
abos-chat/
├── api/
│   ├── groq-reply.js             # POST — generates + inserts an AI reply if ai_mode is on
│   └── _lib/
│       ├── supabaseServer.js     # Service-role Supabase client (server-only)
│       └── groqClient.js         # Groq caller with retry/backoff (same pattern as ABOS)
├── supabase/
│   ├── schema.sql                # Run first
│   └── migration_ai_replies.sql  # Run second — AI toggle + bot profile
├── src/
│   ├── lib/
│   │   ├── supabaseClient.ts    # Supabase client + owner email list
│   │   ├── types.ts             # Profile / Conversation / ChatMessage types
│   │   └── chatApi.ts           # All auth + conversation + message + storage calls
│   ├── components/
│   │   ├── MessageBubble.tsx    # Renders text/image/location/voice messages
│   │   └── ChatWindow.tsx       # Message list + composer (text/image/location/voice)
│   ├── screens/
│   │   ├── AuthScreen.tsx       # Signup / login
│   │   ├── CustomerChatScreen.tsx  # Customer's single chat with the store
│   │   └── OwnerInboxScreen.tsx    # Store side: list of all conversations
│   └── App.tsx                  # Auth gate, routes to customer or owner screen
```

## Known limitations (honest list)

- **One conversation per customer** — there's no multi-topic/multi-thread chat yet, just one ongoing thread with "the store." Fine for a v1.
- **Owner inbox refreshes every 15s** (simple polling), not fully real-time for the *conversation list* — individual open chats *are* real-time via Supabase Realtime. Can be upgraded to a realtime subscription on the conversations table later.
- **No read receipts / typing indicators** — not built yet.
- **No push notifications** — if the browser tab is closed, the customer won't be notified of a new reply. Would need a service worker + push subscription, or piggyback on ABOS's existing WhatsApp/email notification system.
- **Voice/video calling is NOT included** — this is text/image/location/voice-note chat only. Calling needs a separate integration (Twilio, Daily.co, Agora, or hosted Jitsi via 8x8.vc) — next phase.
- **AI auto-reply is per-conversation only, no global default** — has to be turned on per customer from the inbox; there's no "turn on for all new conversations" setting yet.
- **AI trigger is client-initiated** — after a customer sends a text message, *their own browser* calls `/api/groq-reply`. If they close the tab instantly after sending, the auto-reply won't fire. A more robust version would use a Supabase Database Webhook/Edge Function triggered server-side on insert — flag it if this matters for your use case.
- **AI only reacts to text messages**, not images/location/voice notes (the model has no way to "see" those yet).
- **No admin auth hardening beyond RLS** — the owner role is a simple flag on the profile row, protected by Supabase RLS policies. Fine for a single-store MVP; would want tighter checks before handling many staff accounts.
