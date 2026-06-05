import { Command } from '@oclif/core';
export default class Run extends Command {
    static description: string;
    static examples: string[];
    static flags: {
        verbose: import("@oclif/core/interfaces").BooleanFlag<boolean>;
    };
    run(): Promise<void>;
}
//# sourceMappingURL=run.d.ts.map