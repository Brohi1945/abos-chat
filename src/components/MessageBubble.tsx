import React from "react";
import { MapPin, ExternalLink } from "lucide-react";
import { ChatMessage } from "../lib/types";

interface MessageBubbleProps {
  message: ChatMessage;
  isMine: boolean;
}

function mapsEmbedUrl(lat: number, lng: number) {
  return `https://www.google.com/maps?q=${lat},${lng}&output=embed`;
}
function mapsSearchUrl(lat: number, lng: number) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

export default function MessageBubble({ message, isMine }: MessageBubbleProps) {
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={`flex ${isMine ? "justify-end" : "justify-start"} mb-2.5`}>
      <div
        className={`max-w-[78%] rounded-2xl overflow-hidden ${
          isMine ? "bg-brand text-white rounded-br-md" : "bg-slate-800 text-slate-100 rounded-bl-md"
        }`}
      >
        {message.kind === "text" && (
          <div className="px-3.5 pt-2.5 pb-1 text-sm whitespace-pre-wrap break-words">
            {message.is_ai && (
              <span className={`inline-block text-[9px] font-bold uppercase tracking-wide mb-1 px-1.5 py-0.5 rounded ${isMine ? "bg-white/20" : "bg-brand/20 text-brand"}`}>
                AI
              </span>
            )}
            <div>{message.body}</div>
          </div>
        )}

        {message.kind === "image" && message.media_url && (
          <div>
            <img src={message.media_url} alt="Shared" className="max-w-full max-h-72 object-cover" />
            {message.body && <div className="px-3.5 py-2 text-sm">{message.body}</div>}
          </div>
        )}

        {message.kind === "voice" && message.media_url && (
          <div className="px-3.5 py-2.5">
            <audio src={message.media_url} controls className="max-w-[220px]" />
          </div>
        )}

        {message.kind === "location" && message.lat != null && message.lng != null && (
          <div>
            <iframe
              title="Shared location"
              src={mapsEmbedUrl(message.lat, message.lng)}
              width="220"
              height="140"
              style={{ border: 0, display: "block" }}
              loading="lazy"
            />
            <a
              href={mapsSearchUrl(message.lat, message.lng)}
              target="_blank"
              rel="noreferrer"
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium ${isMine ? "text-white/90" : "text-brand"}`}
            >
              <MapPin size={12} />
              Live location
              <ExternalLink size={11} className="ml-auto" />
            </a>
          </div>
        )}

        <div className={`px-3.5 pb-1.5 text-[10px] ${isMine ? "text-white/70" : "text-slate-500"} text-right`}>{time}</div>
      </div>
    </div>
  );
}
