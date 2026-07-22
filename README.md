# ABOS Chat

Standalone messaging app for ABOS customers — separate repo, **same Supabase project and same Vercel account** as ABOS.

## What's built

**Phase 1 — Core chat**
- **Signup/Login** (Supabase Auth, email + password)
- **Unique customer number** — auto-generated on signup, format `ABOS-000001`, `ABOS-000002`, ...
- **One conversation per customer** with "the store" (like a WhatsApp Business chat)
- **Text messages**, real-time (Supabase Realtime — no refresh needed)
- **Image sharing** (Supabase Storage)
- **Location sharing** (browser geolocation → embedded map, no Google API key needed)
- **Voice notes** (record in-browser, playable inline)
- **Owner inbox** — store-side view listing every conversation
- **AI auto-reply (Groq)** — per-conversation toggle; server-triggered via a Postgres trigger + `pg_net` webhook (not client-initiated) whenever a customer sends a text message. Acts as a full sales + support agent with real tool-calling (`add_to_order`, `remove_from_order`, `view_order`, `confirm_order`, `escalate_to_human`) — it can actually place a real order in `orders`, not just talk about one. Debounces fast follow-up messages (waits ~2.5s, backs off if a newer customer message has arrived) so a burst of quick messages gets one coherent reply instead of a dropped or duplicated one.

**Phase 2 — Read receipts, typing, unread counts**
- **Read receipts** (WhatsApp-style double tick) via `customer_last_read_at` / `owner_last_read_at`
- **Typing indicator** — ephemeral, via Supabase Presence (no DB table)
- **Unread badge counts**, computed server-side by `abos_chat_owner_inbox()`

**Phase 3 — Rich messages & order context**
- **Product cards** — owner can send a product as a rich message (name/price/stock snapshotted at send time, stays accurate even if the product changes later)
- **Linked ABOS orders** — owner inbox shows a customer's recent orders (best-effort match by email), via `/api/customer-orders`

**Phase 4 — Team & scale**
- **Multiple staff/agent identity per reply** — a new `agent` role alongside `owner`. Every store-side message is snapshotted with `sender_name` + `sender_title` ("Owner"/"Agent"), shown as a small badge above the bubble so both the customer and other staff can see who actually replied.
- **Conversation status** — `open` / `pending` / `urgent` / `resolved`, settable from a dropdown in the chat header, filterable via tabs in the inbox sidebar.
- **Conversation tags** — free-form comma-separated tags per conversation, shown as chips in the inbox list and used to target broadcasts.
- **Broadcast/campaign messages** — a megaphone button in the inbox opens a composer to send one message to *all* customers or everyone with a specific tag, sent atomically via a single Postgres function (`abos_chat_send_broadcast`).
- **Owner-side search** — searches customer name/number/email/tags **and** message content in one query (`abos_chat_search_conversations`), debounced in the sidebar search box.

**Phase 5 — Voice/video calling**
- **1:1 voice and video calls**, WebRTC peer-to-peer, signaled through Supabase Realtime Broadcast (no dedicated signaling server)
- **Shared-inbox ringing** — a customer's call rings every online owner/agent at once; whoever taps Accept first claims it (atomic DB claim), others auto-dismiss
- **Call controls** — mute, camera on/off (video calls), hang up, live call timer
- **Call log messages** — every call drops a summary bubble into the chat ("Voice call · 2:15", "Missed video call")
- **STUN-only** — no TURN server included yet (see Known limitations)

## Setup

### 1. Run the SQL migrations, in this exact order

Open your ABOS Supabase project → **SQL Editor** → paste each file's contents → **Run**, in this order:

1. `supabase/schema.sql` — base tables, storage bucket, RLS
2. `supabase/migration_ai_replies.sql` — `ai_mode` toggle, `is_ai` flag, bot profile
3. `supabase/migration_ai_reply_webhook.sql` — server-side AI trigger
4. `supabase/migration_sync_phase1.sql` — race-safe unique conversation per customer
5. `supabase/migration_sync_with_live_db.sql` — RLS recursion fix, storage upload policy, read-receipt columns, profile update lockdown (**critical** — without this, login can silently fail)
6. `1 supabase/migration_phase2_3_foundation.sql` — unread counts RPC, product snapshot column
7. `supabase/migration_phase4_team_scale.sql` — agent role, status/tags, broadcasts, search
8. `supabase/migration_phase5_calling.sql` — calls table, realtime publication, call log message kind

