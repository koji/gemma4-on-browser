import type { ChatMessage } from '../types';

const MAX_RECENT_MESSAGES = 10;
const MAX_ASSISTANT_REPEAT_RATIO = 0.35;

function normalize(text: string) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function looksCorruptedAssistantMessage(message: ChatMessage) {
  if (message.role !== 'assistant') {
    return false;
  }

  const normalized = normalize(message.content);
  if (!normalized) {
    return false;
  }

  if (
    normalized.includes('<start_of_turn>') ||
    normalized.includes('<end_of_turn>') ||
    normalized.includes('start_of_turn') ||
    normalized.includes('end_of_turn')
  ) {
    return true;
  }

  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length < 12) {
    return false;
  }

  const suspiciousTokens = ['hello', 'user', 'model', 'assistant', 'google'];
  const suspiciousCount = tokens.filter((token) => suspiciousTokens.includes(token)).length;
  return suspiciousCount / tokens.length > MAX_ASSISTANT_REPEAT_RATIO;
}

export function sanitizeConversationHistory(messages: ChatMessage[]) {
  return messages.filter((message) => !looksCorruptedAssistantMessage(message));
}

export function buildConversationSummary(messages: ChatMessage[]) {
  const sanitized = sanitizeConversationHistory(messages);
  if (sanitized.length <= MAX_RECENT_MESSAGES) {
    return '';
  }

  const olderMessages = sanitized.slice(0, -MAX_RECENT_MESSAGES);

  const lines = olderMessages.slice(-8).map((message) => {
    const content = message.content.replace(/\s+/g, ' ').slice(0, 180);
    return `${message.role}: ${content}`;
  });

  return `Previous context summary:\n${lines.join('\n')}`;
}

export function selectPromptMessages(messages: ChatMessage[]) {
  return sanitizeConversationHistory(messages).slice(-MAX_RECENT_MESSAGES);
}
