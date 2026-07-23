// ============================================================
//  src/lib/types.ts
//  Complete Types — Phase 1 to 7
// ============================================================

export type Role = "customer" | "owner" | "agent";

export interface Profile {
  id: string;
  customer_number: string;
  name: string | null;
  email: string | null;
  role: Role;
  created_at: string;
  // Phase 6: Call waiting
  on_call?: boolean;
  current_call_id?: string | null;
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
}

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

export type MessageKind =
  | "text"
  | "image"
  | "location"
  | "voice"
  | "product"
  | "call"
  | "order";

export type CallKind = "voice" | "video";

// Phase 6: Added 'waiting' status
export type CallStatus =
  | "ringing"
  | "active"
  | "ended"
  | "missed"
  | "declined"
  | "waiting";

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

export interface ProductSnapshot {
  id: string;
  name: string;
  price: number;
  stock: number;
  category: string | null;
}

export interface OrderItem {
  product_id: string;
  name: string;
  price: number;
  quantity: number;
}

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
  sender_name: string | null;
  sender_title: "Owner" | "Agent" | null;
  broadcast_id: string | null;
  call_id: string | null;
  created_at: string;
  // Phase 5: Read receipt
  read_at: string | null;
  delivery_status: "sent" | "delivered" | "read" | "failed";
}

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
