// ============================================================
//  src/components/MessageBubble.tsx
//  Complete Message Bubble — Phase 1 to 8
//  - Read receipts (Phase 5) with a real "Seen at HH:MM" (Phase 8)
//  - Reply/quote, edit, soft-delete, pin, reactions (Phase 8)
// ============================================================

import React, { useState } from "react";
import {
  MapPin,
  ExternalLink,
  Check,
  CheckCheck,
  Package,
  Phone,
  Video,
  PhoneMissed,
  ShoppingBag,
  Clock,
  Pin,
  Reply as ReplyIcon,
  Pencil,
  Trash2,
  SmilePlus,
  Copy,
  Ban,
} from "lucide-react";
import { ChatMessage, MessageReaction } from "../lib/types";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

interface MessageBubbleProps {
  message: ChatMessage;
  isMine: boolean;
  isRead?: boolean;
  // Phase 8
  showSeenLabel?: boolean;
  reactions?: MessageReaction[];
  myUserId?: string;
  repliedMessage?: ChatMessage | null;
  isActive?: boolean;
  onToggleActive?: () => void;
  onReply?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onTogglePin?: () => void;
  onReact?: (emoji: string) => void;
  onJumpToReply?: (messageId: string) => void;
}

function mapsEmbedUrl(lat: number, lng: number) {
  return `https://www.google.com/maps?q=${lat},${lng}&output=embed`;
}

function mapsSearchUrl(lat: number, lng: number) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function getDeliveryIcon(status: string) {
  switch (status) {
    case 'read':
      return <CheckCheck size={13} className="text-accent" />;
    case 'delivered':
      return <CheckCheck size={13} className="text-muted" />;
    case 'sent':
      return <Check size={13} className="text-muted" />;
    case 'failed':
      return <Clock size={13} className="text-danger" />;
    default:
      return <Check size={13} className="text-muted" />;
  }
}

function replyPreviewText(m: ChatMessage): string {
  if (m.deleted_at) return "Message deleted";
  switch (m.kind) {
    case "text":
      return m.body || "";
    case "image":
      return m.body ? `📷 ${m.body}` : "📷 Photo";
    case "voice":
      return "🎤 Voice note";
    case "location":
      return "📍 Location";
    case "product":
      return `📦 ${m.product_snapshot?.name || "Product"}`;
    case "order":
      return `🛍️ Order ${m.order_snapshot?.order_id || ""}`;
    case "call":
      return m.body || "Call";
    default:
      return m.body || "Message";
  }
}