All files are idempotent — safe to re-run if you're not sure what's already applied.

### 2. Environment variables

```
cp .env.example .env
```

Fill in the **same** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` that ABOS uses.

Set `VITE_OWNER_EMAILS` to the email(s) that should see the owner inbox before their DB role is flipped (comma-separated if more than one) — this is a UI convenience only, actual access is enforced by RLS via `abos_chat_profiles.role`.

For AI auto-reply, also set:
- `GROQ_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — server-only, read by `/api/groq-reply.js`, never shipped to the browser

### 3. Install & run

```
npm install
npm run dev
```

### 4. Make yourself the owner, and add staff/agents

```sql
update abos_chat_profiles set role = 'owner' where email = 'owner@example.com';
update abos_chat_profiles set role = 'agent' where email = 'staff@example.com';
```

Both `owner` and `agent` see the same shared Inbox (fine-grained per-agent permissions is a later phase). Log out and back in after changing a role — the RLS helper function is re-evaluated on the next session.

## Deploy

Push this repo to GitHub, then in Vercel: **New Project → import this repo** (same Vercel account as ABOS, separate project — its own URL, e.g. `abos-chat.vercel.app`, or a subdomain like `chat.yourdomain.com`). Vercel auto-detects the `api/` folder as serverless functions, same as ABOS — no extra config needed.

Add all five env vars in Vercel's project settings: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_OWNER_EMAILS`, `GROQ_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

## Connecting to ABOS

Simplest integration: add a "Chat with us" link/button somewhere in ABOS (e.g. the Store screen) pointing at your deployed `abos-chat` URL. Customers sign up once here (separate login from ABOS admin) and get their unique number.

A tighter integration (single sign-on, auto-creating a conversation from an ABOS order) is possible later — flag it when you're ready and we'll scope it.

## Folder structure

```
abos-chat/
├── api/
│   ├── groq-reply.js                 # POST — generates + inserts an AI reply if ai_mode is on
│   ├── api/customer-orders.js        # GET — owner-only, best-effort orders for a conversation's customer
│   └── _lib/
│       ├── supabaseServer.js         # Service-role Supabase client (server-only)
│       ├── groqClient.js             # Groq caller with retry/backoff
│       ├── verifyCaller.js           # Verifies the calling user's access token
│       └── verifyOwner.js            # Verifies the caller is owner/agent
├── supabase/
│   ├── schema.sql                    # 1. Run first
│   ├── migration_ai_replies.sql      # 2.
│   ├── migration_ai_reply_webhook.sql# 3.
│   ├── migration_sync_phase1.sql     # 4.
│   ├── migration_sync_with_live_db.sql # 5. Critical fixes
│   ├── migration_phase4_team_scale.sql # 7. Agent role, status/tags, broadcasts, search
│   └── migration_phase5_calling.sql    # 8. Voice/video calls table + realtime publication
├── 1 supabase/
│   └── migration_phase2_3_foundation.sql # 6. Unread counts, product snapshots
├── src/
│   ├── lib/
│   │   ├── supabaseClient.ts         # Supabase client + owner email list
│   │   ├── types.ts                  # Profile / Conversation / ChatMessage / Call types
│   │   ├── chatApi.ts                # All auth + conversation + message + storage + broadcast/search calls
│   │   ├── callApi.ts                # Call lifecycle (ring/claim/end) + WebRTC signaling relay
│   │   └── webrtc.ts                 # RTCPeerConnection + getUserMedia helpers
│   ├── components/
│   │   ├── MessageBubble.tsx         # Renders text/image/location/voice/product/call + sender badge
│   │   ├── ChatWindow.tsx            # Message list + composer + status dropdown + call buttons
│   │   ├── ProductPicker.tsx         # Owner's "send product" search picker
│   │   ├── OrderContextPanel.tsx     # Linked ABOS orders panel
│   │   ├── BroadcastComposer.tsx     # Broadcast/campaign message modal
│   │   ├── CallManager.tsx           # App-root call state machine (mounted once, provides useCall())
│   │   ├── CallScreen.tsx            # Full-screen active/outgoing call UI
│   │   └── IncomingCallBanner.tsx    # Ringing banner with accept/decline
│   ├── screens/
│   │   ├── AuthScreen.tsx            # Signup / login
│   │   ├── CustomerChatScreen.tsx    # Customer's single chat with the store
│   │   └── OwnerInboxScreen.tsx      # Store side: conversation list, search, status filters, broadcast
│   └── App.tsx                       # Auth gate, routes to customer or owner/agent screen
```

