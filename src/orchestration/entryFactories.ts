import type {SessionEntry} from '../types/session.js';

export function createUserEntry(content: string): SessionEntry {
  return {role: 'user', content, timestamp: new Date().toISOString()};
}

// No persona key at all when none is given, so a consumer who never opted in stores no stray field.
export function createAssistantEntry(persona?: string): SessionEntry {
  const entry: SessionEntry = {role: 'assistant', content: '', timestamp: new Date().toISOString(), isStreaming: true};
  return persona === undefined ? entry : {...entry, persona};
}

export function createThinkingEntry(): SessionEntry {
  return {role: 'thinking', content: '', isStreaming: true};
}

export function createToolEntry(toolName: string, toolInput: Record<string, unknown>): SessionEntry {
  return {role: 'tool', toolName, toolInput, timestamp: new Date().toISOString()};
}
