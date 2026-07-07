import { type DetectedEnvironment } from './detector.js';
export interface FormatOptions {
    enabled?: boolean;
    env?: DetectedEnvironment;
}
export declare function formatFile(absPath: string, cwd: string, opts?: FormatOptions): Promise<void>;
//# sourceMappingURL=format.d.ts.map