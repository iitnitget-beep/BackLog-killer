/**
 * Skill selection for agents.
 *
 * Two sources feed the same interface:
 *   1. the vendored ECC skills (built into the APK), selected by trigger words;
 *   2. user skills from the project's `.forgex/skills/*.md` (existing loader),
 *      which may override a built-in by name.
 *
 * Selection is deterministic and cheap: trigger matching plus a token budget, so
 * a low-end phone never sends 100 KB of guidance to the model.
 */
import { BUILT_IN_SKILLS, type BuiltInSkill } from './bundle';
import { parseSkillFile, type SkillLibrary, type SkillDoc } from '../../skills/loader';

export interface SelectedSkill {
  name: string;
  origin: 'ECC' | 'user';
  triggers: string[];
  /** Truncated content actually sent to the model. */
  content: string;
  /** Full size, so the UI can show what was left out. */
  fullSize: number;
}

export interface SkillSelection {
  skills: SelectedSkill[];
  /** Total characters injected. */
  characters: number;
  /** Skills that matched but were dropped by the budget. */
  dropped: string[];
}

export interface SelectSkillsOptions {
  task: string;
  agent: string;
  /** Character budget for injected skill text. */
  maxCharacters?: number;
  /** Extra user skills from the project workspace. */
  userSkills?: SkillDoc[];
  /** Force-include these names regardless of triggers. */
  alwaysInclude?: string[];
}

/** Case-insensitive trigger match on the task text. */
export function matchesTriggers(task: string, triggers: string[]): boolean {
  const lower = task.toLowerCase();
  return triggers.some((trigger) => lower.includes(trigger.toLowerCase()));
}

export function selectSkills(options: SelectSkillsOptions): SkillSelection {
  const budget = options.maxCharacters ?? 24_000;
  const userByName = new Map((options.userSkills ?? []).map((skill) => [skill.name, skill]));
  const chosen: SelectedSkill[] = [];
  const dropped: string[] = [];
  let characters = 0;

  const candidates: { name: string; origin: 'ECC' | 'user'; triggers: string[]; content: string; rank: number }[] = [];

  for (const builtIn of BUILT_IN_SKILLS) {
    const userOverride = userByName.get(builtIn.name);
    if (userOverride?.enabled) continue; // user version wins
    if (builtIn.agents.length && !builtIn.agents.includes(options.agent)) continue;
    const forced = options.alwaysInclude?.includes(builtIn.name);
    if (!forced && !matchesTriggers(options.task, builtIn.triggers)) continue;
    candidates.push({
      name: builtIn.name,
      origin: 'ECC',
      triggers: builtIn.triggers,
      content: builtIn.content,
      // Forced skills rank first; otherwise the more specific (more triggers) wins.
      rank: forced ? -1000 : builtIn.triggers.length,
    });
  }

  for (const skill of options.userSkills ?? []) {
    if (!skill.enabled) continue;
    const forced = options.alwaysInclude?.includes(skill.name);
    if (!forced && skill.triggers.length > 0 && !matchesTriggers(options.task, skill.triggers)) continue;
    candidates.push({ name: skill.name, origin: 'user', triggers: skill.triggers, content: skill.body, rank: forced ? -1000 : 0 });
  }

  candidates.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  for (const candidate of candidates) {
    const remaining = budget - characters;
    if (remaining <= 500) {
      dropped.push(candidate.name);
      continue;
    }
    const content = candidate.content.slice(0, remaining);
    if (content.length < candidate.content.length) dropped.push(`${candidate.name} (truncated)`);
    chosen.push({
      name: candidate.name,
      origin: candidate.origin,
      triggers: candidate.triggers,
      content,
      fullSize: candidate.content.length,
    });
    characters += content.length;
  }

  return { skills: chosen, characters, dropped };
}

/** Renders the selection into the block injected into an agent's system prompt. */
export function renderSkillContext(selection: SkillSelection): string {
  if (selection.skills.length === 0) return '';
  return selection.skills
    .map(
      (skill) =>
        `<skill name="${skill.name}" origin="${skill.origin}">\n${skill.content}\n</skill>`,
    )
    .join('\n\n');
}

/**
 * Installs (or overwrites) a built-in skill into the project workspace so the
 * user can read and edit it in the app. Returns the path written.
 */
export async function installSkillToWorkspace(
  library: SkillLibrary,
  skillsRoot: string,
  skill: BuiltInSkill,
): Promise<string> {
  const path = `${skillsRoot}/${skill.name}.md`;
  const frontMatter = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.summary}`,
    `triggers: ${skill.triggers.slice(0, 8).join(', ')}`,
    'enabled: true',
    `origin: ECC (${skill.licence})`,
    '---',
    '',
  ].join('\n');
  await library.save(path, frontMatter + skill.content);
  return path;
}

export type { BuiltInSkill };
export { BUILT_IN_SKILLS };
export { parseSkillFile };
