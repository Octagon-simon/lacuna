export type WorkerState = {
    phase: 'idle';
} | {
    phase: 'generating';
    file: string;
} | {
    phase: 'writing';
    file: string;
} | {
    phase: 'running';
    file: string;
} | {
    phase: 'retrying';
    file: string;
    attempt: number;
    max: number;
} | {
    phase: 'regenerating';
    file: string;
} | {
    phase: 'passed';
    file: string;
} | {
    phase: 'failed';
    file: string;
};
export declare class WorkerDisplay {
    private states;
    private done;
    private passed;
    private failedCount;
    readonly total: number;
    private rendered;
    private tick;
    private timer;
    readonly isTTY: boolean;
    private tips;
    private tipIndex;
    private successLabel;
    constructor(workerCount: number, total: number, tips?: string[], successLabel?: string);
    start(): void;
    update(workerId: number, state: WorkerState): void;
    finish(): void;
    private render;
    private formatRow;
    private plainLabel;
}
//# sourceMappingURL=worker-display.d.ts.map