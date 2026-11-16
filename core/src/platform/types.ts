/**
 * Platform bridge contract.
 *
 * The agent core never touches host APIs directly. Everything that is
 * device-specific (files, processes, network, secrets, notifications, APK
 * install, durable storage) goes through a `Platform` implementation:
 *
 *  - `createWebViewPlatform()`  -> real Android device, forwarded to Kotlin
 *  - `createNodePlatform()`     -> tests / desktop harness
 *  - `createMemoryPlatform()`   -> fast deterministic unit tests
 *
 * Keeping this interface small is deliberate: the Kotlin side stays thin and
 * auditable, and every security-sensitive boundary (path traversal, command
 * allowlist, secret storage) is enforced twice - once in TypeScript so it is
 * unit-testable, once natively so a bug here cannot escape the app sandbox.
 */

export type EntryType = 'file' | 'dir';

export interface DirEntry {
  name: string;
  path: string;
  type: EntryType;
  size: number;
}

export interface FileStat {
  path: string;
  type: EntryType;
  size: number;
  mtime: number;
}

export interface ListOptions {
  recursive?: boolean;
  maxEntries?: number;
  /** Glob-ish suffix filter, e.g. ".kt" */
  suffix?: string;
  includeDirs?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** true when the process was killed by the timeout */
  timedOut: boolean;
}

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface FileSystemPort {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  list(path: string, options?: ListOptions): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat | null>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface SecretPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Durable key/value store used for the event log and resumable run state. */
export interface KeyValuePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface Platform {
  readonly name: 'android' | 'node' | 'memory';
  readonly fs: FileSystemPort;
  readonly secrets: SecretPort;
  readonly kv: KeyValuePort;
  exec(command: string[], options?: ExecOptions): Promise<ExecResult>;
  http(request: HttpRequest): Promise<HttpResponse>;
  notify(title: string, body: string): Promise<void>;
  /** Install a downloaded APK through the platform installer intent. */
  installApk(absolutePath: string): Promise<void>;
  now(): number;
}

export class BridgeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** Normalises a workspace-relative path and rejects escapes. */
export function safePath(root: string, relative: string): string {
  const cleaned = relative.replace(/\\/g, '/').trim();
  if (cleaned.length === 0) return root;
  if (cleaned.startsWith('/')) {
    throw new BridgeError(`absolute paths are not allowed in the workspace: ${relative}`, 'EPATH');
  }
  const parts: string[] = [];
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) {
        throw new BridgeError(`path escapes the workspace: ${relative}`, 'EPATH');
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join('/');
  return joined.length === 0 ? root : `${root}/${joined}`;
}
