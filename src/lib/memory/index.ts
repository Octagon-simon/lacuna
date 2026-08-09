export type { MemoryEntry, FixesEntry, MemoryCategory, MemoryIndex } from './types.js'
export { MemoryEntrySchema, MEMORY_CATEGORIES } from './types.js'
export { globalMemoryRoot } from './paths.js'
export { normalizeErrorSignature, errorSignatureHash } from './normalize.js'
export { readEntry, writeEntry, rebuildIndex, readIndex, deleteEntry, withMemoryLock, seedIfEmpty } from './store.js'
export { SEED_ENTRIES } from './seed-catalog.js'
export { retrieveMemory, renderMemorySection, buildMemoryContext, buildFixMemoryHint, MIN_CONFIDENCE, MAX_ENTRIES } from './retrieve.js'
export type { RetrievalContext, FixMemoryHint } from './retrieve.js'
export { recordTagMatchOutcome, recordFixOutcome } from './writeback.js'
export type { FixOutcomeParams } from './writeback.js'
export {
  detectPatternTags,
  PATTERN_TAGS,
  TAG_NEVER_TYPE_MOCK,
  TAG_INCOMPLETE_MOCK,
  TAG_UNSAFE_CAST,
  TAG_RESERVED_WORD_IMPORT,
  TAG_ENUM_COLLISION,
  TAG_SIGNATURE_NARROWING,
  TAG_WRONG_ARITY_JEST_FN,
  TAG_TOP_LEVEL_AWAIT,
  TAG_REPEATED_ERROR_MULTIPLE_LOCATIONS,
} from './pattern-tags.js'
export type { PatternTag } from './pattern-tags.js'
export {
  decayStore,
  decayEntry,
  needsDecay,
  AGE_DECAY_STEP,
  DECAY_INTERVAL_DAYS,
  recoverEntry,
  needsRecovery,
  RECOVERY_STEP,
  RECOVERY_CEILING,
} from './decay.js'
