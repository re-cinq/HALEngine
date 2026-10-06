import type {ChatSession} from '../../types/session.js';
import type {SessionStore} from '../../types/sessionStore.js';

// The interface as it shipped before any optional member existed, so each new one is held to leaving it satisfied.
export const fiveMemberStore: SessionStore = {
  create: (sessionId, userId): ChatSession => ({sessionId, userId, entries: []}),
  get: () => undefined,
  delete: () => false,
  count: () => 0,
  clear: () => undefined,
};
