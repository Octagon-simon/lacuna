export declare class StreamingFileViewer {
    private readonly filename;
    private content;
    private rendered;
    private tick;
    private timer;
    readonly isTTY: boolean;
    constructor(filename: string);
    start(): void;
    append(token: string): void;
    stop(): void;
    private render;
}
//# sourceMappingURL=streaming-viewer.d.ts.map