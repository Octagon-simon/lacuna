export type LacunaEvent = {
    type: 'memory-used';
    file: string;
    entries: string[];
};
export type LacunaEventHandler = (event: LacunaEvent) => void;
//# sourceMappingURL=events.d.ts.map