# ABOS Chat — Point 4: AI Agent Blueprint
**Maqsad:** Roadmap ka Point 4 (AI Agent, Groq-powered) — 6 features hain is list mein, is doc mein har ek ka phased build order hai, taake har phase ek clean commit ban sake.

---

## 1. Pehle: Ab Kya Hai (Current State Audit)

Maine yeh files check ki: `api/groq-reply.js`, `api/_lib/aiAgentTools.js`, `api/_lib/groqClient.js`.

**Achi baatein (already solid, foundation strong hai):**
- AI already ek real tool-calling agent hai (sirf chatbot nahi) — `add_to_order`, `remove_from_order`, `view_order`, `confirm_order`, `escalate_to_human` tools already kaam kar rahe hain, live stock/price se grounded.
- Multi-language (roadmap item 2) — session-level detection pehle se tha, **account-level persistence ab Phase 4.2 mein add ho chuki hai (done).**
- Sentiment-based escalation (roadmap item 3) — `escalate_to_human` ka core pehle se tha, **real staff alert ab Phase 4.4 mein add ho chuka hai (done).**
- Debounce, retry, time-budget sab production-grade hai — koi race condition ya timeout issue nahi.

**Is wajah se, build order likhte waqt maine already-partial cheezon ko "polish" phase mein rakha hai, "naya banao" mein nahi.**

---

## 2. Phased Build Order

### ✅ Phase 4.1 — Persistent Customer Memory (DONE — 2026-07-31)

**Kya bana:**
- Nayi table `abos_chat_customer_memory` (customer_id, fact, updated_at) — staff-readable, sirf AI (service role) likh sakta hai.
- Naya tool `remember_customer_fact` — jab customer koi durable preference/pattern reveal kare (favorite item, allergy, "hamesha Friday ko order karta hoon"), AI khud yeh call karta hai.
- Har reply se pehle, customer ki saari purani memory facts system prompt mein inject hoti hain ("What you already know about this customer") — taake AI har baar naye sirey se na poochay.

**Abhi manual test karna hai:** ek customer se 2-3 baar chat karein, ek clear preference batayein (e.g. "mujhe hamesha Basmati chahiye"), phir naya conversation start karke check karein AI usay yaad rakhta hai ya nahi.

---

### ✅ Phase 4.2 — Multi-language: session se account-level (DONE — 2026-07-31)

**Kya bana:**
- `abos_chat_profiles` mein `preferred_language` column (`'roman-urdu'` / `'english'` / null).
- Naya tool `set_preferred_language` — AI pehli baar jab confidently pata chale, ek hi baar call karta hai.
- System prompt mein "known preferred language" block add hua — agar customer ka pehla message hi ambiguous ho ("Hi", "ok"), AI ab bhi sahi language mein reply karega (pehle sirf current message dekhta tha).

**Test:** naye customer se pehli baar clear Roman Urdu/English mein baat karein, phir ek naya conversation start karke sirf "Hi" bhejein — dekhein AI sahi language mein reply karta hai.

---

### ✅ Phase 4.4 — Sentiment Detection → Real Auto-Escalate Alert (DONE — 2026-07-31)

**Kya bana:**
- `escalate_to_human` tool (already tha) ab conversation tag/status update ke sath-sath ek **real-time broadcast** bhi bhejta hai `staff-alerts` channel par (Supabase Realtime REST broadcast endpoint se, koi persistent socket serverless function mein nahi khola).
- Realtime Authorization RLS policy — sirf staff (`abos_chat_is_owner`) is channel ko receive kar sakte hain, koi client ise spoof nahi kar sakta (sirf service role bhej sakta hai).
- Owner Inbox screen ab is channel ko subscribe karta hai — jab AI koi conversation escalate kare, turant ek toast dikhta hai (customer ka naam + reason) aur inbox list refresh ho jati hai.

**Test:** AI chat mein customer ban kar koi complaint/refund wala message bhejein (jaisa "yeh product kharab tha, refund chahiye") — dekhein Owner Inbox mein turant toast aata hai.

**Baaki chhora hua (future polish, abhi nahi):** Web Push (Phase 4a, jo ab schema-correct hai) is escalation alert se abhi wire nahi hai — abhi sirf tab kaam karta hai jab Owner Inbox tab khula ho. Push wiring ek chota future add hai jab UI se `subscribeToPush()` kahin call ho.

---

### Phase 4.3 — AI Conversation Summary for Owner

Lambi chat ka 2-line summary jo Owner Inbox mein conversation list item ke neeche dikhe (jaisa WhatsApp/Slack thread preview karta hai, bas AI-generated).

**Design:** naya lightweight endpoint `/api/summarize-conversation` — sirf tab chalay jab conversation `pending`/`resolved` ho jaye ya har N messages baad (real-time har message pe nahi, cost/latency ki wajah se). Summary ek naye column `abos_chat_conversations.ai_summary` mein store hogi. `abos_chat_get_conversation_summary()` function jo maine live DB mein dekha, usay reuse kar sakte hain iske liye (currently sirf raw metadata deta hai, isay AI-summary store karne ke liye extend karna hoga).

**Effort:** medium — 1 migration + 1 naya API route + Owner Inbox UI mein ek line.

---

### Phase 4.5 — Proactive Follow-ups

Abandoned cart reminder, reorder reminder — AI khud message bhejta hai bina customer ke trigger kiye.

**Challenge:** Vercel serverless mein "har ghante check karo" jaisa cron chahiye — Vercel Cron Jobs use hongi (free tier: daily se zyada frequent chahiye ho to Pro chahiye ho sakta hai, verify karna hoga jab is phase pe pahunchein).

**Design:** naya scheduled endpoint jo (a) `abos_chat_ai_drafts` mein X ghante se pending draft dhoondhe (abandoned cart), (b) `orders` table se pattern nikale (customer memory se already stored "usually orders every Friday" jaisi facts bhi yahan kaam aayengi — Phase 4.1 ka dividend), phir un customers ko ek proactive message bheje.

**Effort:** bara — sabse zyada naya infra (cron + safe rate-limiting taake spam na ho).

---

### Phase 4.6 — AI Voice Calling

Jab owner available na ho, AI khud call answer kare — ABOS ke ABI jaisa, isi WebRTC infra (Point 3) ke upar.

**Yeh sabse bara/complex phase hai** — is mein chahiye: real-time speech-to-text, Groq se streaming response, text-to-speech, aur WebRTC audio pipeline mein inject karna (existing `webrtc.ts`/`CallManager.tsx` ke upar). Recommend karta hoon yeh **sab se end mein** karein, jab 4.1-4.5 solid ho chuke hon — aur jab shuru karein, ABOS Dashboard ke ABI voice code (jo already isi tarah ka kaam karta hai) se reuse-able patterns dekhein pehle.

---

## 3. Suggested Order — Progress

1. ✅ 4.1 Persistent Memory — done (2026-07-31)
2. ✅ 4.2 Multi-language (account-level) — done (2026-07-31)
3. ✅ 4.4 Sentiment auto-escalate alert — done (2026-07-31)
4. 4.3 Conversation summary — next up
5. 4.5 Proactive follow-ups — naya infra (cron), thora time lagega
6. 4.6 AI voice calling — sab se end mein, sab se bara

**Batayein agla kaun sa phase karna hai** — ya main khud isi order mein sequence continue kar doon.