## Recent fixes (2026-07-22)

Found via live testing + inspecting `net._http_response` logs in Supabase and Vercel runtime logs:

- **Dropped replies fixed** — the old logic silently skipped replying to any customer message that arrived within 20s of the AI's last reply (confirmed in logs: `{"skipped":true,"reason":"rate limited"}`, message lost forever). Replaced with a debounce: the handler waits ~2.5s, then only proceeds if no newer customer message has shown up — if one has, that message's own trigger call handles everything (it always pulls the last 12 messages, so nothing is lost).
- **Late replies fixed** — `net.http_post`'s default timeout is 5000ms, shorter than a full Groq tool-calling round trip can take (confirmed in logs: `"Timeout of 5000 ms reached"`). Raised to 25000ms in `migration_ai_reply_webhook.sql`, and `/api/groq-reply.js` now explicitly sets `maxDuration: 30` plus an internal 24s wall-clock budget so the loop always leaves time to insert a reply instead of getting killed mid-flight by Vercel.
- **Language mixing / repeated text / stage directions fixed** — the model was sometimes replying in English and Roman Urdu in the same message, repeating itself, and leaking meta-text like "(waiting for user response)". The system prompt now pins one language per reply (based on the customer's latest message) and explicitly bans meta-commentary and repetition; a small sanitizer also strips any stray `**markdown**` before it's stored.
- **Hallucinated store name fixed** — the AI once signed off "thanks for shopping with ABAB" (invented, no real store name is stored anywhere). Prompt now explicitly tells it to say "the store" / "hum" generically rather than invent a name.
- **Sales persona** — the system prompt now frames the bot as a 25+ year sales veteran: leads with benefits, cross-sells one relevant real-catalog item, uses honest stock-based urgency (never fake scarcity/demand), and always proposes a next step instead of just answering and waiting. Complaints/refunds still route straight to `escalate_to_human` instead of a sales pitch.

## Known limitations (honest list)

- **One conversation per customer** — no multi-topic/multi-thread chat yet, just one ongoing thread with "the store."
- **Owner inbox refreshes every 15s** (polling) for the conversation list; individual open chats *are* real-time via Supabase Realtime.
- **No push notifications** — if the browser tab is closed, no notification of a new reply.
- **Voice/video calling has no TURN server** — STUN-only, so calls between two networks with strict/symmetric NAT (some corporate wifi, carrier-grade NAT) can fail to connect. Adding a TURN server (Twilio NTS, metered.ca, or self-hosted coturn) fixes this if it turns out to matter.
- **No call waiting** — if you're already on a call, another incoming call is silently ignored rather than queued.
- **No push notifications for calls** — like messages, the tab needs to be open to hear a ringing call.
- **No message edit/delete** — planned for a later phase.
- **No document attachments** (PDF etc.) — only images/voice currently. Planned for a later phase.
- **No chat transcript export** — planned for a later phase.
- **Agents have the same full access as owner** — no per-agent permission levels (e.g. can't restrict an agent to only certain conversations) yet.
- **No agent invite flow** — promoting someone to `agent`/`owner` is a manual SQL update after they sign up once; no in-app "invite teammate" UI yet.
- **Broadcast has no delivery/read tracking beyond `recipient_count`** — no per-recipient read status for broadcast messages specifically.
- **AI auto-reply is per-conversation only, no global default.**
- **AI reply debounce isn't a hard lock** — in the rare case two customer messages land at almost the exact same millisecond, both trigger invocations could theoretically pass the "still latest" check and both call Groq. Very unlikely in practice; a stronger fix would be a proper per-conversation lock (e.g. an `ai_reply_in_progress` column with an expiry) — noted here as a possible future hardening, not done yet.
- **AI only reacts to text messages**, not images/location/voice notes.
- **No admin auth hardening beyond RLS** — owner/agent is a flag on the profile row, protected by Postgres RLS. Fine for a small team; would want tighter checks at larger scale.

## Roadmap

**Later**
- Message edit/delete
- Document attachments (not just images/voice)
- Chat transcript export
- TURN server for reliable calling across all networks
