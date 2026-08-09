interface ProjectMeta {
    isReact: boolean;
    isReactNative: boolean;
    isExpo: boolean;
    isNextJs: boolean;
    isTypeScript: boolean;
    isVue: boolean;
    isAngular: boolean;
    isSvelte: boolean;
    isNestJs: boolean;
}
export declare function readProjectMeta(cwd: string): Promise<ProjectMeta>;
export declare function findProjectRoot(startDir: string): Promise<string>;
export declare function ensureTestRunnerSetup(runner: string, sourceDir: string, cwd: string, log: (msg: string) => void, yes?: boolean, confirmInstall?: (message: string) => Promise<boolean>): Promise<string | undefined>;
export interface ScaffoldOptions {
    cwd: string;
    /**
     * Runner to scaffold. Omit (or pass '' / 'auto') to auto-detect — mirrors the settings panel's
     * "(auto-detect)" option, which writes no `testRunner` to .lacuna.json. When auto-detecting we
     * probe the project and fall back to vitest for a JS/TS project so the scaffold NEVER silently
     * no-ops the way it did when a missing runner short-circuited the whole flow.
     */
    runner?: string;
    sourceDir: string;
    /** Sink for progress lines (defaults to console.log). npm-install output streams via stdio:inherit regardless. */
    log?: (msg: string) => void;
}
/**
 * Install deps + scaffold runner config/setup files for `runner` under `cwd` — the whole
 * `init --scaffold-only` side-effect, callable in-process. Never writes .lacuna.json (the caller
 * owns config). Non-interactive: install prompts are auto-accepted. When `runner` is omitted it is
 * auto-detected (see resolveRunner); a resolved non-Node runner (pytest, go, …) is a no-op here.
 */
export declare function scaffoldProject(opts: ScaffoldOptions): Promise<{
    createdSetupFile?: string;
    runner: string;
}>;
export {};
//# sourceMappingURL=scaffold.d.ts.map