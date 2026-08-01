# abos-chat — Phase 4.6: AI Voice Calling — Blueprint

**Status:** Planning (research + connector checks complete, code abhi start nahi hua — ek architecture decision chahiye pehle, neeche dekhein)
**Date:** 2026-07-31
**Maqsad:** Roadmap Point 4, item 4.6 — "jab owner available na ho, AI khud call answer kare" — aur saath hi voice assistant (ABI) ki voice quality upgrade bhi.

---

## 1. Pre-work verification (jo abhi kiya)

- README + `abos-chat-ROADMAP.md` + `PHASE4_AI_AGENT_BLUEPRINT.md` poori tarah parh li — Phase 4.1/4.2/4.4 done confirm hain, 4.3/4.5/4.6 baaki hain (yeh doc sirf 4.6 cover karta hai).
- Live Supabase schema check ki (`execute_sql` se, verbatim `.sql` files pe bharosa nahi kiya — jaisa README ki warning kehti hai): `abos_chat_calls` aur `abos_chat_profiles` mein abhi koi AI-call column nahi hai (`answered_by_ai` waghera sab naye add karne hain).
- Vercel project (`abos-chat`, `prj_zDYF8gz8eDVEkpOCIVN2ejU3c37R`) live confirm — production `abos-chat.vercel.app` par deployed hai.
- **Sentry already connected hai** — org `abos-u1`, project `abos-chat` mila. Abhi tak README mein Sentry ka zikr nahi tha, matlab set up hai lekin errors wire nahi hain is repo ke code se. Voice pipeline jaisi fragile cheez ke liye yeh bohat kaam ayega (STT/TTS/call failures track karne ke liye) — Phase 4.6 mein hi wire kar dena chahiye.

---

## 2. Voice provider research — jawab (jo pucha tha)

### Speech-to-Text (customer ki awaz sunna)
**Groq Whisper Large v3** — already tumhare paas `GROQ_API_KEY` hai, koi naya signup nahi chahiye.
- Urdu support achi hai (multilingual Whisper, 99+ languages).
- Free tier: **2,000 requests/day, ~8 audio-hours/day**, no credit card — ek chhoti/medium dukaan ke liye kaafi zyada hai.
- Paid tier bhi bohat sasta hai agar zaroorat pare ($0.04/hour).
- **Faisla: yehi use karo, koi alternative sochne ki zaroorat nahi.**

### Text-to-Speech (AI ki awaz bolna)
Groq ka apna TTS (`playai-tts`) check kiya — **sirf English aur Arabic support karta hai, Urdu bilkul nahi.** Is liye Urdu ke liye alag provider chahiye.

Best free Urdu (aur saath English bhi) voice: **Microsoft ki `ur-PK-AsadNeural` (mard) / `ur-PK-UzmaNeural` (aurat)** — yeh do neural voices khaas Pakistani Urdu ke liye bani hain, sabse natural sounding free option hai jo maine dekha. Dono tarah access ho sakta hai:

| Option | Setup | Cost | Production-safe? |
|---|---|---|---|
| **edge-tts** (unofficial) | Koi signup/API key nahi, seedha kaam karta hai | 100% free, hamesha | Microsoft ke "Read Aloud" feature ko reverse-engineer karta hai — kal ko band ho sakta hai, koi SLA/guarantee nahi |
| **Azure Speech F0 tier** (official) | Free Azure account + key chahiye (koi card charge nahi) | 500,000 characters/month TTS free, forever, kabhi expire nahi hota | Microsoft ka apna official product hai, stable/production-grade |

Dono same underlying voices (Asad/Uzma) use karte hain — awaz bilkul same hogi, sirf reliability/setup-effort ka farq hai.

**Mera default suggestion:** shuru mein **edge-tts** se banate hain (zero setup, turant test kar sakte ho mobile se), aur agar aage chal ke stability ka masla aaya to same code Azure key pe switch ho jayega (bas ek config value badalni hogi, tumhara pura front-end/DB kaam waisa hi rahega). Neeche Section 4 mein iske liye ek confirm karna hai.

---

## 3. Sabse zaroori decision — call architecture

Yeh Phase 4.6 ka sabse important fork hai, isay likhna zaroori tha code likhne se pehle warna kaam ulta ho sakta tha.

