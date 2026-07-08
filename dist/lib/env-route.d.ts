import { type DetectedEnvironment } from './detector.js';
export interface NodeRouteOptions {
    enabled?: boolean;
    env: DetectedEnvironment;
}
export declare function routeTestToNodeEnv(absPath: string, cwd: string, opts: NodeRouteOptions): Promise<boolean>;
//# sourceMappingURL=env-route.d.ts.map