import type {SessionEntry} from '../types/session.js';

export function createUserEntry(content: string): SessionEntry {
  return {role: 'user', content, timestamp: new Date().toISOString()};
}

export function createAssistantEntry(): SessionEntry {
  return {role: 'assistant', content: '', timestamp: new Date().toISOString(), isStreaming: true};
}

export function createThinkingEntry(): SessionEntry {
  return {role: 'thinking', content: '', isStreaming: true};
}

export function createToolEntry(toolName: string, toolInput: Record<string, unknown>): SessionEntry {
  return {role: 'tool', toolName, toolInput, timestamp: new Date().toISOString()};
}
