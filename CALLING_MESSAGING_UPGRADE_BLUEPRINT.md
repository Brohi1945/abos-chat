# ABOS Chat — Calling & Messaging Upgrade Blueprint
**Maqsad:** Secure, fast-connecting, HD, lambi-duration calling — WhatsApp jaisa ya usse behtar. Full code audit ke baad likha gaya hai (koi generic advice nahi — har point exact file/function se link hai).

---

## 1. Pehle: Ab Kya Hai (Current State Audit)

Maine yeh files check kiye: `src/lib/webrtc.ts`, `src/lib/callApi.ts`, `src/components/CallManager.tsx`, `CallScreen.tsx`, `IncomingCallBanner.tsx`, `supabase/migration_phase5_calling.sql`.

**Achi baatein (already solid):**
- Signaling design sahi hai — Supabase Realtime Broadcast se offer/answer/ICE relay hota hai, DB ko touch nahi karta. Yeh industry-standard pattern hai.
- `abos_chat_calls` table + RLS policies theek se likhi hui hain — sirf conversation ke participants read/write kar sakte hain.
- Ringtone + vibration **already implemented** hai (`IncomingCallBanner.tsx` — Web Audio ring-ring pattern + `navigator.vibrate`). Yeh acha kaam hai, isay dobara banane ki zaroorat nahi.
- Audio ke liye echo cancellation / noise suppression / auto-gain already on hai (`webrtc.ts` line 41-45).
- Multi-agent "claim call" race-safe hai (`claimCall` — pehla jo answer kare wahi jeetay).

**Kami / Gaps (yehi cheezein WhatsApp se peechay rakhti hain):**

| # | Masla | File | Impact |
|---|-------|------|--------|
| 1 | **TURN server bilkul nahi hai** — sirf 2 Google STUN servers | `webrtc.ts` line 10-13 | Sabse bara masla. Pakistan mein Jazz/Zong/Telenor/Ufone jaise carriers "carrier-grade NAT" use karte hain — STUN-only setup aksar unke beech call connect hi nahi hone deta, ya connect hone mein bohat time leta hai. Yehi "call slow uthna / fail hona" ka #1 reason hai. |
| 2 | Koi ICE restart / reconnection logic nahi | `CallManager.tsx` | Agar wifi se mobile data pe switch ho, ya signal 2-3 second ke liye jaye, call turant mar jati hai — dobara connect nahi hoti. |
| 3 | Video resolution/quality uncontrolled | `webrtc.ts` line 39-47 | Sirf `facingMode: "user"` set hai — koi resolution/frame-rate target nahi. Matlab "HD" ka koi guarantee nahi, browser jo default de dega wahi chalega (kabhi 480p, kabhi kam). |
| 4 | Koi bitrate control nahi | — | Na video ko max bitrate cap hai, na audio codec tuning — weak network pe stutter ya buffering ho sakti hai. |
| 5 | Screen Wake Lock nahi | `CallManager.tsx` | Lambi call mein screen sleep ho sakti hai, jo mic/camera ko rok deti hai — "call duration lamba" ki demand ke khilaf jaata hai. |
| 6 | Call quality monitoring nahi | — | Koi "weak connection" warning ya auto-adjust nahi hota. |
| 7 | Signaling channel per koi Realtime Authorization nahi | Supabase project | Security gap — koi bhi signed-in user, agar kisi tarah `callId` jaan le, us specific call ke signaling channel mein broadcast bhej sakta hai. Chhota risk hai (UUID guess karna mushkil) lekin "secure calling" ke liye yeh close karna chahiye. |
| 8 | Incoming call sirf tab open hone par kaam karta hai | `CallManager.tsx` notifyIncoming | App fully band ho ya phone screen off/locked ho (browser suspend ho jaye), toh call bilkul ring nahi karegi — yeh sabse bara "WhatsApp jaisa nahi" wala gap hai (neeche Section 4 mein poora explain kiya hai). |
| 9 | Per-message delivered/read receipt nahi (sirf conversation-level) | `types.ts`, schema | WhatsApp ke single/double/blue tick jaisa kuch nahi — sirf `owner_last_read_at`/`customer_last_read_at` hai poori conversation ke liye. |
| 10 | Message send fail hone par retry/queue nahi | `chatApi.ts` sendMessage | Agar net thora sa flake kare, message silently fail ho jata hai (sirf console.error) — user ko pata bhi nahi chalta. |

