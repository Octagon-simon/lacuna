import { Command } from '@oclif/core';
export default class Fix extends Command {
    static description: string;
    static examples: string[];
    static flags: {
        'dry-run': import("@oclif/core/interfaces").BooleanFlag<boolean>;
        file: import("@oclif/core/interfaces").OptionFlag<string | undefined, import("@oclif/core/interfaces").CustomOptions>;
        verbose: import("@oclif/core/interfaces").BooleanFlag<boolean>;
        model: import("@oclif/core/interfaces").OptionFlag<string | undefined, import("@oclif/core/interfaces").CustomOptions>;
        workers: import("@oclif/core/interfaces").OptionFlag<number, import("@oclif/core/interfaces").CustomOptions>;
        fresh: import("@oclif/core/interfaces").BooleanFlag<boolean>;
        'regenerate-on-failure': import("@oclif/core/interfaces").BooleanFlag<boolean>;
        'fix-polluters': import("@oclif/core/interfaces").BooleanFlag<boolean>;
    };
    run(): Promise<void>;
}
//# sourceMappingURL=fix.d.ts.map