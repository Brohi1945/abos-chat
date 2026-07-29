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

**Phase 6 — Theming & floating admin AI assistant**
- **3 themes — Light / Dark / Colorful** — CSS-variable-driven (`src/theme/`), wired through Tailwind so no component hardcodes a color. A small `ThemeSwitcher` is on the Auth screen, the customer chat header, and the owner inbox header — **both customer and admin can set their own theme independently**, stored per-device (`localStorage`), synced across tabs.
- **Floating admin AI assistant ("ABI")** — a floating bubble on the Owner Inbox screen; tap to open a full chat panel. Text or voice (Web Speech API — mic input + spoken replies). Can, on the admin's command: send a reply in the selected conversation, toggle AI auto-reply, change status/tags, filter the inbox, jump to a different conversation by name/number, and draft a broadcast (drafts only — **never sends on its own**, the admin still taps Send by hand). Every action it takes is the same RLS-protected call the admin's own UI already uses, so it can't do anything the signed-in admin couldn't already do manually.
- **Voice/theme commands handled locally** — phrases like "dark mode laga do" or "voice band karo" are matched client-side (`voiceCommands.ts`) instead of round-tripping to the LLM, so they're instant and don't cost an API call.
- New endpoint `/api/admin-chat` — owner **or agent**-authenticated (`verifyStaff` in `verifyOwner.js`), calls Groq (reuses the existing `GROQ_API_KEY`, no new secret needed).

**Phase 8 — Quick Wins (reply, edit, delete, pin, reactions, canned responses, search)**
- **Reply / quote** — tap a message's action row to quote it in your reply; tapping the quoted preview jumps straight to the original message (loading it in if it's outside the currently-loaded page).
- **Message edit** — the sender can edit their own text messages; edited messages show an "edited" tag next to the timestamp.
- **Message delete** — the sender can soft-delete their own message (any kind); it's replaced with a "This message was deleted" placeholder for everyone, body/media cleared server-side.
- **Pinned messages** — either side (customer or staff) can pin/unpin any message in the conversation; a bar under the header shows the latest pinned message and jumps to it on tap.
- **Reactions** — 👍❤️😂😮😢🙏, one per person per message (tap again to remove, tap a different one to switch), shown as grouped pill counts under the bubble, live via Realtime.
- **"Seen at HH:MM"** — a real `read_at` timestamp (not just the delivery-status flag) is now recorded, shown under your most recent read message.
- **Canned responses / quick replies** — a shared, shop-wide list of pre-saved replies staff can manage and insert into the compose box with one tap (⚡ button next to the product picker).
- **In-chat search** — search box (🔍 in the header) searches this conversation's message bodies and jumps to any result.
- All of the above is enforced server-side: a `BEFORE UPDATE` trigger (`abos_chat_messages_guard_update`) plus column-level grants make sure a customer can never edit/delete a staff member's message even though pinning is shared, and that `delivery_status`/`sender_id`/`is_ai` etc. can never be touched from the client at all.

