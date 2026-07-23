import React, { useState } from "react";
import { MessageCircle, Loader2 } from "lucide-react";
import { signUp, signIn } from "../lib/chatApi";
import ThemeSwitcher from "../components/ThemeSwitcher";

interface AuthScreenProps {
  onAuthed: () => void;
}

export default function AuthScreen({ onAuthed }: AuthScreenProps) {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    if (mode === "signup") {
      const { error } = await signUp(email, password, name);
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
    } else {
      const { error } = await signIn(email, password);
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
    }
    setLoading(false);
    onAuthed();
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-slate-950">
      <div className="fixed top-4 right-4">
        <ThemeSwitcher compact />
      </div>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-brand flex items-center justify-center mb-3">
            <MessageCircle size={26} className="text-white" />
          </div>
          <h1 className="text-xl font-bold">ABOS Chat</h1>
          <p className="text-sm text-slate-400 mt-1">
            {mode === "signup" ? "Account bana kar apna unique number pao" : "Apne account mein login karo"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 bg-slate-900 border border-slate-800 rounded-2xl p-5">
          {mode === "signup" && (
            <div>
              <label className="text-xs font-semibold text-slate-400">Naam</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full mt-1 px-3 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-brand/50"
                placeholder="e.g. Ayesha Khan"
              />
            </div>
          )}
          <div>
            <label className="text-xs font-semibold text-slate-400">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full mt-1 px-3 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-brand/50"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-400">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full mt-1 px-3 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-brand/50"
              placeholder="Kam se kam 6 characters"
            />
          </div>

          {error && <div className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-xl bg-brand text-white text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {mode === "signup" ? "Account banao" : "Login karo"}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === "signup" ? "login" : "signup")}
          className="w-full text-center text-xs text-slate-400 mt-4"
        >
          {mode === "signup" ? "Pehle se account hai? Login karo" : "Naya account banana hai? Signup karo"}
        </button>
      </div>
    </div>
  );
}
