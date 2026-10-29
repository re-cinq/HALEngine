import type {SessionEntry} from './session.js';

/** What the engine keeps of a conversation's entries once their content is final (specs/hal-engine-history-controls/spec.md). */
export interface EntryPolicy {
  /** When a turn ends, the newest this many entries keep their content; older ones keep their slot, role and timestamp and are marked `cleared`. */
  maxContentEntries?: number;
  /** Rewrites every entry but a user's once its content is final; a throw or another role stores the entry cleared instead. */
  redactEntry?: (entry: SessionEntry) => SessionEntry;
}