**Phase 9 — Owner/staff tools ✅ Complete (4/4 features)**
- **Feature 1 — Staff accounts + roles** — `agent` role, promoted/demoted from a dedicated owner-only Staff screen, with a self-lockout guard (owner can't demote/deactivate themselves into a lockout) and an `active` flag so a removed staff member loses inbox access without deleting their account. Underlying helper functions are `abos_chat_is_owner()` (now means "any active staff — owner or agent", used everywhere the old policies already called it) and a new `abos_chat_is_admin()` (strictly the real owner) — **note the naming**: this diverges from earlier planning docs, which used `abos_chat_is_staff()`/`abos_chat_is_owner()` for the same two concepts. The names above are what's actually live; always confirm against the live schema before writing new SQL, not against a doc.
- **Feature 2 — Availability / away toggle** — each owner/agent can mark themselves "Away" from a small pill in the inbox header (`abos_chat_profiles.is_away`). Purely informational — never blocks replies or reassignment — and shows as a small dot next to a staff member's name wherever they're the assigned conversation owner.
- **Feature 3 — Conversation assignment** — any staff member can assign a conversation to themselves or a teammate, or unassign it, from a menu in the chat header (`abos_chat_conversations.assigned_to`). The inbox sidebar has two extra filter chips ("Unassigned" / "Assigned to me") and shows a small badge + away-dot under each customer's name for who it's assigned to.
- **Feature 4 — Internal notes** — a staff-only note thread per conversation (`abos_chat_conversation_notes`), completely separate from customer-visible messages — its own table, its own RLS, no `customer_id` anywhere in its policies, so a customer session can never read or fetch these no matter what the frontend does. Any staff member can add a note or delete their own; the real owner can delete anyone's.

Built and verified against the live Supabase schema (columns, RLS, grants, and the updated `abos_chat_owner_inbox()` shape all checked with `execute_sql` after applying). **Not yet done:** the manual click-through testing checklists in `PHASE9_OWNER_STAFF_TOOLS_BLUEPRINT.md` (§1.8, §2.4, §3.5, §4.3) — worth running through on a real device before considering Phase 9 fully signed off. Phase 10 (merging ABOS Chat into the main ABOS product — see the same blueprint doc, "Phase 10" section) hasn't been started.

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
9. `supabase/migration_phase8_quickwins.sql` — reply/quote, edit, soft-delete, pin, reactions table, canned responses table, real `read_at` timestamp, and the `abos_chat_messages_guard_update` trigger that keeps edit/delete/pin permissions correctly separated
10. `supabase/migration_phase9c_assignment.sql` — Phase 9 Feature 3: `assigned_to` column on conversations, RLS, and an updated `abos_chat_owner_inbox()` that also returns assignment + away-status info
11. `supabase/migration_phase9d_internal_notes.sql` — Phase 9 Feature 4: new `abos_chat_conversation_notes` table with its own RLS (never references `customer_id`)

All files are idempotent — safe to re-run if you're not sure what's already applied. Phase 6 (theming + admin assistant) is frontend/API-only — no new migration needed. **Migration 9 has already been applied directly to the live Supabase project via the Supabase MCP tool during this session** — running it again from the repo file is safe and just confirms it's in sync. **Migrations 10 and 11 (Phase 9 Features 3 & 4) have also already been applied directly to the live project** and verified with `execute_sql` — same story, re-running is safe. Phase 9 Feature 1 (staff roles: `agent` role, `active` flag, the `abos_chat_is_owner`/`abos_chat_is_admin` helpers) and Feature 2 (`is_away` column) were applied directly to the live project in an earlier session and were **never saved as a repo migration file** — if you ever need to rebuild this project from scratch, re-derive them from `PHASE9_OWNER_STAFF_TOOLS_BLUEPRINT.md` §1/§2 and the live schema, don't assume a matching `.sql` file exists for those two.

### 2. Environment variables

```
cp .env.example .env
```

Fill in the **same** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` that ABOS uses.

Set `VITE_OWNER_EMAILS` to the email(s) that should see the owner inbox before their DB role is flipped (comma-separated if more than one) — this is a UI convenience only, actual access is enforced by RLS via `abos_chat_profiles.role`.

For AI auto-reply (customer bot) **and** the admin AI assistant, also set:
- `GROQ_API_KEY` — shared by both `/api/groq-reply.js` (customer bot) and `/api/admin-chat.js` (admin assistant); no separate key needed
- `SUPABASE_SERVICE_ROLE_KEY` — server-only, read by `/api/groq-reply.js`, never shipped to the browser

### 3. Install & run

```
npm install
npm run dev
```

(`npm install` picks up `react-hot-toast`, added for the admin assistant's toast notifications and the shared `toast.ts` helper.)

### 4. Make yourself the owner, and add staff/agents

```sql
update abos_chat_profiles set role = 'owner' where email = 'owner@example.com';
update abos_chat_profiles set role = 'agent' where email = 'staff@example.com';
```

Both `owner` and `agent` see the same shared Inbox and the same floating AI assistant (fine-grained per-agent permissions is a later phase). Log out and back in after changing a role — the RLS helper function is re-evaluated on the next session.

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
│   ├── groq-reply.js                 # POST — generates + inserts an AI reply if ai_mode is on (customer-facing bot)
│   ├── admin-chat.js                 # POST — owner/agent-only, backs the floating admin AI assistant
│   ├── customer-orders.js            # GET — owner-only, best-effort orders for a conversation's customer
│   └── _lib/
│       ├── supabaseServer.js         # Service-role Supabase client (server-only)
│       ├── groqClient.js             # Groq caller with retry/backoff — shared by groq-reply.js and admin-chat.js
│       ├── verifyCaller.js           # Verifies the calling user's access token
│       └── verifyOwner.js            # verifyOwner (owner-only) + verifyStaff (owner OR agent, used by admin-chat.js)
├── supabase/
│   ├── schema.sql                    # 1. Run first
│   ├── migration_ai_replies.sql      # 2.
│   ├── migration_ai_reply_webhook.sql# 3.
│   ├── migration_sync_phase1.sql     # 4.
│   ├── migration_sync_with_live_db.sql # 5. Critical fixes
│   ├── migration_phase4_team_scale.sql # 7. Agent role, status/tags, broadcasts, search
│   ├── migration_phase5_calling.sql    # 8. Voice/video calls table + realtime publication
│   ├── migration_phase8_quickwins.sql  # 9. Reply/edit/delete/pin/reactions/canned responses
│   ├── migration_phase9c_assignment.sql    # 10. Phase 9 Feature 3: conversation assignment
│   └── migration_phase9d_internal_notes.sql # 11. Phase 9 Feature 4: staff-only notes table
├── 1 supabase/
│   └── migration_phase2_3_foundation.sql # 6. Unread counts, product snapshots
├── src/
│   ├── theme/
│   │   ├── colors.ts                 # Raw color values for light/dark/colorful (JS-side source of truth)
│   │   ├── tokens.css                # Same palettes as CSS variables — what Tailwind actually reads
│   │   ├── ThemeProvider.tsx         # React context: current theme + setTheme/cycleTheme, persisted per-device
│   │   └── index.ts                  # Barrel export
│   ├── lib/
│   │   ├── supabaseClient.ts         # Supabase client + owner email list
│   │   ├── types.ts                  # Profile / Conversation / ChatMessage / Call types
│   │   ├── chatApi.ts                # All auth + conversation + message + storage + broadcast/search calls
│   │   ├── callApi.ts                # Call lifecycle (ring/claim/end) + WebRTC signaling relay
│   │   ├── webrtc.ts                 # RTCPeerConnection + getUserMedia helpers
│   │   ├── toast.ts                  # Shared toast helper, styled from theme tokens
│   │   ├── useVoiceInput.ts          # Speech-to-text hook (Web Speech API), used by the admin assistant
│   │   ├── useVoiceOutput.ts         # Text-to-speech hook, with retry/watchdog for flaky mobile TTS
│   │   ├── voiceCommands.ts          # Local detection of theme-switch / voice-toggle spoken commands
│   │   └── adminAssistantApi.ts      # Calls /api/admin-chat, parses {reply, action} JSON replies
│   ├── components/
│   │   ├── MessageBubble.tsx         # Renders text/image/location/voice/product/call + sender badge
│   │   ├── ChatWindow.tsx            # Message list + composer + status dropdown + call buttons
│   │   ├── ProductPicker.tsx         # Owner's "send product" search picker
│   │   ├── OrderContextPanel.tsx     # Linked ABOS orders panel
│   │   ├── BroadcastComposer.tsx     # Broadcast/campaign message modal (also accepts an AI-drafted prefill)
│   │   ├── ThemeSwitcher.tsx         # Light/Dark/Colorful 3-way toggle, used by both customer and admin screens
│   │   ├── AdminAssistant.tsx        # Floating AI assistant ("ABI") — bubble + full chat panel, voice in/out
│   │   ├── CallManager.tsx           # App-root call state machine (mounted once, provides useCall())
│   │   ├── CallScreen.tsx            # Full-screen active/outgoing call UI (intentionally theme-independent/dark)
│   │   └── IncomingCallBanner.tsx    # Ringing banner with accept/decline
│   ├── screens/
│   │   ├── AuthScreen.tsx            # Signup / login
│   │   ├── CustomerChatScreen.tsx    # Customer's single chat with the store
│   │   └── OwnerInboxScreen.tsx      # Store side: conversation list, search, status filters, broadcast, AI assistant
│   └── App.tsx                       # Auth gate, routes to customer or owner/agent screen
```

## Recent fixes (2026-07-23)

- **`api/customer-orders.js` route bug fixed** — the file was previously nested at `api/api/customer-orders.js`, which Vercel routed to `/api/api/customer-orders`. The frontend (`chatApi.ts`) always called `/api/customer-orders`, so the "linked orders" panel would have silently 404'd in production. Moved to the correct path.
- **All hardcoded colors removed** — every screen/component previously hardcoded a single dark `slate-*` palette (couldn't be themed at all). Replaced with CSS-variable-backed Tailwind tokens (`bg-app`, `bg-surface`, `text-fg`, `text-muted`, `bg-brand`, `bg-accent`, `bg-success`, `bg-danger`, `bg-warning`) across `App.tsx`, `AuthScreen.tsx`, `CustomerChatScreen.tsx`, `OwnerInboxScreen.tsx`, `ChatWindow.tsx`, `MessageBubble.tsx`, `OrderContextPanel.tsx`, `ProductPicker.tsx`, `BroadcastComposer.tsx`, `IncomingCallBanner.tsx`, and `CallManager.tsx`. `CallScreen.tsx` was left dark on purpose (standard always-dark video-call UX).

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
- **No document attachments** (PDF etc.) — only images/voice currently. Planned for a later phase.
- **No chat transcript export** — planned for a later phase.
- **Agents have the same full access as owner** — no per-agent permission levels (e.g. can't restrict an agent to only certain conversations) yet. This also applies to the admin AI assistant — any agent can use it to act on any conversation.
- **No agent invite flow** — promoting someone to `agent`/`owner` is a manual SQL update after they sign up once; no in-app "invite teammate" UI yet.
- **Broadcast has no delivery/read tracking beyond `recipient_count`** — no per-recipient read status for broadcast messages specifically.
- **AI auto-reply is per-conversation only, no global default.**
- **AI reply debounce isn't a hard lock** — in the rare case two customer messages land at almost the exact same millisecond, both trigger invocations could theoretically pass the "still latest" check and both call Groq. Very unlikely in practice; a stronger fix would be a proper per-conversation lock (e.g. an `ai_reply_in_progress` column with an expiry) — noted here as a possible future hardening, not done yet.
- **AI only reacts to text messages**, not images/location/voice notes.
- **No admin auth hardening beyond RLS** — owner/agent is a flag on the profile row, protected by Postgres RLS. Fine for a small team; would want tighter checks at larger scale.
- **Theme choice is per-device, not per-account** — stored in `localStorage`, so signing in on a new device/browser starts back at the system default rather than remembering a previously chosen theme. Syncing it to the profile row is a small later addition if wanted.
- **Admin assistant has no server-side tool-calling loop** — it proposes one action per turn (parsed from the model's JSON reply) rather than chaining multiple actions itself; multi-step requests may need a couple of back-and-forth turns.
- **Voice recognition/synthesis quality depends on the browser** — best on Chrome/Edge (desktop + Android); Safari/iOS support is present but less consistent, and the mic/speaker buttons hide themselves automatically where unsupported.

## Roadmap

**Next up**
- **Phase 10 — Merging ABOS Chat into the main ABOS product.** Not started. Full plan already written up in `PHASE9_OWNER_STAFF_TOOLS_BLUEPRINT.md` ("Phase 10" section) — becoming a sidebar tab instead of a separate login, WhatsApp messages landing in the same thread, product-website → chat handoff, and ABI becoming this chat's brain.

**Later**
- Document attachments (not just images/voice)
- Chat transcript export
- TURN server for reliable calling across all networks
- Per-agent permission levels (including for the admin AI assistant)
- Per-account theme sync (not just per-device)
