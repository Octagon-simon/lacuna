export interface RenderVocab {
    text: string[];
    testIds: string[];
    placeholders: string[];
    labels: string[];
    roles: string[];
}
/**
 * Extract rendered text, testIDs, placeholders, accessibility labels and roles from JSX source.
 * Deliberately conservative — single-line literal captures only, dynamic `{expr}` content skipped.
 */
export declare function extractRenderedStrings(sourceCode: string): RenderVocab;
/**
 * Build a compact "COMPONENT RENDERS" prompt section, or null if the source renders nothing
 * assertable (non-component files). Grounds getBy* assertions in the real render output.
 */
export declare function buildRenderVocabSection(sourceCode: string | null | undefined): string | null;
//# sourceMappingURL=render-vocab.d.ts.map