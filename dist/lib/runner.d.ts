export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
    timedOut?: boolean;
}
export declare function runCommand(command: string, cwd?: string, timeoutMs?: number, onLine?: (line: string) => void): Promise<RunResult>;
//# sourceMappingURL=runner.d.ts.map