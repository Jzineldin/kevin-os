/**
 * Shared types for chat UI components.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: Array<{ entity_id: string; name: string }>;
}