---

## 2. Blueprint — Phased Changes

### 🥇 Phase 1 — Connectivity & Speed (sabse zyada impact, pehle karna hai)

**1.1 TURN Server add karna**
Yeh sab se important single change hai. Bina TURN ke "HD/fast calling" ka baqi sara kaam bhi be-asar rahega agar call connect hi na ho.

Options (aapke workflow — mobile-only, no terminal — ko dekhte hue):
- ✅ **metered.ca** — recommended. Free tier 50GB/month, sirf ek API key chahiye, koi server manage nahi karna. Sign-up web se, no terminal.
- ✅ **Twilio Network Traversal Service** — reliable, pay-as-you-go, time-limited credentials built-in.
- ❌ Self-hosted `coturn` — sasta hota hai lekin VPS SSH access chahiye, jo aapke mobile-only workflow ke sath fit nahi baithta. Skip karein.

Change: `webrtc.ts` mein `ICE_SERVERS` array mein TURN entry add hogi (urls + username + credential), fetched via env var ya ek chota `/api/turn-credentials` endpoint (agar time-limited credentials chahiye ho, jo zyada secure hai — Phase 5.2 dekhein).

**1.2 ICE Restart / Auto-Reconnect**
`CallManager.tsx` mein `pc.oniceconnectionstatechange` listener add hoga: agar state `"disconnected"` ho jaye, 2-3 second wait karke `pc.restartIce()` call hoga aur naya offer/answer exchange hoga signaling channel pe — bina call screen band kiye. Isse network hiccup ya wifi↔mobile-data switch pe call zinda rahegi.

---

### 🥈 Phase 2 — HD Audio/Video Quality

**2.1 Explicit resolution constraints**
`getLocalStream()` mein video ke liye `width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 30}` set karna — plus ek "Data Saver" toggle jo weak network pe 480p pe switch kar de (Pakistan mein mobile data speed/cost dono matter karte hain).

**2.2 Bitrate control**
`RTCRtpSender.getParameters()/setParameters()` se max bitrate cap set karna:
- Video: ~1.5–2.5 Mbps (720p ke liye kaafi hai, na zyada data khaye na quality gire)
- Audio: Opus ~32-64kbps mono (voice ke liye best), 128kbps agar stereo/music-quality chahiye

**2.3 Audio codec tuning (HD Voice)**
SDP mein Opus ke sath `useinbandfec=1` (packet-loss resilience — patchy mobile network pe awaz nahi tootegi) explicitly set karna.

**2.4 Video codec preference**
H.264 ko prefer karna jahan available ho — zyada tar Android phones mein hardware-accelerated hai, matlab smooth video + kam battery drain.

---

### 🥉 Phase 3 — Lambi Duration & Stability

**3.1 Screen Wake Lock**
`navigator.wakeLock.request('screen')` jab call active ho — screen sleep nahi hogi, call bech mein nahi katega.

**3.2 Media Session API**
Call ko OS-level media controls mein dikhana (Android pe proper "on call" indicator), jisse browser call ko utna aggressively background mein suspend nahi karta.

**3.3 Quality monitoring (halka version)**
`pc.getStats()` ko har few second poll karke agar packet loss/jitter zyada ho, ek chhota "Connection weak" badge dikhana — user ko pata chale, achanak drop na ho.

---

### 🔐 Phase 4 — Security Hardening

**4.1 Realtime Authorization on signaling channel**
Supabase ki "Realtime Authorization" (RLS-backed private channels) enable karna taake `call-signal-{callId}` channel sirf usi call ke do verified participants ke liye accessible ho — abhi koi bhi authenticated user technically join kar sakta hai agar callId pata ho.

**4.2 Time-limited TURN credentials**
Static shared TURN secret ki bajaye per-call short-TTL credentials issue karna (ek chota serverless endpoint jo service-role se signed credential banaye) — industry best practice.

**4.3 Confirm end-to-end media encryption**
WebRTC by default DTLS-SRTP se media encrypt karta hai — yeh already secure hai, koi code change nahi chahiye, sirf documentation/confirmation ke liye note kiya.

**4.4 Call spam rate-limit**
`createCall()` pe simple check — ek customer ek minute mein X se zyada ringing calls create na kar sake (abuse prevention).

