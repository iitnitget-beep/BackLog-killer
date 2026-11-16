import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
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
 * Node platform. Used by the test suite, the CLI harness and desktop previews.
 * Secrets land in a local file so behaviour matches the Keystore-backed
 * Android implementation (explicit set/get/delete, no env leakage).
 */
export class NodeFs implements FileSystemPort {
  /** Absolute, normalised workspace root; all sandbox checks are relative to it. */
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Resolves a path to an absolute location inside the sandbox.
   *
   * Callers pass a mix of three forms, all of which must work:
   *   1. absolute paths inside the root  (what list() returns)
   *   2. the root itself, however it was originally spelled ("." or "./out/ws")
   *   3. workspace-relative paths        ("app/Main.kt")
   * Getting this wrong is a sandbox bug, not a cosmetic one, so the order is
   * explicit: exact/spelled-root match, then absolute, then relative.
   */
  private resolve(p: string): string {
    const normalRoot = this.root;
    const spelled = path.resolve(p);
    if (spelled === normalRoot || path.resolve(path.join(normalRoot, p)) === normalRoot) {
      return normalRoot;
    }
    const normalFull = path.isAbsolute(p) ? path.resolve(p) : path.resolve(path.join(normalRoot, p));
    if (normalFull !== normalRoot && !normalFull.startsWith(`${normalRoot}${path.sep}`)) {
      throw new BridgeError(`path escapes root: ${p}`, 'EPATH');
    }
    return normalFull;
  }

  async read(p: string): Promise<string> {
    return fs.readFile(this.resolve(p), 'utf8');
  }
  async write(p: string, content: string): Promise<void> {
    const target = this.resolve(p);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  async append(p: string, content: string): Promise<void> {
    const target = this.resolve(p);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, content, 'utf8');
  }
  async list(p: string, options: ListOptions = {}): Promise<DirEntry[]> {
    const target = this.resolve(p);
    const out: DirEntry[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.resolve(dir, entry.name);
        if (entry.isDirectory()) {
          // A suffix filter is a file filter: directories never match ".kt".
          if (options.includeDirs !== false && !options.suffix) {
            out.push({ name: path.relative(target, full), path: full, type: 'dir', size: 0 });
          }
          if (options.recursive) await walk(full);
        } else {
          if (options.suffix && !entry.name.endsWith(options.suffix)) continue;
          const stat = await fs.stat(full);
          out.push({ name: path.relative(target, full), path: full, type: 'file', size: stat.size });
        }
      }
    };
    await walk(target);
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return out.slice(0, options.maxEntries ?? 5000);
  }
  async stat(p: string): Promise<FileStat | null> {
    try {
      const target = this.resolve(p);
      const s = await fs.stat(target);
      return { path: target, type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs };
    } catch {
      return null;
    }
  }
  async remove(p: string): Promise<void> {
    await fs.rm(this.resolve(p), { recursive: true, force: true });
  }
  async mkdir(p: string): Promise<void> {
    await fs.mkdir(this.resolve(p), { recursive: true });
  }
  async exists(p: string): Promise<boolean> {
    return (await this.stat(p)) !== null;
  }
}

class NodeSecrets implements SecretPort {
  private cache: Map<string, string> | null = null;
  constructor(private readonly file: string) {}
  private async load(): Promise<Map<string, string>> {
    if (this.cache) return this.cache;
    try {
      this.cache = new Map(Object.entries(JSON.parse(await fs.readFile(this.file, 'utf8'))));
    } catch {
      this.cache = new Map();
    }
    return this.cache;
  }
  private async flush(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(Object.fromEntries(this.cache ?? new Map())), 'utf8');
    await fs.chmod(this.file, 0o600).catch(() => undefined);
  }
  async get(key: string): Promise<string | null> {
    return (await this.load()).get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    (await this.load()).set(key, value);
    await this.flush();
  }
  async delete(key: string): Promise<void> {
    (await this.load()).delete(key);
    await this.flush();
  }
}

class NodeKv implements KeyValuePort {
  constructor(private readonly dir: string) {}
  private file(key: string): string {
    return path.join(this.dir, `${encodeURIComponent(key)}.json`);
  }
  async get(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.file(key), 'utf8');
    } catch {
      return null;
    }
  }
  async set(key: string, value: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(key), value, 'utf8');
  }
  async keys(prefix = ''): Promise<string[]> {
    try {
      const names = await fs.readdir(this.dir);
      return names
        .filter((n) => n.endsWith('.json'))
        .map((n) => decodeURIComponent(n.slice(0, -5)))
        .filter((k) => k.startsWith(prefix))
        .sort();
    } catch {
      return [];
    }
  }
  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
}

export interface NodePlatformOptions {
  workspaceRoot: string;
  dataDir: string;
  /** Allowlist of executables. Anything else is refused. */
  allowedCommands?: string[];
}

/**
 * Executes commands with an allowlist and a hard timeout. Command arrays (not
 * shell strings) are used everywhere so the agent cannot smuggle `&& rm -rf`.
 */
export function createNodePlatform(options: NodePlatformOptions): Platform {
  const allowed = new Set(
    options.allowedCommands ?? [
      'node',
      'npm',
      'npx',
      'git',
      'ls',
      'cat',
      'echo',
      'gradle',
      'gradlew',
      'sh',
      'bash',
      'python3',
      'yarn',
      'pnpm',
    ],
  );
  return {
    name: 'node',
    fs: new NodeFs(options.workspaceRoot),
    secrets: new NodeSecrets(path.join(options.dataDir, 'secrets.json')),
    kv: new NodeKv(path.join(options.dataDir, 'kv')),
    async exec(command: string[], execOptions: ExecOptions = {}): Promise<ExecResult> {
      const bin = command[0];
      if (!bin) throw new BridgeError('empty command', 'ECMD');
      const base = path.basename(bin);
      if (!allowed.has(base)) {
        throw new BridgeError(`command not allowed: ${base}`, 'ECMD');
      }
      const cwd = execOptions.cwd ?? options.workspaceRoot;
      const timeoutMs = execOptions.timeoutMs ?? 120_000;
      return new Promise<ExecResult>((resolve, reject) => {
        const child = spawn(bin, command.slice(1), {
          cwd,
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', (chunk) => (stdout += String(chunk)));
        child.stderr.on('data', (chunk) => (stderr += String(chunk)));
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr, timedOut });
        });
      });
    },
    async http(request: HttpRequest): Promise<HttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000);
      try {
        const response = await fetch(request.url, {
          method: request.method ?? 'GET',
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => (headers[key] = value));
        return { status: response.status, headers, body: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    },
    async notify(title: string, body: string): Promise<void> {
      console.log(`[notify] ${title}: ${body}`);
    },
    async installApk(): Promise<void> {
      throw new BridgeError('APK install is only available on Android', 'EUNSUPPORTED');
    },
    now: () => Date.now(),
  };
}
