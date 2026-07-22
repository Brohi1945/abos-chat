import React from "react";
import { MapPin, ExternalLink, Check, CheckCheck, Package, Phone, Video, PhoneMissed, ShoppingBag } from "lucide-react";
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

  if (message.kind === "call") {
    const missed = (message.body || "").toLowerCase().includes("missed") || (message.body || "").toLowerCase().includes("declined");
    const isVideoCall = (message.body || "").toLowerCase().includes("video");
    const Icon = missed ? PhoneMissed : isVideoCall ? Video : Phone;
    return (
      <div className="flex justify-center my-1">
        <div
          className={`flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-full ${
            missed ? "bg-red-500/10 text-red-300" : "bg-slate-800 text-slate-400"
          }`}
        >
          <Icon size={12} />
          {message.body}
          <span className="opacity-60">· {time}</span>
        </div>
      </div>
    );
  }


  return (
    <div className={`flex ${isMine ? "justify-end" : "justify-start"} mb-2.5`}>
      <div
        className={`max-w-[85%] sm:max-w-[78%] rounded-2xl overflow-hidden ${
          isMine ? "bg-brand text-white rounded-br-md" : "bg-slate-800 text-slate-100 rounded-bl-md"
        }`}
      >
        {!isMine && message.sender_name && (
          <div className="px-3.5 pt-2 text-[10px] font-semibold text-slate-400 flex items-center gap-1">
            {message.sender_name}
            {message.sender_title && (
              <span className="text-[9px] font-bold uppercase tracking-wide text-brand">
                · {message.sender_title}
              </span>
            )}
          </div>
        )}

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
              {/* This is a one-time location share, not a live-updating
                  position — worded accordingly so it doesn't imply
                  ongoing tracking that isn't actually happening. */}
              <span className="truncate">Location shared</span>
              <ExternalLink size={11} className="ml-auto shrink-0" />
            </a>
          </div>
        )}

        {message.kind === "product" && message.product_snapshot && (
          <div className={`w-full max-w-[240px] ${isMine ? "" : ""}`}>
            <div className={`flex items-center gap-2 px-3.5 pt-2.5 ${isMine ? "" : ""}`}>
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                  isMine ? "bg-white/20" : "bg-brand/20 text-brand"
                }`}
              >
                <Package size={16} />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{message.product_snapshot.name}</div>
                {message.product_snapshot.category && (
                  <div className={`text-[10px] truncate ${isMine ? "text-white/70" : "text-slate-400"}`}>
                    {message.product_snapshot.category}
                  </div>
                )}
              </div>
            </div>
            <div className="px-3.5 pt-2 pb-2.5 flex items-center justify-between text-xs">
              <span className="font-semibold">Rs {message.product_snapshot.price}</span>
              <span className={isMine ? "text-white/80" : "text-slate-400"}>
                {message.product_snapshot.stock > 0
                  ? `${message.product_snapshot.stock} in stock`
                  : "Out of stock"}
              </span>
            </div>
            {message.body && <div className="px-3.5 pb-2.5 text-sm">{message.body}</div>}
          </div>
        )}

        {message.kind === "order" && message.order_snapshot && (
          <div className="w-full max-w-[260px]">
            <div className="flex items-center gap-2 px-3.5 pt-2.5">
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                  isMine ? "bg-white/20" : "bg-emerald-500/20 text-emerald-400"
                }`}
              >
                <ShoppingBag size={16} />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold">Order {message.order_snapshot.order_id}</div>
                <div className={`text-[10px] ${isMine ? "text-white/70" : "text-slate-400"}`}>
                  {message.order_snapshot.status === "pending"
                    ? "Confirmed · pending fulfillment"
                    : message.order_snapshot.status}
                </div>
              </div>
            </div>
            <div className="px-3.5 pt-2 pb-1 space-y-0.5">
              {message.order_snapshot.items.map((item, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="truncate">
                    {item.quantity}x {item.name}
                  </span>
                  <span className="shrink-0 ml-2">Rs {item.price * item.quantity}</span>
                </div>
              ))}
            </div>
            <div className="px-3.5 pb-2.5 pt-1 border-t border-white/10 flex justify-between text-xs font-semibold">
              <span>Total</span>
              <span>Rs {message.order_snapshot.total}</span>
            </div>
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
