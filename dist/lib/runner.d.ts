export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
    timedOut?: boolean;
    /** The run was killed by an external AbortSignal (the embedder "Stop"). NOT a test failure —
     * callers must bail, never treat the empty/partial output as a failure to "fix". */
    aborted?: boolean;
}
export declare function runCommand(command: string, cwd?: string, timeoutMs?: number, onLine?: (line: string) => void, signal?: AbortSignal): Promise<RunResult>;
//# sourceMappingURL=runner.d.ts.map