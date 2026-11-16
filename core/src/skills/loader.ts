import type { Platform } from '../platform/types';

/**
 * Skills (markdown with YAML-ish front matter) and microagents (OpenHands
 * concept: a markdown file loaded only when its trigger keywords appear in the
 * task). Both live in the app-private workspace so the user can edit them in the
 * Settings screen and they survive restarts.
 */
export interface SkillDoc {
  name: string;
  description: string;
  /** microagent triggers; empty means "always load" (a plain skill). */
  triggers: string[];
  body: string;
  path: string;
  enabled: boolean;
}

/**
 * Vendored skills carry an HTML attribution comment above the front matter
 * (our ECC files do), so leading comments and blank lines are stripped before
 * the `---` block is read. Without this a faithfully vendored file parses as a
 * bodyless blob.
 */
export function stripLeadingComments(raw: string): string {
  let text = raw.replace(/^\uFEFF/, '');
  for (;;) {
    const next = text.replace(/^\s*<!--[\s\S]*?-->\s*/, '');
    if (next === text) return text;
    text = next;
  }
}

export function parseSkillFile(path: string, raw: string): SkillDoc {
  const source = stripLeadingComments(raw);
  const frontMatterMatch = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(source);
  const meta: Record<string, string> = {};
  let body = source;
  if (frontMatterMatch) {
    body = frontMatterMatch[2];
    for (const line of frontMatterMatch[1].split('\n')) {
      const [key, ...rest] = line.split(':');
      if (!key || rest.length === 0) continue;
      meta[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '');
    }
  }
  const triggers = (meta['triggers'] ?? meta['globs'] ?? '')
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return {
    name: meta['name'] ?? path.split('/').pop()?.replace(/\.md$/, '') ?? 'unnamed',
    description: meta['description'] ?? '',
    triggers,
    body: body.trim(),
    path,
    enabled: meta['enabled'] !== 'false',
  };
}

export class SkillLibrary {
  constructor(private readonly platform: Platform, private readonly skillsRoot: string) {}

  async list(): Promise<SkillDoc[]> {
    if (!(await this.platform.fs.exists(this.skillsRoot))) return [];
    const entries = await this.platform.fs.list(this.skillsRoot, { recursive: true, suffix: '.md' });
    const skills: SkillDoc[] = [];
    for (const entry of entries) {
      try {
        skills.push(parseSkillFile(entry.path, await this.platform.fs.read(entry.path)));
      } catch {
        continue;
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Selects skills relevant to a task: always-on skills plus trigger matches. */
  async relevant(task: string): Promise<SkillDoc[]> {
    const skills = await this.list();
    const lower = task.toLowerCase();
    return skills.filter(
      (skill) => skill.enabled && (skill.triggers.length === 0 || skill.triggers.some((t) => lower.includes(t))),
    );
  }

  async contextFor(task: string): Promise<string> {
    const skills = await this.relevant(task);
    if (!skills.length) return '';
    return skills
      .map((skill) => `### Skill: ${skill.name}\n${skill.description ? `${skill.description}\n` : ''}${skill.body.slice(0, 3000)}`)
      .join('\n\n');
  }

  async save(path: string, raw: string): Promise<void> {
    await this.platform.fs.write(path, raw);
  }

  static template(name: string): string {
    return `---
name: ${name}
description: Describe when this skill applies
triggers: android, gradle
enabled: true
---

# ${name}

Write the guidance the agent should follow when this skill is loaded.
`;
  }
}
