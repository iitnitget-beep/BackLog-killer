/** Node-only entry point: core plus the Node platform used by tests and CLI. */
export * from './index';
export { createNodePlatform } from './platform/node';
export type { NodePlatformOptions } from './platform/node';
