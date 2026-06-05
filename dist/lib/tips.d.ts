export interface TipContext {
    workers: number;
    targetFile?: string;
    verbose: boolean;
    dryRun: boolean;
    fresh?: boolean;
    model: string;
    threshold: number;
    mocksFile?: string;
    ignore?: string[];
    command?: 'generate' | 'fix';
}
export declare function getActiveTips(ctx: TipContext): string[];
export declare function createTipRotator(tips: string[]): () => string | null;
export declare function formatTip(text: string): string;
//# sourceMappingURL=tips.d.ts.map