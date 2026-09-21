export interface PatternTag {
    tag: string;
    test: (errorOutput: string) => boolean;
}
export declare const TAG_NEVER_TYPE_MOCK = "never-type-mock";
export declare const TAG_INCOMPLETE_MOCK = "incomplete-mock";
export declare const TAG_UNSAFE_CAST = "unsafe-cast";
export declare const TAG_RESERVED_WORD_IMPORT = "reserved-word-import";
export declare const TAG_ENUM_COLLISION = "enum-collision";
export declare const TAG_SIGNATURE_NARROWING = "signature-narrowing";
export declare const TAG_WRONG_ARITY_JEST_FN = "wrong-arity-jest-fn";
export declare const TAG_TOP_LEVEL_AWAIT = "top-level-await";
export declare const TAG_REPEATED_ERROR_MULTIPLE_LOCATIONS = "repeated-error-multiple-locations";
export declare const PATTERN_TAGS: PatternTag[];
export declare function detectPatternTags(errorOutput: string): string[];
//# sourceMappingURL=pattern-tags.d.ts.map