**Asal masla:** Customer-to-staff calls abhi **real WebRTC peer-to-peer** hain (`CallManager.tsx`, dono taraf browser). AI ko literally usi tarah "third peer" banana — yani AI ka apna continuous RTCPeerConnection, jo call ki poori duration tak zinda rahe — **Vercel serverless functions pe possible nahi hai.** Serverless functions stateless hain, koi persistent process nahi rakh sakte, aur asal WebRTC media relay ke liye ek hamesha-chalta process chahiye hota hai (jaisa `node-webrtc`/`mediasoup` waghera — yeh Vercel pe deploy nahi hote). Yeh cheez maine bataye bina age barhna theek nahi tha, warna hum aisi cheez banate jo deploy hi nahi hoti.

Do rastay hain:

**Option A — Turn-based voice AI (recommended)**
Existing infra reuse karta hai — bilkul waisay jaisay voice notes already kaam karte hain: customer bolta hai (mic record, jaisa voice note), audio Groq Whisper ko jata hai (text), Groq LLM reply banata hai (wahi `aiAgentTools.js` jo text-chat mein already order le sakta hai), phir TTS audio banta hai aur customer ko wapas bajta hai. Yeh "walkie-talkie" jaisa hai — customer bolta hai, thora ruk ke (~2-4 second) AI jawab deta hai — bilkul us tarah jaisay Google Assistant/Siri se phone pe baat karte hain. **Koi nayi paid infra nahi chahiye**, sab kuch Vercel + Supabase + Groq mein reuse hota hai, aur free rehta hai.
- ✅ Free, deploy-able abhi is hafte
- ✅ 90% existing code reuse (voice note recording, storage, Groq client, order tools)
- ❌ Ek insaan se baat karne jaisa "overlapping/live" feel nahi — thora sa turn-by-turn pause hoga

**Option B — Asal live WebRTC AI (jaisa insaan se baat)**
Isay chalane ke liye ek persistent media server chahiye — ya to khud host karna (VPS pe Node + mediasoup, extra cost + maintenance), ya koi third-party voice-AI platform (LiveKit Agents, Vapi, Retell — in sab ka free tier hai lekin scale pe paid hai, aur yeh sab naya account/naya vendor add karta hai tumhare stack mein).
- ✅ Bilkul real-time, jaisa insaan se live baat
- ❌ Naya paid/managed infra chahiye — Vercel+Supabase-only stack se bahar
- ❌ Zyada complex, zyada maintenance, "free" wala target miss ho sakta hai scale pe

**Mera recommendation: Option A se shuru karo.** Chhoti/medium dukaan ke liye 2-4 second ka turn-gap bilkul acceptable hai (jitna WhatsApp Business bots mein bhi hota hai), aur bilkul free/existing-infra mein ban jata hai. Agar aage chal kar lagay ke customers ko zyada "live" feel chahiye, Option B pe upgrade Phase 4.6+ mein kar saktay hain — yeh ek alag/bigger project hoga.

---

## 4. Phased build order (jaisay hi confirm ho, isi order mein banayenge)

### Phase 4.6a — Foundation
- Migration: `abos_chat_calls` mein `answered_by_ai boolean default false` column
- Nayi table `abos_chat_ai_call_settings` (ek hi row, shop-wide): `enabled`, `tts_provider` (`edge-tts`/`azure`), `voice_ur`, `voice_en`, `ring_timeout_before_ai_seconds`
- Trigger logic: jab koi call `RING_TIMEOUT_MS` tak koi staff member claim na kare, aur `enabled = true` ho, to (voicemail offer ki jagah, ya uske sath ek option ke tor par) AI-answer flow shuru ho
- Sentry wire-up: naye `/api/ai-call-*` endpoints pe error tracking (jab kaam start karein tab hi sahi hoga isay wire karna)

### Phase 4.6b — Voice loop pipeline
- `/api/ai-call-transcribe` — customer ka recorded audio leta hai, Groq Whisper se text banata hai
- `/api/ai-call-respond` — text leta hai, existing `aiAgentTools.js` reuse karke reply + koi order-action banata hai
- `/api/ai-call-speak` — reply text leta hai, edge-tts/Azure se audio banata hai, wapas bhejta hai

### Phase 4.6c — Call UI integration
- `CallScreen.tsx` mein "AI is on the call" state — customer ko pata chale AI bol raha hai (jaisay recording/screen-share ke liye already status-ping banaya hua hai, wahi pattern reuse)
- Mic-active/AI-speaking indicator, "AI is thinking..." state jab tak reply na aaye
- Call log message (`kind: "call"`) mein yeh bhi note ho ke call AI ne answer ki thi

