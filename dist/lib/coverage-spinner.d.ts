export interface CoverageSpinner {
    onLine: (line: string) => void;
    stop: () => void;
}
export declare function startCoverageSpinner(label: string, runner?: string): CoverageSpinner;
//# sourceMappingURL=coverage-spinner.d.ts.map