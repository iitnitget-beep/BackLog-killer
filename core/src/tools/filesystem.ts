import { safePath } from '../platform/types';
import type { Platform } from '../platform/types';
import { ToolError, type ToolDefinition, type ToolResultEnvelope } from './types';

const MAX_READ_BYTES = 200_000;

function truncate(text: string, limit = 20_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated ${text.length - limit} chars]`;
}

export function readFileTool(platform: Platform, root: string): ToolDefinition {
  return {
    name: 'read_file',
    spec: {
      description:
        'Read a UTF-8 text file from the project workspace. Use a line offset/limit for very large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the project root' },
          offset: { type: 'number', description: '0-based first line to return' },
          limit: { type: 'number', description: 'Maximum number of lines to return' },
        },
        required: ['path'],
      },
    },
    permission: () => 'allow',
    async run(args): Promise<ToolResultEnvelope> {
      const rel = String(args['path'] ?? '');
      if (!rel) throw new ToolError('path is required', 'EARGS');
      const abs = safePath(root, rel);
      const stat = await platform.fs.stat(abs);
      if (!stat) throw new ToolError(`file not found: ${rel}`, 'ENOENT');
      if (stat.type === 'dir') throw new ToolError(`is a directory: ${rel}`, 'EISDIR');
      if (stat.size > MAX_READ_BYTES) {
        throw new ToolError(`file too large (${stat.size} bytes): ${rel}`, 'ETOOLARGE');
      }
      const content = await platform.fs.read(abs);
      const lines = content.split('\n');
      const offset = Number(args['offset'] ?? 0);
      const limit = Number(args['limit'] ?? lines.length);
      const slice = lines.slice(offset, offset + limit);
      const numbered = slice.map((line, index) => `${offset + index + 1}\t${line}`).join('\n');
      return { ok: true, output: truncate(numbered), data: { path: rel, lines: lines.length } };
    },
  };
}

export function writeFileTool(platform: Platform, root: string): ToolDefinition {
  return {
    name: 'write_file',
    spec: {
      description:
        'Create or overwrite a text file in the project workspace. Always write complete file contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the project root' },
          content: { type: 'string', description: 'Full file contents' },
        },
        required: ['path', 'content'],
      },
    },
    permission: () => 'ask',
    async run(args): Promise<ToolResultEnvelope> {
      const rel = String(args['path'] ?? '');
      const content = String(args['content'] ?? '');
      if (!rel) throw new ToolError('path is required', 'EARGS');
      const abs = safePath(root, rel);
      const existed = await platform.fs.exists(abs);
      await platform.fs.write(abs, content);
      return {
        ok: true,
        output: `${existed ? 'Updated' : 'Created'} ${rel} (${content.length} bytes)`,
        data: { path: rel, bytes: content.length, created: !existed },
      };
    },
  };
}

/** Exact-string replacement edit, the safest primitive for small models. */
export function editFileTool(platform: Platform, root: string): ToolDefinition {
  return {
    name: 'edit_file',
    spec: {
      description:
        'Replace an exact text snippet in a file. old_string must appear exactly once unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    permission: () => 'ask',
    async run(args): Promise<ToolResultEnvelope> {
      const rel = String(args['path'] ?? '');
      const oldString = String(args['old_string'] ?? '');
      const newString = String(args['new_string'] ?? '');
      if (!oldString) throw new ToolError('old_string must not be empty', 'EARGS');
      const abs = safePath(root, rel);
      const current = await platform.fs.read(abs).catch(() => null);
      if (current === null) throw new ToolError(`file not found: ${rel}`, 'ENOENT');
      const occurrences = current.split(oldString).length - 1;
      if (occurrences === 0) throw new ToolError(`old_string not found in ${rel}`, 'ENOMATCH');
      if (occurrences > 1 && args['replace_all'] !== true) {
        throw new ToolError(
          `old_string appears ${occurrences} times in ${rel}; add more context or set replace_all`,
          'EAMBIGUOUS',
        );
      }
      const next =
        args['replace_all'] === true
          ? current.split(oldString).join(newString)
          : current.replace(oldString, newString);
      await platform.fs.write(abs, next);
      return {
        ok: true,
        output: `Edited ${rel} (${occurrences} replacement${occurrences > 1 ? 's' : ''})`,
        data: { path: rel, occurrences },
      };
    },
  };
}

export function listDirTool(platform: Platform, root: string): ToolDefinition {
  return {
    name: 'list_dir',
    spec: {
      description: 'List files and directories under a workspace path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Defaults to the project root' },
          recursive: { type: 'boolean' },
          max_entries: { type: 'number' },
        },
      },
    },
    permission: () => 'allow',
    async run(args): Promise<ToolResultEnvelope> {
      const rel = String(args['path'] ?? '.');
      const abs = safePath(root, rel === '.' ? '' : rel);
      const entries = await platform.fs.list(abs, {
        recursive: args['recursive'] === true,
        maxEntries: Number(args['max_entries'] ?? 300),
      });
      const rendered = entries
        .map((entry) => `${entry.type === 'dir' ? 'd' : 'f'} ${entry.name}${entry.type === 'file' ? ` (${entry.size}b)` : ''}`)
        .join('\n');
      return {
        ok: true,
        output: rendered || '(empty)',
        data: { count: entries.length, entries },
      };
    },
  };
}

export function globTool(platform: Platform, root: string): ToolDefinition {
  return {
    name: 'glob',
    spec: {
      description:
        'Find files whose path matches a simple glob pattern. Supports * and ** segments, e.g. "**/*.kt".',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' }, max_results: { type: 'number' } },
        required: ['pattern'],
      },
    },
    permission: () => 'allow',
    async run(args): Promise<ToolResultEnvelope> {
      const pattern = String(args['pattern'] ?? '**/*');
      const abs = safePath(root, '');
      const entries = await platform.fs.list(abs, { recursive: true, includeDirs: false, maxEntries: 20_000 });
      const regex = globToRegExp(pattern);
      const matches = entries.filter((entry) => regex.test(entry.name)).slice(0, Number(args['max_results'] ?? 200));
      return {
        ok: true,
        output: matches.length ? matches.map((m) => m.name).join('\n') : 'No files matched.',
        data: { count: matches.length },
      };
    },
  };
}

export function grepTool(platform: Platform, root: string): ToolDefinition {
  return {
    name: 'grep',
    spec: {
      description: 'Search file contents with a regular expression. Returns matching lines with file:line.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          glob: { type: 'string' },
          case_sensitive: { type: 'boolean' },
          max_results: { type: 'number' },
        },
        required: ['pattern'],
      },
    },
    permission: () => 'allow',
    async run(args): Promise<ToolResultEnvelope> {
      const pattern = String(args['pattern'] ?? '');
      if (!pattern) throw new ToolError('pattern is required', 'EARGS');
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, args['case_sensitive'] === true ? 'g' : 'gi');
      } catch (error) {
        throw new ToolError(`invalid regex: ${(error as Error).message}`, 'EREGEX');
      }
      const base = safePath(root, String(args['path'] ?? ''));
      const fileGlob = args['glob'] ? globToRegExp(String(args['glob'])) : null;
      const entries = await platform.fs.list(base, { recursive: true, includeDirs: false, maxEntries: 20_000 });
      const lines: string[] = [];
      const max = Number(args['max_results'] ?? 100);
      for (const entry of entries) {
        if (fileGlob && !fileGlob.test(entry.name)) continue;
        if (entry.size > 500_000) continue;
        let content: string;
        try {
          content = await platform.fs.read(entry.path);
        } catch {
          continue;
        }
        content.split('\n').forEach((line, index) => {
          if (lines.length >= max) return;
          regex.lastIndex = 0;
          if (regex.test(line)) lines.push(`${entry.name}:${index + 1}: ${line.trim().slice(0, 300)}`);
        });
        if (lines.length >= max) break;
      }
      return {
        ok: true,
        output: lines.length ? lines.join('\n') : 'No matches.',
        data: { count: lines.length },
      };
    },
  };
}

/** Converts a glob to a RegExp. `**` spans directories, `*` does not. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if ('.+^${}()|[]\\'.includes(char)) {
      out += `\\${char}`;
    } else if (char === '?') {
      out += '.';
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}