### Phase 4.6d — Voice assistant (ABI) upgrade
- Chhota add-on: `useVoiceOutput.ts` (jo abhi browser Web Speech API use karta hai, jiski quality device pe depend karti hai) ko optionally same edge-tts/Azure endpoint pe switch karna — taake admin assistant ki awaz bhi consistent/behtar ho, chahe kisi bhi phone/browser se sun rahe hon.

### Phase 4.6e — Polish & test
- Rate limiting (call rate-limit function already hai, isay AI-calls ke liye bhi extend karna)
- Manual test checklist: Urdu-only customer, English-only customer, mixed conversation, order placement during AI call

---

## 5. Faisla ho gaya ✅

**Architecture: Option B (real live WebRTC)** — confirmed via **LiveKit Cloud**. Free "Build" tier: 5,000 WebRTC minutes + **1,000 AI Agent minutes/month**, koi card nahi chahiye, kabhi expire nahi hota. LiveKit ka `Agents` framework khaas isi kaam ke liye bana hai — AI ek room mein "participant" ban ke join karta hai aur STT→LLM→TTS pipeline realtime chalata hai (official Groq + Azure plugins dono maujood hain).

**TTS: Azure F0** — `ur-PK-UzmaNeural`/`ur-PK-AsadNeural` (Urdu) + `en-US-JennyNeural` (English), 500K characters/month free, hamesha.

**STT + LLM: Groq** — jo already istemal ho raha hai, Whisper (STT) + Llama 3.3 70B (LLM), sab free-tier mein.

### Phase 4.6a — DONE (2026-08-01)

- ✅ DB migration live apply ki gayi (`execute_sql`/`apply_migration` se verify + apply, verbatim `.sql` file pe nahi, jaisa README warning kehti hai): `abos_chat_ai_call_settings` (singleton settings row, `enabled=false` default — safe), `abos_chat_calls.answered_by_ai` + `.livekit_room` columns.
- ✅ `api/_lib/livekitServer.js` — token/room/dispatch helper
- ✅ `api/_lib/sentryServer.js` — backend error capture (pehle sirf frontend pe tha, README se pata chala)
- ✅ `api/ai-call-connect.js` — call ko AI se connect karne wala main endpoint
- ✅ `api/livekit-token.js` — reconnect/staff-listen-in token endpoint
- ✅ `package.json` + `.env.example` updated
- ✅ `abos-chat-ai-agent/` — separate Python worker skeleton (LiveKit Cloud pe deploy hoga, Vercel pe nahi) + deploy checklist

**Ab tumhare zimme (koi MCP/AI tool yeh nahi kar sakta):** `abos-chat-ai-agent/README.md` mein poora checklist hai — LiveKit Cloud account, Azure Speech account, Sentry DSN, Vercel env vars, aur agent deploy karna.

### Baaki phases (jaise hi setup ho jaye)

- **4.6b** — **BIG DESIGN CHANGE (2026-08-01, `abi-core-main` repo dekhne ke baad):** voice agent apna alag Groq LLM/tool-calling **nahi** rakhega. Iski jagah, transcribed customer speech seedha `abi-core`'s existing `/api/customer-command` ko POST hoga (`sourceApp: "abos-chat-voice"`, customer ka Supabase access token — jo `ai-call-connect.js` ke paas already hai, LiveKit job metadata ke zariye Python agent tak pass hoga), aur jo `reply` wapas aaye wohi TTS se bola jayega. Order-taking/inventory/related-products sab automatically mil jata hai, koi duplicate tool logic nahi likhni — `agent.py` se `groq.LLM(...)` hat jayega, ek chhota custom "LLM plugin" ban jayega jo bas `abi-core` ko HTTP call karta hai (edge-tts wale custom-plugin pattern jaisa hi).
  - `abi-core` khud bhi Vercel serverless hai — is liye woh bhi voice agent ko host nahi kar sakta, sirf iska "brain" (HTTP endpoint) reuse hoga, deployment alag hi rahegi.
- **4.6c** — `CallScreen.tsx`/`CallManager.tsx` mein "AI se baat karein" UI + ring-timeout auto-offer, `abos_chat_ai_call_settings` ke liye ek chhota owner-facing toggle screen
- **4.6d** — ABI (admin voice assistant) ko bhi isi Azure voice pe switch karna, consistency ke liye
- **4.6e** — polish + rate limiting + manual test checklist
