import {
  BridgeError,
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
 * In-memory platform used by unit tests and by the browser preview harness.
 * It is deterministic and has no I/O, so the agent core can be exercised
 * without an Android device.
 */
export class MemoryFs implements FileSystemPort {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();
  private readonly mtimes = new Map<string, number>();

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new BridgeError(`no such file: ${path}`, 'ENOENT');
    return value;
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this.mtimes.set(path, Date.now());
    const parent = path.split('/').slice(0, -1).join('/');
    if (parent) this.dirs.add(parent);
  }
  async append(path: string, content: string): Promise<void> {
    const existing = this.files.get(path) ?? '';
    await this.write(path, existing + content);
  }
  async list(path: string, options: ListOptions = {}): Promise<DirEntry[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const out: DirEntry[] = [];
    const push = (full: string, type: 'file' | 'dir') => {
      const name = full.slice(prefix.length);
      if (!options.recursive && name.includes('/')) return;
      if (options.suffix && type === 'file' && !name.endsWith(options.suffix)) return;
      if (options.includeDirs === false && type === 'dir') return;
      out.push({ name, path: full, type, size: this.files.get(full)?.length ?? 0 });
    };
    for (const dir of this.dirs) if (dir.startsWith(prefix)) push(dir, 'dir');
    for (const file of this.files.keys()) if (file.startsWith(prefix)) push(file, 'file');
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    const max = options.maxEntries ?? 2000;
    return out.slice(0, max);
  }
  async stat(path: string): Promise<FileStat | null> {
    if (this.files.has(path)) {
      return { path, type: 'file', size: this.files.get(path)!.length, mtime: this.mtimes.get(path) ?? 0 };
    }
    if (this.dirs.has(path)) return { path, type: 'dir', size: 0, mtime: 0 };
    return null;
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.dirs.delete(path);
    for (const key of [...this.files.keys()]) if (key.startsWith(`${path}/`)) this.files.delete(key);
    for (const key of [...this.dirs]) if (key.startsWith(`${path}/`)) this.dirs.delete(key);
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }
  /** Test helper: every file currently held. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }
}

export class MemorySecrets implements SecretPort {
  private readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class MemoryKv implements KeyValuePort {
  private readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async keys(prefix = ''): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export interface MemoryPlatformOptions {
  /** Deterministic clock for tests. */
  clock?: () => number;
  /** Canned command results keyed by the joined command. */
  execHandler?: (command: string[]) => ExecResult;
  /** Canned HTTP responses. */
  httpHandler?: (request: HttpRequest) => HttpResponse;
}

/**
 * A scripted command runner. It deliberately does NOT execute anything: on
 * Android there is no shell, and in tests we assert on the command that the
 * agent *tried* to run.
 */
export function createMemoryPlatform(options: MemoryPlatformOptions = {}): Platform & {
  fs: MemoryFs;
  secrets: MemorySecrets;
  kv: MemoryKv;
  execLog: string[][];
  notifications: { title: string; body: string }[];
  httpLog: HttpRequest[];
  installedApks: string[];
} {
  const fs = new MemoryFs();
  const execLog: string[][] = [];
  const notifications: { title: string; body: string }[] = [];
  const httpLog: HttpRequest[] = [];
  const installedApks: string[] = [];
  const clock = options.clock ?? (() => Date.now());
  return {
    name: 'memory',
    fs,
    secrets: new MemorySecrets(),
    kv: new MemoryKv(),
    execLog,
    notifications,
    httpLog,
    installedApks,
    async exec(command: string[], _opts?: ExecOptions): Promise<ExecResult> {
      execLog.push(command);
      if (options.execHandler) return options.execHandler(command);
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    async http(request: HttpRequest): Promise<HttpResponse> {
      httpLog.push(request);
      if (options.httpHandler) return options.httpHandler(request);
      return { status: 200, headers: {}, body: '' };
    },
    async notify(title: string, body: string) {
      notifications.push({ title, body });
    },
    async installApk(path: string) {
      installedApks.push(path);
    },
    now: clock,
  };
}
