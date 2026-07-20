import React from "react";
import { MapPin, ExternalLink, Check, CheckCheck } from "lucide-react";
import { ChatMessage } from "../lib/types";

interface MessageBubbleProps {
  message: ChatMessage;
  isMine: boolean;
  // Only meaningful when isMine is true — has the OTHER side read this yet?
  isRead?: boolean;
}

function mapsEmbedUrl(lat: number, lng: number) {
  return `https://www.google.com/maps?q=${lat},${lng}&output=embed`;
}
function mapsSearchUrl(lat: number, lng: number) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

export default function MessageBubble({ message, isMine, isRead }: MessageBubbleProps) {
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={`flex ${isMine ? "justify-end" : "justify-start"} mb-2.5`}>
      <div
        className={`max-w-[85%] sm:max-w-[78%] rounded-2xl overflow-hidden ${
          isMine ? "bg-brand text-white rounded-br-md" : "bg-slate-800 text-slate-100 rounded-bl-md"
        }`}
      >
        {message.kind === "text" && (
          <div className="px-3.5 pt-2.5 pb-1 text-sm whitespace-pre-wrap break-words">
            {message.is_ai && (
              <span
                className={`inline-block text-[9px] font-bold uppercase tracking-wide mb-1 px-1.5 py-0.5 rounded ${
                  isMine ? "bg-white/20" : "bg-brand/20 text-brand"
                }`}
              >
                AI
              </span>
            )}
            <div>{message.body}</div>
          </div>
        )}

        {message.kind === "image" && message.media_url && (
          <div>
            <img
              src={message.media_url}
              alt="Shared"
              className="max-w-full max-h-60 sm:max-h-72 object-cover"
              loading="lazy"
            />
            {message.body && <div className="px-3.5 py-2 text-sm">{message.body}</div>}
          </div>
        )}

        {message.kind === "voice" && message.media_url && (
          <div className="px-3.5 py-2.5">
            <audio src={message.media_url} controls className="w-full max-w-[220px]" />
          </div>
        )}

        {message.kind === "location" && message.lat != null && message.lng != null && (
          <div className="w-full">
            <div className="w-full max-w-[260px] sm:max-w-[220px]">
              <iframe
                title="Shared location"
                src={mapsEmbedUrl(message.lat, message.lng)}
                className="w-full h-36 sm:h-[140px] border-0 block"
                loading="lazy"
              />
            </div>
            <a
              href={mapsSearchUrl(message.lat, message.lng)}
              target="_blank"
              rel="noreferrer"
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium ${
                isMine ? "text-white/90" : "text-brand"
              }`}
            >
              <MapPin size={12} />
              <span className="truncate">Live location</span>
              <ExternalLink size={11} className="ml-auto shrink-0" />
            </a>
          </div>
        )}

        <div
          className={`px-3.5 pb-1.5 text-[10px] flex items-center justify-end gap-1 ${
            isMine ? "text-white/70" : "text-slate-500"
          }`}
        >
          <span>{time}</span>
          {isMine &&
            (isRead ? (
              <CheckCheck size={13} className="text-sky-300" />
            ) : (
              <Check size={13} className={isMine ? "text-white/70" : "text-slate-500"} />
            ))}
        </div>
      </div>
    </div>
  );
}
