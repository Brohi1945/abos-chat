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

export type MessageKind = "text" | "image" | "location" | "voice";

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
  created_at: string;
}
