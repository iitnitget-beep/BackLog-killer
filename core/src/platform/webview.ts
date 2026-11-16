import {
  type DirEntry,
  type ExecOptions,
  type ExecResult,
  type FileStat,
  type FileSystemPort,
  type HttpRequest,
  type HttpResponse,
  type KeyValuePort,
  type ListOptions,
  type Platform,
  type SecretPort,
} from './types';

/**
 * The bridge object injected by the Kotlin shell
 * (`ForgeXBridge`, added with addJavascriptInterface). Every method is async on
 * the JS side but synchronous string-returning on the native side, so all calls
 * are wrapped in a promise and JSON-decoded here.
 *
 * Contract (must match ForgeXBridge.kt):
 *   fsRead(path): string
 *   fsWrite(path, content): void
 *   fsAppend(path, content): void
 *   fsList(path, optionsJson): DirEntry[]
 *   fsStat(path): FileStat | null
 *   fsRemove(path): void
 *   fsMkdir(path): void
 *   fsExists(path): boolean
 *   exec(commandJson, cwd, timeoutMs): ExecResult
 *   http(requestJson): HttpResponse
 *   secretGet(key): string | null
 *   secretSet(key, value): void
 *   secretDelete(key): void
 *   kvGet(key): string | null
 *   kvSet(key, value): void
 *   kvKeys(prefix): string[]
 *   kvDelete(key): void
 *   notify(title, body): void
 *   installApk(path): void
 *   now(): number
 */
export interface NativeBridge {
  fsRead(path: string): string;
  fsWrite(path: string, content: string): void;
  fsAppend(path: string, content: string): void;
  fsList(path: string, optionsJson: string): string;
  fsStat(path: string): string;
  fsRemove(path: string): void;
  fsMkdir(path: string): void;
  fsExists(path: string): boolean;
  exec(commandJson: string, cwd: string, timeoutMs: number): string;
  http(requestJson: string): string;
  secretGet(key: string): string | null;
  secretSet(key: string, value: string): void;
  secretDelete(key: string): void;
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  kvKeys(prefix: string): string;
  kvDelete(key: string): void;
  notify(title: string, body: string): void;
  installApk(path: string): void;
  now(): number;
}

/** Calls that can block (network, process) are allowed to take longer. */
async function call<T>(fn: () => string | T): Promise<T> {
  try {
    const value = fn();
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export function createWebViewPlatform(bridge: NativeBridge): Platform {
  const fs: FileSystemPort = {
    read: (p) => call<string>(() => bridge.fsRead(p)),
    write: async (p, content) => void bridge.fsWrite(p, content),
    append: async (p, content) => void bridge.fsAppend(p, content),
    list: (p, options: ListOptions = {}) => call<DirEntry[]>(() => bridge.fsList(p, JSON.stringify(options))),
    stat: (p) => call<FileStat | null>(() => bridge.fsStat(p)),
    remove: async (p) => void bridge.fsRemove(p),
    mkdir: async (p) => void bridge.fsMkdir(p),
    exists: async (p) => Boolean(bridge.fsExists(p)),
  };
  const secrets: SecretPort = {
    get: async (key) => bridge.secretGet(key),
    set: async (key, value) => void bridge.secretSet(key, value),
    delete: async (key) => void bridge.secretDelete(key),
  };
  const kv: KeyValuePort = {
    get: async (key) => bridge.kvGet(key),
    set: async (key, value) => void bridge.kvSet(key, value),
    keys: (prefix = '') => call<string[]>(() => bridge.kvKeys(prefix)),
    delete: async (key) => void bridge.kvDelete(key),
  };
  return {
    name: 'android',
    fs,
    secrets,
    kv,
    exec: (command: string[], options: ExecOptions = {}) =>
      call<ExecResult>(() => bridge.exec(JSON.stringify(command), options.cwd ?? '', options.timeoutMs ?? 300_000)),
    http: (request: HttpRequest) => call<HttpResponse>(() => bridge.http(JSON.stringify(request))),
    notify: async (title, body) => void bridge.notify(title, body),
    installApk: async (path) => void bridge.installApk(path),
    now: () => bridge.now(),
  };
}
