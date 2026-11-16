import type { Platform } from '../platform/types';

/**
 * Per-project memory (spec §4): an AGENTS.md file in the workspace plus learned
 * notes appended after a successful run. The agent reads this before planning so
 * mistakes are not repeated between sessions.
 */
export interface LearnedNote {
  timestamp: number;
  runId: string;
  text: string;
  kind: 'success' | 'gotcha' | 'preference';
}

export interface ProjectMemory {
  agentsMd: string;
  notes: LearnedNote[];
}

const AGENTS_MD = 'AGENTS.md';
const NOTES_KEY = 'memory/notes';

export class ProjectMemoryStore {
  private readonly platform: Platform;

  constructor(
    platform: Platform,
    private readonly workspaceRoot: string,
    private readonly projectId: string,
  ) {
    this.platform = platform;
  }

  private get notesKvKey(): string {
    return `${NOTES_KEY}/${this.projectId}`;
  }

  async readAgentsMd(): Promise<string> {
    const path = `${this.workspaceRoot}/${AGENTS_MD}`;
    try {
      return (await this.platform.fs.exists(path)) ? this.platform.fs.read(path) : '';
    } catch {
      return '';
    }
  }

  async writeAgentsMd(content: string): Promise<void> {
    await this.platform.fs.write(`${this.workspaceRoot}/${AGENTS_MD}`, content);
  }

  async notes(): Promise<LearnedNote[]> {
    const raw = await this.platform.kv.get(this.notesKvKey);
    return raw ? (JSON.parse(raw) as LearnedNote[]) : [];
  }

  async addNote(note: LearnedNote): Promise<void> {
    const notes = await this.notes();
    // De-duplicate identical text so repeated runs do not bloat the prompt.
    if (notes.some((existing) => existing.text === note.text)) return;
    notes.push(note);
    await this.platform.kv.set(this.notesKvKey, JSON.stringify(notes.slice(-50)));
  }

  /** Concatenated context handed to every agent. */
  async context(): Promise<string> {
    const [agentsMd, notes] = await Promise.all([this.readAgentsMd(), this.notes()]);
    const parts: string[] = [];
    if (agentsMd.trim()) parts.push(`### AGENTS.md\n${agentsMd.trim().slice(0, 6000)}`);
    if (notes.length) {
      parts.push(
        `### Learned notes\n${notes
          .slice(-15)
          .map((note) => `- (${note.kind}) ${note.text}`)
          .join('\n')}`,
      );
    }
    return parts.join('\n\n');
  }
}

/** Extracts durable lessons from a finished run, without another model call. */
export function deriveNotes(options: {
  runId: string;
  timestamp: number;
  planVerify: string[];
  attempts: { iteration: number; verify: { ok: boolean; summary: string }; fix?: string }[];
  finalOk: boolean;
}): LearnedNote[] {
  const notes: LearnedNote[] = [];
  if (options.finalOk && options.planVerify.length) {
    notes.push({
      timestamp: options.timestamp,
      runId: options.runId,
      kind: 'success',
      text: `Verified with: ${options.planVerify.join(', ')}`,
    });
  }
  // A failed round is a durable lesson even if no fixer ran for it, so we do
  // not require `fix` here.
  for (const attempt of options.attempts) {
    if (attempt.verify.ok) continue;
    const firstLine = attempt.verify.summary.split('\n').find((line) => line.trim().length > 0) ?? '';
    if (!firstLine.trim()) continue;
    notes.push({
      timestamp: options.timestamp,
      runId: options.runId,
      kind: 'gotcha',
      text: `Round ${attempt.iteration} failed on: ${firstLine.trim().slice(0, 200)}`,
    });
  }
  return notes;
}
