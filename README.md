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
- **TURN server (metered.ca)** — a paid TURN subscription is wired in via `/api/turn-credentials`, on top of STUN. This is what actually made two-way audio reliable across strict/symmetric NAT (some corporate wifi, carrier-grade NAT) — **do not remove or let the metered.ca subscription lapse**; without TURN, calls will still show "connected" with a running timer but audio silently won't flow for a meaningful fraction of real-world network pairs (see the ⚠️ Warnings section below for the exact failure mode this caused before).
- **Call waiting (Phase 6)** — if you're already on a call and a second one comes in, it's **not silently ignored**: the incoming row is marked `waiting` and you get a "📞 Already on a call — waiting for next call" toast. It is **not auto-queued/auto-connected** after your current call ends — the caller still has to try again.
- **Stale-call cleanup** — `abos_chat_reap_stale_calls()` / `abos_chat_cleanup_old_calls()` auto-close any `ringing`/`waiting` row that's been sitting for too long (added 2026-07-24), so a crashed tab or lost connection can't leave a call stuck ringing forever on the other end.

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

**Phase 10 — Calling upgrades: screen share, live adaptive quality, voicemail, call recording**

> Confusingly there are now **two different "Phase 10"s** in this repo's history: `PHASE9_OWNER_STAFF_TOOLS_BLUEPRINT.md` uses "Phase 10" to mean *merging ABOS Chat into the main ABOS product* (not started — see previous paragraph). **This** Phase 10 is `abos-chat-ROADMAP.md`'s point 3, "Calling / Video" — a completely separate, already-shipped batch of work. Don't confuse the two when reading old docs.

