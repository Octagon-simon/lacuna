import type { MemoryEntry } from './types.js'

// Seed content for a brand-new (empty) memory store — see store.ts's seedIfEmpty(). Each entry
// restructures a rule already hand-written and empirically verified (against real tsc output,
// on a real project) in src/agent/prompts/index.ts's detectTypeScriptErrors — this is NOT new
// content, just giving durable, tag-retrievable form to lessons that already exist as reactive,
// error-text-triggered prompt hints. detectTypeScriptErrors itself is untouched: these entries
// are PROACTIVE (shown before any error occurs, via tag-based retrieval in context.ts) while the
// hand-written detectors are REACTIVE (fire on the exact error, with exact line numbers) —
// complementary, not a replacement.
//
// Confidence starts at 0.8 (not the 0.5 a freshly-learned entry gets) because these are already
// verified, not a first guess — see writeback.ts's NEW_ENTRY_CONFIDENCE for the contrast.
export type SeedEntryTemplate = Omit<MemoryEntry, 'created_at' | 'last_used' | 'hit_count'>

const SEED_CONFIDENCE = 0.8

export const SEED_ENTRIES: SeedEntryTemplate[] = [
  {
    id: 'seed-jest-fn-never-type',
    category: 'mocks',
    tags: ['never-type-mock', 'jest'],
    source: 'seed',
    confidence: SEED_CONFIDENCE,
    summary: 'jest.fn() with no type info infers never for its parameter',
    rule: 'A jest.fn() mocking a class instance method via a plain object literal (no type context to infer from) makes .mockResolvedValue()/.mockReturnValue() reject every value with a `never`-type error. Fix by annotating the mock VARIABLE with the jest.Mock<T> interface, not by passing generics to jest.fn() itself — jest.fn()\'s own generic arity varies across @types/jest versions (some accept one function-type argument, others reject it and require 0 or 2), so it is easy to "fix" into a different compile error.',
    example: 'const mockSet: jest.Mock<Promise<string>> = jest.fn(); mockSet.mockResolvedValue("OK");',
  },
  {
    id: 'seed-jest-fn-inline-cast-never',
    category: 'mocks',
    tags: ['never-type-mock', 'jest'],
    source: 'seed',
    confidence: SEED_CONFIDENCE,
    summary: 'Casting an existing auto-mocked import inline can still infer never',
    rule: 'Casting an existing import inline, e.g. (Model.method as jest.Mock).mockResolvedValue(x), can still leave the parameter type as `never` when the real method has a complex/overloaded type (common with ORM model statics) — even though a bare `jest.Mock` cast usually defaults its type params to `any`. Go through `unknown` first and supply the type explicitly.',
    example: '(UserModel.findOne as unknown as jest.Mock<Promise<User | null>>).mockResolvedValue(user);',
  },
  {
    id: 'seed-incomplete-mock-object',
    category: 'mocks',
    tags: ['incomplete-mock', 'jest', 'vitest'],
    source: 'seed',
    confidence: SEED_CONFIDENCE,
    summary: 'Mock object literal missing properties the real interface requires',
    rule: 'A mock object literal passed where a real service/repository-typed parameter is expected needs EVERY property the real interface declares, not just the ones the test happens to use. The compiler truncates long missing-property lists ("and N more") — check the real interface/type definition for the full shape rather than trusting the message is exhaustive.',
  },
  {
    id: 'seed-unsafe-cast-through-unknown',
    category: 'mocks',
    tags: ['unsafe-cast', 'jest', 'vitest'],
    source: 'seed',
    confidence: SEED_CONFIDENCE,
    summary: 'Casting a real, unmocked instance directly to a mock-shaped type fails',
    rule: 'Casting a real (unmocked) instance directly to a mock-shaped type (e.g. a real Queue instance `as { add: jest.Mock }`) fails because the two types share no structural overlap — TypeScript rejects the single `as`. Prefer actually jest.mock()/vi.mock()-ing the module so no cast is needed at all; if that is not possible here, double-cast through `unknown` first.',
    example: '(realQueue as unknown as { add: jest.Mock }).add.mockResolvedValue(job);',
  },
  {
    id: 'seed-wrong-arity-jest-fn',
    category: 'mocks',
    tags: ['wrong-arity-jest-fn', 'jest'],
    source: 'seed',
    confidence: SEED_CONFIDENCE,
    summary: 'jest.fn<...>()\'s own generic arity is version-sensitive across @types/jest',
    rule: 'jest.fn<...>()\'s own generic arity differs across @types/jest releases — some accept a single function-type argument, others reject it and require 0 or 2, so guessing a different argument count just trades one wrong arity for another (TS2743/TS2558). The version-proof fix is to stop passing generics to jest.fn() itself and instead annotate the mock VARIABLE with the jest.Mock<T> interface, where T is the FULL FUNCTION TYPE (not just the return type — a bare return type fails with "does not satisfy the constraint \'FunctionLike\'").',
    example: 'const mock: jest.Mock<() => Promise<string>> = jest.fn();',
  },
  {
    id: 'seed-reserved-word-default-import',
    category: 'mocks',
    tags: ['reserved-word-import', 'typescript'],
    source: 'seed',
    confidence: SEED_CONFIDENCE,
    summary: '`default` cannot be a bare named-import binding',
    rule: '`default` is a reserved word and cannot appear as a bare named binding in `import { default } from \'...\'` — this is a hard parse error that fails the entire file, not just one assertion. Use a real default import, or alias it explicitly.',
    example: 'import def, { __esModule } from \'../module\';  // or: import { __esModule, default as def } from \'../module\';',
  },
  {
    id: 'seed-enum-type-collision',
    category: 'mocks',
    tags: ['enum-collision', 'typescript'],
    source: 'seed',
    confidence: SEED_CONFIDENCE,
    summary: 'Same type name on both sides of an assignment error means two different declarations',
    rule: '"Type \'Foo.Bar\' is not assignable to type \'Foo\'" — the SAME name on both sides — is NOT a wrong enum/union member. TypeScript enums (and some unions) are nominally typed, so a locally re-declared \'Foo\' in the test (shadowing the real one) or an import from the wrong module produces a type that prints identically to the real one yet is structurally incompatible with it. Fix the import/declaration, not the value used.',
  },
  {
    id: 'seed-mock-implementation-signature-narrowing',
    category: 'frameworks',
    tags: ['signature-narrowing', 'jest', 'vitest'],
    source: 'seed',
    confidence: SEED_CONFIDENCE,
    summary: 'A type assertion on mockImplementation() can narrow past the real method signature',
    rule: 'spyOn(...).mockImplementation() already infers the correct parameter/return types from the method being spied on. Adding a type assertion that narrows a parameter versus the real signature (e.g. casting to accept only `number` when the real method accepts `string | number | null`) can only make it WRONG, never more correct — remove the assertion instead of trying to reconcile the two signatures by hand.',
    example: 'jest.spyOn(process, "exit").mockImplementation((() => undefined as never));  // no cast — let it infer',
  },
  {
    id: 'seed-top-level-await',
    category: 'frameworks',
    tags: ['top-level-await', 'typescript'],
    source: 'seed',
    confidence: SEED_CONFIDENCE,
    summary: 'Top-level await (TS1378) is not allowed outside a test body',
    rule: 'Move ALL await calls inside it()/test()/beforeEach()/etc. A bare `const result = await fn()` at the top of a test file (outside any test body) is a hard TS1378 error.',
    example: 'WRONG: const result = await fn();  RIGHT: it("desc", async () => { const result = await fn(); });',
  },
  {
    id: 'seed-systemic-repeated-error',
    category: 'frameworks',
    tags: ['repeated-error-multiple-locations'],
    source: 'seed',
    confidence: SEED_CONFIDENCE,
    summary: 'The same error at multiple locations is one systemic fix, not several',
    rule: 'When the exact same compiler error/message recurs at several distinct line numbers in one file, that is ONE underlying problem repeated, not several unrelated ones — find and fix the shape/cast/pattern at EVERY one of those locations in the same response. Fixing only the first occurrence and stopping wastes the remaining retry budget discovering the rest one at a time. This generalizes across any error type, not just a specific TypeScript error code.',
  },
]
