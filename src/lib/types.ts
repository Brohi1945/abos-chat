export interface Profile {
  id: string;
  customer_number: string;
  name: string | null;
  email: string | null;
  role: "customer" | "owner";
  created_at: string;
}

export interface Conversation {
  id: string;
  customer_id: string;
  created_at: string;
  last_message_at: string;
  ai_mode: boolean;
  customer_last_read_at: string | null;
  owner_last_read_at: string | null;
  // joined in on the owner's inbox view
  customer?: Profile;
}

/** One row from the abos_chat_owner_inbox() RPC — a conversation with
 *  its customer info and unread count already computed server-side. */
export interface OwnerInboxRow {
  id: string;
  customer_id: string;
  ai_mode: boolean;
  last_message_at: string;
  customer_last_read_at: string | null;
  owner_last_read_at: string | null;
  customer_number: string;
  customer_name: string | null;
  customer_email: string | null;
  unread_count: number;
}

export type MessageKind = "text" | "image" | "location" | "voice" | "product";

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