- **Screen sharing (video calls only)** — `getDisplayMedia()` swapped onto the existing video sender via `RTCRtpSender.replaceTrack()`, deliberately **not** a new `addTrack()`/renegotiation, so it can never trigger the double-offer bug described below. Feature-detected (`isScreenShareSupported()`) so the button simply doesn't render on devices without support — **this means it's desktop-browser only in practice**; iOS Safari and most mobile Chrome sessions will never show the button, which is expected, not a bug. Screen track gets `contentHint = "detail"` so text/product photos stay sharp rather than being optimized for motion.
- **Live adaptive quality** — the existing 3-second quality-report poll (`getCallQualityReport`) now also *acts* on the number instead of only displaying it: it adjusts the video sender's `maxBitrate` + `scaleResolutionDownBy` per quality tier (excellent/good/poor/very-poor). Audio is never touched — Opus at ~32kbps is already small enough that congestion is almost always a video cost. No UI, no button — it's always on for every video call.
- **Voicemail** — if a call rings out unanswered (`RING_TIMEOUT_MS`, 30s) with nobody claiming it, the caller now gets a record/skip prompt (`VoicemailPrompt.tsx`) instead of the screen just closing. Reuses the existing `kind: "voice"` message shape (same as a normal voice note) plus `call_id` linking it back to the missed-call row — **no new table**. Explicit decline (someone taps Reject) does **not** offer voicemail, only a genuine ring-timeout does — that's an intentional design choice, not a bug if you're testing and wondering why decline doesn't show the prompt.
- **Call recording** — **audio-only, on purpose.** Mixes local mic + remote peer audio through a Web Audio `AudioContext`/`MediaStreamDestination` into one `MediaRecorder`. Video is deliberately not captured — that would need a canvas-compositing loop (draw both `<video>` elements to a canvas every frame, `captureStream()` it, mux with audio), a much larger and more fragile piece of work than the "have a listenable record of the call for training/support" use case actually needs. Consent handling: the person who starts recording gets a native `confirm()` prompt before it starts, and the *other* party gets a live "🔴 Recording" banner the instant it starts (same signal-message mechanism as the screen-share status ping — no SDP involved). Stored the same way as voicemail: `kind: "recording"` message + `call_id`, uploaded to the existing `abos-chat-media` bucket.
- **Reused `abos_chat_messages.kind`, no new tables** — voicemail piggybacks on the pre-existing `"voice"` kind; call recording needed exactly one migration, adding `"recording"` to the `kind` CHECK constraint (see Database reference below). This was a deliberate minimal-footprint choice — resist the urge to design a separate `voicemails`/`recordings` table unless a real need for extra metadata (e.g. per-listener read receipts) shows up later.
- **Not built (still on the Phase 10/point-3 roadmap):** group calls (would need a participants table + moving off pure 1:1 mesh — the biggest of the six items, do it first if you ever do it, since the other five don't strictly need it but group calls would want to build on top of a settled multi-party foundation), call transfer.

## ⚠️ Warnings — read before touching this code

Every one of these is a **real bug that actually happened** in this repo, not a hypothetical. Each one either broke silently (no error, no crash — it just quietly didn't work) or came back after being "fixed" once already. If you're an AI tool or a new dev making changes here, read this section first.

**Never use `truncate` on dynamic (DB/user-supplied) text inside a flex row.**
`truncate` = `white-space: nowrap` + `overflow: hidden` + `text-overflow: ellipsis`. Inside a flexbox row, `nowrap` text's *intrinsic* (unwrapped, one-line) width can be huge — a long product name, a long canned-response body, a long customer name. Even with `min-w-0` on the flex item, this intrinsic size can still confuse the flex-shrink calculation and force the bubble/row wider than the screen, pushing it (and everything inside it, including a working `<audio>` player) off the left edge. **Short/static strings never show this** ("Sorry", "Editing message", "Internal notes") because they're already small — that's exactly why it's easy to miss in a quick test and ship it. **Fix, everywhere this pattern appears:** replace `truncate` with `line-clamp-1 [overflow-wrap:anywhere]` (normal wrapping = small, correct intrinsic size; `line-clamp-1` just visually clips it back down to one line) and make sure the element sits inside a `min-w-0` container. This exact bug shipped, got reported (message bubbles showing half, voice-note play button "disappeared" off-screen), got fixed once already in an earlier session, then **came back** when a later change (adding `w-full` to the message row) altered the layout enough to re-trigger it. If you touch chat-bubble, conversation-list, or any-list-with-a-name/title layout code, grep for `truncate\b` in `src/` first and make sure any DYNAMIC text you're near uses `line-clamp-1 [overflow-wrap:anywhere]`, not `truncate`.

**Never let both sides of a WebRTC call send an SDP offer.**
`CallManager.tsx`'s `onnegotiationneeded` handler only lets the **caller** send offers (`if (!isCaller) return`). This exists because of a real bug: when both peers could trigger an offer on track-add, the callee would answer the first offer, then a second (duplicate) offer would arrive mid-negotiation and break the connection's audio path — the call UI still showed "Connected" with a running timer, but no audio ever flowed, and there was no error anywhere to point at it. This is why **screen sharing uses `RTCRtpSender.replaceTrack()`, not `addTrack()`** — `replaceTrack()` swaps media on an already-negotiated line with zero renegotiation, so it can never re-trigger this. If you ever add a feature that needs a callee-initiated renegotiation (e.g. callee adding a second video track mid-call), you cannot just remove the `isCaller` guard — you need a real "polite peer" negotiation pattern, or you will reopen this exact bug.

**A third-party AI tool has silently stripped working code from this file before.** `CallManager.tsx` once lost ~80 lines (ICE-reconnect logic, the negotiation guard above) to an AI-assisted edit that gave no error or warning — it just quietly deleted them. After *any* AI-assisted edit to `CallManager.tsx` / `webrtc.ts` / `callApi.ts`, grep the deployed production bundle for a few non-minifiable strings you know should be there (e.g. a distinctive `console.log`/comment string) to confirm the logic actually survived the edit and actually deployed — don't just trust that the diff looked fine.

**`pg_net`'s default timeout is 5000ms** — too short for a full Groq tool-calling round trip. Both AI webhooks (`migration_ai_reply_webhook.sql` and the admin-chat path) explicitly set a longer timeout. If you add a new `net.http_post` call to any Groq/LLM endpoint, set the timeout explicitly — don't rely on the default, or replies will silently go missing under load exactly the way the "Late replies fixed" entry below describes.

**RLS policies on `abos_chat_profiles` must never check owner status by querying `abos_chat_profiles` itself** — that's infinite recursion, and Postgres will reject the query outright (every single query against the table starts failing, including login). Always go through the `SECURITY DEFINER` helper `abos_chat_is_owner()` / `abos_chat_is_admin()`, which bypass RLS specifically to break this cycle.

**Column-level grants matter as much as RLS here.** `abos_chat_profiles` only grants broad `UPDATE` on the `name` column — this was tightened after a real self-escalation hole where a customer could `UPDATE` their own `role` column straight to `'owner'`. If you ever add a new sensitive column to a table a customer can `UPDATE` rows on, check the grant is column-scoped, not table-wide.

**Live DB schema and the `.sql` files in `supabase/` can drift.** Several changes (Phase 9 Features 1 & 2, the `recording` kind added for Phase 10, the `message_queue`/`mark_messages_read` additions) were applied directly to the live project via the Supabase MCP tool and were **not** always saved back as a new migration file here. Before writing new SQL against a table, run `execute_sql` against the live schema — don't assume a `.sql` file in this repo is the full/current picture. The Database reference section below reflects the **live** schema as of this write-up, which is more current than the migration file list in some places.

**Use `vault.decrypted_secrets`, not `vault.secrets`**, to read an actual secret value out of Supabase Vault — `vault.secrets` only has the encrypted blob.

**Vercel Hobby-plan log retention is ~1 hour.** When pulling `get_runtime_logs`, use `since: "1h"` at most — asking for more just silently returns nothing usable, it won't error.

**`execute_sql` with multiple `;`-separated statements only returns the result of the last one.** Send each query as its own call if you need to see the result of more than one.

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

**Also not saved as repo migration files** (same "live-only" situation, applied via the Supabase MCP tool in later sessions — see the Database reference section for the full current shape): the `abos_chat_message_queue` table + `abos_chat_mark_messages_read()` function, the TURN-related profile/call columns, and Phase 10's one-line addition of `'recording'` to `abos_chat_messages.kind`'s CHECK constraint. If rebuilding from scratch, verify against the live schema (`execute_sql`), not just this file list.

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

## Database reference (live schema, not just the migration files)

Pulled directly from the live Supabase project (`akjugxzvexcpslhzvuhz`) via `execute_sql`, so this reflects reality even where it's ahead of `supabase/*.sql` (see the "Live DB schema can drift" warning above). All tables are prefixed `abos_chat_` to share the project with ABOS without name clashes.

**Tables**

| Table | What it's for | Notable columns |
|---|---|---|
| `abos_chat_profiles` | One row per user (customer or staff) | `role` (`customer`/`agent`/`owner`), `customer_number` (auto `ABOS-000001` style), `active`, `is_away`, `on_call`, `current_call_id`, `preferred_language` (PHASE 4.2: `'roman-urdu'`/`'english'`/null, set once by the AI's `set_preferred_language` tool) |
| `abos_chat_conversations` | One thread per customer | `status` (open/pending/urgent/resolved), `tags` (text[]), `assigned_to`, `ai_mode`, `customer_last_read_at`/`owner_last_read_at` |
| `abos_chat_messages` | Every message, every kind | `kind` (`text`/`image`/`location`/`voice`/`product`/`call`/`order`/`recording`), `media_url`, `call_id` (links a `voice`/`recording` message back to the call it came from — used by voicemail & call recording, Phase 10), `reply_to_id`, `edited_at`/`deleted_at`/`pinned_at`, `delivery_status`, `is_ai`, `product_snapshot`/`order_snapshot` (jsonb) |
| `abos_chat_calls` | Call lifecycle | `status` (ringing/active/ended/missed/declined/waiting), `kind` (voice/video), `caller_role`, `last_heartbeat_at`, `answered_by_ai` (PHASE 4.6a: true if the AI agent picked up instead of a human), `livekit_room` (PHASE 4.6a: set only when `answered_by_ai` is true) |
| `abos_chat_ai_call_settings` | PHASE 4.6a: shop-wide AI-voice-calling config, singleton row (`id = true`) | `enabled` (default `false` — feature is off until the agent worker is deployed and tested), `ring_timeout_before_ai_seconds`, `voice_ur`/`voice_en` (currently `ur-PK-AsadNeural`/`en-US-JennyNeural`), `greeting_ur`/`greeting_en` |
| `abos_chat_message_reactions` | Emoji reactions | one row per `(message_id, user_id)` |
| `abos_chat_conversation_notes` | Staff-only internal notes | own RLS, **never references `customer_id`** — a customer session cannot read this table under any circumstance |
| `abos_chat_canned_responses` | Shared quick-reply library | shop-wide, any staff member can manage |
| `abos_chat_broadcasts` | Campaign message log | `target_tag` (null = everyone), `recipient_count` |
| `abos_chat_message_queue` | Offline/failed-send retry queue | `message_data` (jsonb — the original send payload), `attempts`/`max_attempts`, `next_retry_at` |
| `abos_chat_ai_drafts` | AI agent's in-progress order cart, per conversation | `items` (jsonb) — used by the AI's `add_to_order`/`remove_from_order`/`confirm_order` tools in `api/_lib/aiAgentTools.js` |
| `abos_chat_exports` | Chat transcript export jobs | **backend-only right now** — `abos_chat_get_transcript()` and `abos_chat_cleanup_old_exports()` exist and the table is live, but there is currently **no frontend button or API route that writes to it**. Don't assume "export chat" works end-to-end just because the table exists — it's schema without UI. |
| `abos_chat_push_subscriptions` | Web Push (VAPID) subscriptions | `user_id`, `endpoint` (unique), `p256dh`, `auth`. Written by `pushApi.ts`, read by `send-push.js`. **Schema exists and is correct now (2026-07-31 fix), but nothing in the UI calls `subscribeToPush()` yet** — still dead code until wired to a real trigger. Not to be confused with `abos_chat_push_tokens`, an unrelated/unused native-token table left untouched. |
| `abos_chat_customer_memory` | PHASE 4.1: durable AI-learned facts per customer | `customer_id`, `fact`, `updated_at` — written only by the `remember_customer_fact` AI tool (service role), read into every reply's system prompt; staff-readable via RLS, no customer/agent-write policy on purpose |

**Key functions** (all `SECURITY DEFINER` where they need to bypass RLS)

- `abos_chat_is_owner(uid)` / `abos_chat_is_admin(uid)` — the RLS-recursion-safe way to check staff/owner status; see the warning above
- `abos_chat_owner_inbox()` — the single query that builds the whole inbox sidebar (unread counts, assignment, away-status, last message)
- `abos_chat_search_conversations(term)` — searches customer name/number/email/tags **and** message bodies in one pass
- `abos_chat_send_broadcast(body, tag)` — atomically fans a broadcast out to every matching conversation
- `abos_chat_mark_messages_read(...)` — server-side read-receipt update, added alongside `abos_chat_message_queue`
- `abos_chat_messages_guard_update()` — `BEFORE UPDATE` trigger that keeps edit/delete/pin permissions correctly separated (a customer can pin a staff message but can never edit/delete it, etc.) and blocks `delivery_status`/`sender_id`/`is_ai` from ever being touched client-side
- `abos_chat_next_customer_number()` — generates the `ABOS-000001` sequence
- `abos_chat_check_call_rate_limit()`, `abos_chat_check_call_waiting()` / `abos_chat_handle_call_waiting()` — back the "already on a call" toast described in Phase 5 above
- `abos_chat_reap_stale_calls()` / `abos_chat_cleanup_old_calls()` — auto-close abandoned `ringing`/`waiting` rows
- `abos_chat_calls_sync_profile_status()` / `abos_chat_is_on_call()` — keep `abos_chat_profiles.on_call`/`current_call_id` in sync with the calls table
- `abos_chat_get_transcript()` / `abos_chat_cleanup_old_exports()` — power the not-yet-wired-to-UI export feature, see the `abos_chat_exports` row above
- `abos_chat_handle_new_user()` — the `on_auth_user_created` trigger that creates the matching `abos_chat_profiles` row on signup
- `abos_chat_set_staff_role()` / `abos_chat_set_staff_active()` — used by the Staff screen to promote/demote and activate/deactivate

**Storage:** one bucket, `abos-chat-media` (public) — images, voice notes, voicemail (Phase 10), and call recordings (Phase 10) all live here under `conversations/{conversation_id}/{purpose}/...` prefixes.

**Realtime Authorization policies on `realtime.messages`** (private broadcast channels, not regular tables):
- `call-signal-{callId}` — call participants only (customer or staff), used for WebRTC signaling
- `staff-alerts` (PHASE 4.4) — staff-only receive; only the server (service role via the REST broadcast endpoint, `broadcastServerMessage()` in `supabaseServer.js`) ever sends, no client insert policy exists on purpose

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
│   ├── ai-call-connect.js            # POST — Phase 4.6a: connects an unanswered call to the AI agent via LiveKit (creates room, dispatches agent, marks answered_by_ai)
│   ├── livekit-token.js              # POST — Phase 4.6a: re-issues a LiveKit join token for an already-active AI call (reconnect, or staff listen-in)
│   └── _lib/
│       ├── supabaseServer.js         # Service-role Supabase client (server-only)
│       ├── groqClient.js             # Groq caller with retry/backoff — shared by groq-reply.js and admin-chat.js
│       ├── verifyCaller.js           # Verifies the calling user's access token
│       ├── verifyOwner.js            # verifyOwner (owner-only) + verifyStaff (owner OR agent, used by admin-chat.js)
│       ├── livekitServer.js          # Phase 4.6a: LiveKit server SDK helper — token minting, room creation, agent dispatch
│       └── sentryServer.js           # Phase 4.6a: backend error capture (@sentry/node) — src/lib/sentry.ts already covered the frontend, api/ had none until this
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
│   │   ├── callApi.ts                # Call lifecycle (ring/claim/end) + WebRTC signaling relay — Phase 10 added the screen-share/recording status-ping signal types
│   │   ├── webrtc.ts                 # RTCPeerConnection + getUserMedia helpers, TURN credentials, quality monitoring + Phase 10's adaptive-bitrate logic, screen-capture + shared audio-mimeType helpers
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
│   │   ├── CallManager.tsx           # App-root call state machine (mounted once, provides useCall()) — also owns screen share, adaptive quality wiring, call recording, and the voicemail hand-off (Phase 10)
│   │   ├── CallScreen.tsx            # Full-screen active/outgoing call UI (intentionally theme-independent/dark) — mute/camera/screen-share/record controls
│   │   ├── VoicemailPrompt.tsx       # Phase 10: shown to the caller after a ring times out unanswered — record/preview/send/skip
│   │   └── IncomingCallBanner.tsx    # Ringing banner with accept/decline
│   ├── screens/
│   │   ├── AuthScreen.tsx            # Signup / login
│   │   ├── CustomerChatScreen.tsx    # Customer's single chat with the store
│   │   └── OwnerInboxScreen.tsx      # Store side: conversation list, search, status filters, broadcast, AI assistant
│   └── App.tsx                       # Auth gate, routes to customer or owner/agent screen
```

**Not shown above — deliberately a separate repo:** the Phase 4.6 AI voice-calling agent worker (`agent.py`, `edge_tts_plugin.py`) lives in its own `abos-chat-ai-agent` repo, deployed to LiveKit Cloud, not this Vercel project. It's a small persistent Python process (needs to stay connected for the duration of a call) — Vercel serverless functions can't host that, only trigger it (see `api/ai-call-connect.js`). See `PHASE4_6_AI_VOICE_CALLING_BLUEPRINT.md` for the full reasoning.

## Recent fixes (2026-07-31)

Found during a full code+DB+deployment audit before starting Phase 4 (AI Agent):

- **Agent call-end bug fixed** — `endCall()` in `callApi.ts` inserted `sender_role: me.role` into `abos_chat_messages`, but the DB's `sender_role` CHECK constraint only allows `'customer'`/`'owner'`. Since staff can have `role = 'agent'`, this insert silently failed (constraint violation, uncaught) whenever an agent — not the owner — ended a call, so that call's log bubble (duration/"Missed call" line) never appeared. Fixed to use the existing `chatRoleOf(me)` helper, same as `caller_role` already does a few lines above.
- **Real-time messaging was poll-only, not actually real-time** — `abos_chat_messages` and `abos_chat_conversations` were never added to the `supabase_realtime` publication, so the `postgres_changes` subscriptions in `subscribeToMessages`/`subscribeToMessageUpdates`/`subscribeToConversation` never fired. The app still felt roughly live because `ChatWindow.tsx` already has a 4-second poll fallback, but it wasn't true push. Fixed by adding both tables to the publication — messages/status changes now arrive instantly instead of up to 4s late.
- **Push notification table never existed** — `pushApi.ts`/`send-push.js` have always pointed at `abos_chat_push_subscriptions` (Web Push VAPID model: `endpoint`/`p256dh`/`auth`), but that table was never created; the DB only had an unrelated `abos_chat_push_tokens` (different, native-token schema, unused by this code). Created the correct table + RLS. Also added the missing `web-push` npm dependency (`api/send-push.js` imports it, but it was never in `package.json`, so the endpoint would have crashed with "Cannot find module" the moment it was ever called). This feature is still not wired up to any UI trigger — see Known limitations.

## Recent additions (2026-08-01) — Phase 4.6a: AI voice calling foundation

Full reasoning/architecture in `PHASE4_6_AI_VOICE_CALLING_BLUEPRINT.md`. Summary:

- **What it's for** — roadmap point 4.6: when nobody on staff answers a call, the AI can pick up instead of the caller just hitting the ring-timeout/voicemail flow.
- **Why not built on Vercel alone** — a real live-audio AI participant needs a process that stays connected for the whole call; Vercel serverless functions can't do that. Chosen architecture: **LiveKit Cloud** (free "Build" tier — 5,000 WebRTC minutes + 1,000 AI Agent minutes/month, no card) hosts a small persistent agent worker; this repo's Vercel functions only *trigger* it.
- **STT + LLM:** Groq (Whisper + Llama 3.3 70B) — same `GROQ_API_KEY` this repo already uses.
- **TTS:** currently **edge-tts** (free, unofficial, zero signup — `edge_tts_plugin.py` in the agent repo, a custom LiveKit TTS plugin since no official one exists), voice `ur-PK-AsadNeural`. Azure Speech (official, same voice catalog, F0 free tier) was the original plan but account verification was stuck at build time — switching back later is a 2-line change in `agent.py` (commented block already there).
- **DB (live-applied, not just a migration file — see the schema-drift warning above):** `abos_chat_ai_call_settings` singleton table + `abos_chat_calls.answered_by_ai`/`.livekit_room` columns. `enabled` defaults to `false` — the feature does nothing until it's explicitly turned on.
- **New Vercel endpoints:** `api/ai-call-connect.js` (creates the LiveKit room + dispatches the agent + marks the call `answered_by_ai`), `api/livekit-token.js` (reconnect / staff listen-in-only token).
- **Backend Sentry added** (`api/_lib/sentryServer.js`, `@sentry/node`) — the frontend already had Sentry (`src/lib/sentry.ts`), but `api/` had zero error monitoring before this; added specifically because a voice pipeline has far more silent-failure modes than a text reply.
- **Next (4.6b, not started):** instead of giving the voice agent its own separate Groq tool-calling logic, wire it to call the existing `abi-core` repo's `/api/customer-command` endpoint (the same one abos-chat's own customer AI chat widget would use) — reuses order-taking/inventory/related-product tools with zero duplicated logic. Requires passing the customer's Supabase access token through LiveKit job dispatch metadata.
- **Not done yet:** no in-app UI to trigger this (4.6c — no "talk to AI" button, no ring-timeout auto-offer), so right now the only way to test it is calling `POST /api/ai-call-connect` directly.

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
- **Call waiting exists but doesn't queue** — a second incoming call while you're already on one shows a toast ("Already on a call") instead of being silently dropped, but it is **not** auto-connected once your current call ends; the caller has to try again themselves.
- **No document attachments** (PDF etc.) — only images/voice currently. Planned for a later phase.
- **Chat transcript export is schema-only** — `abos_chat_exports` table + `abos_chat_get_transcript()`/`abos_chat_cleanup_old_exports()` functions exist live in the DB, but there's no frontend button or API route wired up to actually use them yet.
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
- **Screen sharing is desktop-browser only** — feature-detected via `getDisplayMedia()`; iOS Safari and most mobile Chrome sessions never see the button. Video calls only, not voice calls (no video sender to swap a screen track onto).
- **Call recording is audio-only** — no video is captured (see Phase 10 notes above for why). Consent is a visible live banner to both parties + a confirm-prompt for whoever starts it, not a blocking two-party opt-in click — if a stricter jurisdiction-specific consent flow is ever needed, that's a deliberate gap to close, not an oversight.
- **No group calls, no call transfer** — still 1:1 only; both remain on the roadmap (see below). Group calls in particular would need a real architecture change (a participants table, moving off pure mesh WebRTC), not just an incremental addition.
- **AI voice calling (Phase 4.6) is foundation-only** — DB + Vercel endpoints exist, but `abos_chat_ai_call_settings.enabled = false` and there's no UI to trigger it yet (no "talk to AI" button, no ring-timeout auto-offer). The agent worker also can't take real orders yet — it just talks — until 4.6b wires it to `abi-core`.
- **edge-tts is unofficial** — the AI voice agent's TTS currently runs on a reverse-engineered wrapper around Microsoft Edge's "Read Aloud" feature, not a documented/supported API. It could break without notice. Switching to official Azure Speech (same voice, same code shape, already stubbed out commented in `agent.py`) is a deferred to-do, not a rejected option.

## Roadmap

**Next up**
- **Point 4 — AI Agent, in progress.** Full phased plan in `PHASE4_AI_AGENT_BLUEPRINT.md`. Done so far: **4.1 Persistent Customer Memory** (`remember_customer_fact` tool + `abos_chat_customer_memory`), **4.2 Multi-language account-level** (`set_preferred_language` tool + `abos_chat_profiles.preferred_language`), **4.4 Sentiment auto-escalate real alert** (`staff-alerts` Realtime broadcast + toast in Owner Inbox, Realtime-Authorization-secured). Next up: **4.3 AI conversation summary for owner**. Not started: 4.5 proactive follow-ups. **4.6 AI voice calling — foundation done (4.6a, 2026-08-01)**, see `PHASE4_6_AI_VOICE_CALLING_BLUEPRINT.md` — DB + Vercel endpoints live, agent worker built in the separate `abos-chat-ai-agent` repo (LiveKit Cloud + Groq + edge-tts), feature flag `abos_chat_ai_call_settings.enabled` still `false` until the agent worker is deployed and tested. Not started: 4.6b (wiring `abi-core`'s `/api/customer-command` into the voice agent so it can take orders), 4.6c (in-app UI to trigger/offer AI calls), 4.6d/e.
- **Phase 10 (blueprint sense) — Merging ABOS Chat into the main ABOS product.** Not started. Full plan already written up in `PHASE9_OWNER_STAFF_TOOLS_BLUEPRINT.md` ("Phase 10" section) — becoming a sidebar tab instead of a separate login, WhatsApp messages landing in the same thread, product-website → chat handoff, and ABI becoming this chat's brain.
- **Remaining calling/video roadmap items (point 3)** — group calls (biggest, needs a participants-table redesign — see Phase 10 notes above) and call transfer. Screen sharing, live adaptive quality, voicemail, and call recording are done (this Phase 10).

**Later**
- Document attachments (not just images/voice)
- Wire the already-built `abos_chat_exports`/`abos_chat_get_transcript()` backend up to an actual frontend export button
- Per-agent permission levels (including for the admin AI assistant)
- Per-account theme sync (not just per-device)
- Stricter two-party consent flow for call recording, if a jurisdiction ever requires it beyond the current live-banner notice
