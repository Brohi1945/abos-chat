export type Role = "customer" | "owner" | "agent";

export interface Profile {
  id: string;
  customer_number: string;
  name: string | null;
  email: string | null;
  role: Role;
  created_at: string;
}

export type ConversationStatus = "open" | "pending" | "resolved" | "urgent";

export interface Conversation {
  id: string;
  customer_id: string;
  created_at: string;
  last_message_at: string;
  ai_mode: boolean;
  status: ConversationStatus;
  tags: string[];
  customer_last_read_at: string | null;
  owner_last_read_at: string | null;
  // joined in on the owner's inbox view
  customer?: Profile;
}

/** One row from the abos_chat_owner_inbox() / abos_chat_search_conversations()
 *  RPCs — a conversation with its customer info and unread count already
 *  computed server-side. */
export interface OwnerInboxRow {
  id: string;
  customer_id: string;
  ai_mode: boolean;
  status: ConversationStatus;
  tags: string[];
  last_message_at: string;
  customer_last_read_at: string | null;
  owner_last_read_at: string | null;
  customer_number: string;
  customer_name: string | null;
  customer_email: string | null;
  unread_count: number;
}

export type MessageKind = "text" | "image" | "location" | "voice" | "product" | "call" | "order";

export type CallKind = "voice" | "video";
export type CallStatus = "ringing" | "active" | "ended" | "missed" | "declined";

export interface Call {
  id: string;
  conversation_id: string;
  caller_id: string;
  caller_role: "customer" | "owner";
  answered_by: string | null;
  kind: CallKind;
  status: CallStatus;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
}

/** Snapshot of a product at the moment it was sent as a card — not a
 *  live reference, so price/stock shown stays accurate to what the
 *  customer was actually told even if the product changes later. */
export interface ProductSnapshot {
  id: string;
  name: string;
  price: number;
  stock: number;
  category: string | null;
}

/** A single line item inside an AI-placed order — snapshotted at
 *  confirm time (same pattern as ProductSnapshot). */
export interface OrderItem {
  product_id: string;
  name: string;
  price: number;
  quantity: number;
}

/** Rendered as a rich "order confirmed" card in the chat once the AI
 *  agent finalizes an order via the confirm_order tool. */
export interface OrderSnapshot {
  order_id: string;
  items: OrderItem[];
  total: number;
  status: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_role: "customer" | "owner";
  kind: MessageKind;
  body: string | null;
  media_url: string | null;
  lat: number | null;
  lng: number | null;
  is_ai: boolean;
  product_snapshot: ProductSnapshot | null;
  order_snapshot: OrderSnapshot | null;
  // Snapshot of who on the store side actually sent this (owner vs a
  // named agent) — null for customer messages and for AI replies.
  sender_name: string | null;
  sender_title: "Owner" | "Agent" | null;
  broadcast_id: string | null;
  call_id: string | null;
  created_at: string;
}

/** A single ABOS order, as returned by /api/customer-orders. */
export interface LinkedOrder {
  id: string;
  customer: string | null;
  items: unknown;
  total: number;
  status: string | null;
  date: string | null;
  channel: string | null;
  payment_status: string | null;
}