export default function MessageBubble({
  message,
  isMine,
  isRead,
  showSeenLabel,
  reactions = [],
  myUserId,
  repliedMessage,
  isActive,
  onToggleActive,
  onReply,
  onEdit,
  onDelete,
  onTogglePin,
  onReact,
  onJumpToReply,
}: MessageBubbleProps) {
  const [showEmojiRow, setShowEmojiRow] = useState(false);
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const seenTime = message.read_at
    ? new Date(message.read_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  const isDeleted = !!message.deleted_at;
  const canEdit = isMine && !isDeleted && message.kind === "text";
  const canDelete = isMine && !isDeleted;
  const canReply = !isDeleted && message.kind !== "call";
  const canReact = !isDeleted && message.kind !== "call";
  const canPin = !isDeleted && message.kind !== "call";

  // Group reactions by emoji -> list of user ids, so multiple staff
  // reacting with the same emoji collapse into one pill with a count.
  const grouped = reactions.reduce<Record<string, MessageReaction[]>>((acc, r) => {
    (acc[r.emoji] = acc[r.emoji] || []).push(r);
    return acc;
  }, {});
  const myReaction = myUserId ? reactions.find((r) => r.user_id === myUserId) : undefined;

  if (message.kind === "call") {
    const missed = (message.body || "").toLowerCase().includes("missed") || (message.body || "").toLowerCase().includes("declined");
    const isVideoCall = (message.body || "").toLowerCase().includes("video");
    const Icon = missed ? PhoneMissed : isVideoCall ? Video : Phone;
    return (
      <div className="flex justify-center my-1">
        <div
          className={`flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-full ${
            missed ? "bg-danger/10 text-danger" : "bg-surface text-muted"
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
    <div id={`msg-${message.id}`} className={`flex flex-col ${isMine ? "items-end" : "items-start"} mb-1`}>
      {message.pinned_at && (
        <div className={`flex items-center gap-1 mb-0.5 text-[10px] text-muted ${isMine ? "mr-1" : "ml-1"}`}>
          <Pin size={10} className="text-brand" />
          Pinned
        </div>
      )}

      <div className={`flex ${isMine ? "justify-end" : "justify-start"} group`}>
        <div
          onClick={onToggleActive}
          className={`max-w-[85%] sm:max-w-[78%] rounded-2xl overflow-hidden cursor-pointer ${
            isMine ? "bg-brand text-white rounded-br-md" : "bg-surface text-fg rounded-bl-md"
          }`}
        >
          {!isMine && message.sender_name && (
            <div className="px-3.5 pt-2 text-[10px] font-semibold text-muted flex items-center gap-1">
              {message.sender_name}
              {message.sender_title && (
                <span className="text-[9px] font-bold uppercase tracking-wide text-brand">
                  · {message.sender_title}
                </span>
              )}
            </div>
          )}

          {/* Phase 8: reply/quote preview */}
          {message.reply_to_id && !isDeleted && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onJumpToReply?.(message.reply_to_id as string);
              }}
              className={`w-full text-left mx-3.5 mt-2 mb-0.5 px-2 py-1.5 rounded-lg border-l-2 truncate text-[11px] ${
                isMine
                  ? "bg-white/10 border-white/50 text-white/85"
                  : "bg-fg/5 border-brand/60 text-muted"
              }`}
            >
              {repliedMessage ? replyPreviewText(repliedMessage) : "Original message"}
            </button>
          )}

          {isDeleted ? (
            <div
              className={`px-3.5 pt-2.5 pb-1 text-sm italic flex items-center gap-1.5 ${
                isMine ? "text-white/70" : "text-muted"
              }`}
            >
              <Ban size={13} />
              This message was deleted
            </div>
          ) : (
            <>
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
                    onClick={(e) => e.stopPropagation()}
                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium ${
                      isMine ? "text-white/90" : "text-brand"
                    }`}
                  >
                    <MapPin size={12} />
                    <span className="truncate">Location shared</span>
                    <ExternalLink size={11} className="ml-auto shrink-0" />
                  </a>
                </div>
              )}

              {message.kind === "product" && message.product_snapshot && (
                <div className="w-full max-w-[240px]">
                  <div className="flex items-center gap-2 px-3.5 pt-2.5">
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
                        <div className={`text-[10px] truncate ${isMine ? "text-white/70" : "text-muted"}`}>
                          {message.product_snapshot.category}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="px-3.5 pt-2 pb-2.5 flex items-center justify-between text-xs">
                    <span className="font-semibold">Rs {message.product_snapshot.price}</span>
                    <span className={isMine ? "text-white/80" : "text-muted"}>
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
                        isMine ? "bg-white/20" : "bg-success/20 text-success"
                      }`}
                    >
                      <ShoppingBag size={16} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">Order {message.order_snapshot.order_id}</div>
                      <div className={`text-[10px] ${isMine ? "text-white/70" : "text-muted"}`}>
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
            </>
          )}

          <div
            className={`px-3.5 pb-1.5 text-[10px] flex items-center justify-end gap-1 ${
              isMine ? "text-white/70" : "text-muted"
            }`}
          >
            {message.edited_at && !isDeleted && <span className="italic opacity-80">edited</span>}
            <span>{time}</span>
            {isMine && (
              <div className="flex items-center gap-0.5">
                {/* isRead comes from the conversation's live last-read timestamp
                    (real-time, via subscribeToConversation) — it's the one
                    signal that actually updates. delivery_status is only ever
                    'sent' (set once at insert, never updated after), so it's
                    used purely as a fallback for the 'failed' state. */}
                {isRead
                  ? <CheckCheck size={13} className="text-accent" />
                  : getDeliveryIcon(message.delivery_status || 'sent')}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Phase 8: "Seen at HH:MM" — shown only under the latest read message,
          not repeated under every bubble (matches iMessage/WhatsApp-info style) */}
      {isMine && isRead && seenTime && showSeenLabel && (
        <div className={`text-[10px] text-muted mt-0.5 ${isMine ? "mr-1" : "ml-1"}`}>Seen {seenTime}</div>
      )}

      {/* Phase 8: reaction pills */}
      {Object.keys(grouped).length > 0 && (
        <div className={`flex flex-wrap gap-1 mt-1 ${isMine ? "justify-end mr-1" : "justify-start ml-1"}`}>
          {Object.entries(grouped).map(([emoji, list]) => (
            <button
              key={emoji}
              onClick={() => onReact?.(emoji)}
              className={`text-[11px] px-1.5 py-0.5 rounded-full border flex items-center gap-1 ${
                myUserId && list.some((r) => r.user_id === myUserId)
                  ? "bg-brand/15 border-brand/40 text-brand"
                  : "bg-surface border-fg/10 text-muted"
              }`}
            >
              <span>{emoji}</span>
              {list.length > 1 && <span>{list.length}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Phase 8: action row — only shown for the tapped/"active" message */}
      {isActive && !isDeleted && (
        <div className={`flex items-center gap-1 mt-1.5 ${isMine ? "mr-1" : "ml-1"}`}>
          {canReact && (
            <button
              onClick={() => setShowEmojiRow((v) => !v)}
              className="w-7 h-7 rounded-full flex items-center justify-center bg-fg/5 text-muted hover:bg-fg/10"
              title="React"
            >
              <SmilePlus size={13} />
            </button>
          )}
          {canReply && (
            <button
              onClick={onReply}
              className="w-7 h-7 rounded-full flex items-center justify-center bg-fg/5 text-muted hover:bg-fg/10"
              title="Reply"
            >
              <ReplyIcon size={13} />
            </button>
          )}
          {message.kind === "text" && message.body && (
            <button
              onClick={() => navigator.clipboard.writeText(message.body || "")}
              className="w-7 h-7 rounded-full flex items-center justify-center bg-fg/5 text-muted hover:bg-fg/10"
              title="Copy"
            >
              <Copy size={13} />
            </button>
          )}
          {canEdit && (
            <button
              onClick={onEdit}
              className="w-7 h-7 rounded-full flex items-center justify-center bg-fg/5 text-muted hover:bg-fg/10"
              title="Edit"
            >
              <Pencil size={13} />
            </button>
          )}
          {canPin && (
            <button
              onClick={onTogglePin}
              className={`w-7 h-7 rounded-full flex items-center justify-center hover:bg-fg/10 ${
                message.pinned_at ? "bg-brand/15 text-brand" : "bg-fg/5 text-muted"
              }`}
              title={message.pinned_at ? "Unpin" : "Pin"}
            >
              <Pin size={13} />
            </button>
          )}
          {canDelete && (
            <button
              onClick={onDelete}
              className="w-7 h-7 rounded-full flex items-center justify-center bg-danger/10 text-danger hover:bg-danger/20"
              title="Delete"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      )}

      {isActive && showEmojiRow && (
        <div className={`flex items-center gap-1 mt-1 bg-surface border rounded-full px-2 py-1 ${isMine ? "mr-1" : "ml-1"}`}>
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => {
                onReact?.(emoji);
                setShowEmojiRow(false);
              }}
              className={`text-base leading-none w-7 h-7 rounded-full flex items-center justify-center hover:bg-fg/10 ${
                myReaction?.emoji === emoji ? "bg-brand/15" : ""
              }`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