---

## 3. ⚠️ Reality Check — "Bilkul WhatsApp Jaisa" Kahan Rukta Hai

Yeh section honestly batana zaroori hai, taake expectations sahi rahein.

WhatsApp calls **tab bhi ring hoti hain jab app poori tarah band ho** — kyunke woh native app hai aur:
- **Android** pe: FCM **high-priority push** + full-screen intent + `ConnectionService` use karta hai (phone ki normal calling UI jaisi ring aati hai, app khula na bhi ho)
- **iOS** pe: **PushKit VoIP push** + **CallKit** use karta hai

**ABOS Chat ek web app/PWA hai** — yeh dono native mechanisms browser se access nahi ho sakte. Abhi jo system hai (Supabase Realtime + browser Notification API) **sirf tab tak kaam karta hai jab tak app/tab kam se kam background mein zinda ho** — agar phone ne app ko poori tarah kill kar diya ya browser bohat der se suspend ho gaya, call ring nahi karegi.

**Do raastay hain:**

- **Phase 4a (Web-only, realistic improvement):** Web Push API + Service Worker add karna. Android Chrome pe yeh kaafi acha kaam karta hai — app band ho tab bhi push notification aa sakti hai jo tap karke call answer ho. iOS Safari pe bhi (16.4+) support hai lekin utna reliable nahi jitna Android — full-screen "ringing" UI possible nahi, sirf normal notification tap-to-open flow milega.
- **Phase 4b (Bigger project, future roadmap):** App ko native wrapper (jaise Capacitor) mein daal kar asli FCM/VoIP push + CallKit/ConnectionService integrate karna — yeh tabhi "bilkul WhatsApp jaisa" (killed-state se bhi ring) milega, lekin yeh alag, bara project hai (App Store/Play Store listing bhi chahiye hogi).

**Meri recommendation:** Phase 1-3 (connectivity, quality, duration) pehle karein — yeh sab pure web/PWA ke andar rehte hue solid improvement dete hain. Phase 4a (Web Push) agla realistic step hai. Phase 4b sirf tab sochein jab aap native app route pe jana chahein.

---

## 4. Messaging Improvements (WhatsApp-style polish)

1. **Per-message read receipt** — abhi sirf conversation-level `*_last_read_at` hai. Halka version: message timestamp ko last-read timestamp se compare karke "seen" dikhana (koi schema change nahi). Full version: har message pe `read_at` column (WhatsApp jaisa double-tick, zyada precise, thora zyada DB writes).
2. **Send retry + local queue** — `sendMessage()` abhi fail hone par sirf console.error karta hai. Isay optimistic-send + auto-retry banana, taake flaky connection pe message chupke se na gire.
3. **Offline queueing** — Service Worker + local storage se, offline type kiya hua message net wapis aate hi apne aap chala jaye.
4. **Media upload progress** — voice notes/images ke liye upload % dikhana, bare files ke liye resumable upload.

---

## 5. Suggested Build Order (aapke ek-file-per-commit workflow ke hisaab se)

1. **Realtime Authorization fix** (Phase 4.1) — foundational, low-risk, pehle karein
2. **TURN server integration** (Phase 1.1) — sabse bara impact, isay jaldi karein
3. **ICE restart/reconnect logic** (Phase 1.2) — `CallManager.tsx`
4. **HD media constraints + bitrate** (Phase 2) — `webrtc.ts` + `CallManager.tsx`
5. **Wake Lock** (Phase 3.1) — chota, safe change
6. **Messaging reliability** (Section 4) — independent track, kabhi bhi parallel kar sakte hain
7. **Web Push for calls** (Phase 4a) — bara mini-project: naya service worker, VAPID keys, subscription table, push-sending endpoint
8. **Native wrapper** (Phase 4b) — sirf future roadmap item, abhi nahi

---

## 6. Agla Qadam

Main is blueprint ke Phase 1 se shuru kar sakta hoon — TURN provider (metered.ca recommend karta hoon) sign-up karke uski API key mujhe dein, phir main:
- `webrtc.ts` update karta hoon (TURN + ICE restart)
- Exact files batata hoon jo replace/create karni hain, GitHub mobile se upload karne ke liye

Batayein kis phase se shuru karna hai — ya sab phases ek sath sequence mein chalayein?
