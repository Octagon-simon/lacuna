import { Command } from '@oclif/core';
export default class Memory extends Command {
    static description: string;
    static examples: string[];
    static args: {
        action: import("@oclif/core/interfaces").Arg<string, Record<string, unknown>>;
        target: import("@oclif/core/interfaces").Arg<string | undefined, Record<string, unknown>>;
        target2: import("@oclif/core/interfaces").Arg<string | undefined, Record<string, unknown>>;
    };
    static flags: {
        category: import("@oclif/core/interfaces").OptionFlag<string | undefined, import("@oclif/core/interfaces").CustomOptions>;
        tag: import("@oclif/core/interfaces").OptionFlag<string | undefined, import("@oclif/core/interfaces").CustomOptions>;
        json: import("@oclif/core/interfaces").BooleanFlag<boolean>;
        yes: import("@oclif/core/interfaces").BooleanFlag<boolean>;
    };
    run(): Promise<void>;
    private requireTarget;
    private findEntry;
    private allEntries;
    private list;
    private stats;
    private show;
    private delete;
    private clear;
    private supersede;
    private decay;
}
//# sourceMappingURL=memory.d.ts.map