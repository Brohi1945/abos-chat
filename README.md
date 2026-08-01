# abos-chat-ai-agent — Phase 4.6a setup checklist

Yeh chhota Python worker ABOS Chat repo ka **hissa nahi hai** — alag se deploy hota hai (LiveKit Cloud par), kyunke Vercel serverless functions ek call ki poori duration tak zinda nahi reh saktay. Baaki sab kuch (DB, Vercel API endpoints) already `abos-chat` repo mein add ho chuka hai.

## Status (2026-08-01)

- ✅ LiveKit Cloud account + API key — **ho gaya**
- ⏸️ Azure Speech — verification mein masla, **abhi ke liye skip**. Agent **edge-tts** use kar raha hai (Asad ki voice, `ur-PK-AsadNeural`) — zero setup, free, koi key nahi chahiye. Awaz bilkul same hai (dono Microsoft ke hi neural voices hain), bas edge-tts unofficial hai. Jab Azure sort ho jaye to `agent.py` mein 2-line switch hai (comment kiya hua block).
- ⏳ Baaki neeche checklist follow karo

## Jo kaam sirf tum khud kar saktay ho (koi bhi MCP/AI tool yeh nahi kar sakta)

### 1. LiveKit Cloud — ✅ done
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` tumhare paas already hain.
**Ab yeh teeno Vercel project (`abos-chat`) → Settings → Environment Variables mein add karo** — yeh step abhi baaki hai, koi MCP tool Vercel env vars set nahi kar sakta, dashboard se khud karna hoga.

### 2. Azure Speech — ⏸️ deferred, koi jaldi nahi
Jab verification theek ho jaye, tab: https://portal.azure.com par "Speech service" resource banao (F0 tier, free), **Keys and Endpoint** se key + region le lena — sirf agent worker ko chahiye hoga (Vercel ko nahi).

### 3. Sentry DSN (agar abhi tak `.env` mein nahi hai)
1. https://abos-u1.sentry.io → project `abos-chat` → Settings → Client Keys (DSN)
2. Vercel mein `VITE_SENTRY_DSN` aur `SENTRY_DSN` (dono same value) add karo

### 4. Vercel env vars (`abos-chat` project mein add karo)
```
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
SENTRY_DSN=https://...
VITE_SENTRY_DSN=https://...
```
(`.env.example` file mein already sab documented hai. Azure vars abhi Vercel mein nahi chahiye — woh sirf agent worker ke `.env` mein jayenge, jab Azure use karoge.)

### 5. Agent worker deploy karna
Yeh Python service hai, Vercel pe nahi jayegi — LiveKit Cloud khud isay host kar sakta hai (koi apna VPS nahi chahiye):

```bash
pip install -r requirements.txt
# .env file banao is folder mein:
#   LIVEKIT_URL=...
#   LIVEKIT_API_KEY=...
#   LIVEKIT_API_SECRET=...
#   GROQ_API_KEY=...            (wahi jo abos-chat already use karta hai)
# (AZURE_SPEECH_KEY / AZURE_SPEECH_REGION abhi zaroori nahi — edge-tts key nahi mangta)

# LiveKit CLI install (agar nahi hai):
curl -sSL https://get.livekit.io/cli | bash
lk cloud auth   # apna LiveKit Cloud account se login karo

# Local test (apne dev machine se):
python agent.py dev

# Production deploy (LiveKit Cloud pe hosted, hamesha chalta rahega):
lk agent deploy
```

**Zaroori:** deploy karne se pehle ek dafa `docs.livekit.io/agents/start/voice-ai/` khol ke dekh lena — `agent.py` mein comment mein likha hai kyun (SDK tezi se update hoti hai, class names kabhi kabhi badal jati hain).

## Jab yeh sab ho jaye, mujhe bata dena

Phir hum:
- `abos_chat_ai_call_settings.enabled` ko `true` karenge (abhi `false` hai — safe default)
- Phase 4.6b: order-taking tools + customer memory is voice agent mein wire karenge
- Phase 4.6c: `CallScreen.tsx`/`CallManager.tsx` mein "AI se baat karein" button aur ring-timeout auto-offer add karenge
- (Jab bhi chaho) Azure switch-back — sirf `agent.py` ke comment kiye hue block ko uncomment karna hoga
