import { describe, expect, it } from 'vitest';
import { BUILT_IN_SKILLS, findBuiltInSkill } from '../src/ecc/skills/bundle';
import {
  matchesTriggers,
  renderSkillContext,
  selectSkills,
  installSkillToWorkspace,
} from '../src/ecc/skills/loader';
import { SkillLibrary, parseSkillFile } from '../src/skills/loader';
import { Orchestrator } from '../src/agent/orchestrator';
import { ApprovalManager } from '../src/agent/approval';
import { ToolRegistry } from '../src/tools/registry';
import { EventStore } from '../src/events/store';
import { MemoryKv, createMemoryPlatform } from '../src/platform/memory';
import { ScriptedLlm } from './helpers';

const ROOT = '/workspace/demo';

describe('built-in ECC skills', () => {
  it('ships the seven vendored skills with real content and attribution', () => {
    expect(BUILT_IN_SKILLS.map((skill) => skill.name)).toEqual([
      'android-clean-architecture',
      'kotlin-patterns',
      'compose-multiplatform-patterns',
      'kotlin-coroutines-flows',
      'kotlin-testing',
      'tdd-workflow',
      'security-review',
    ]);
    for (const skill of BUILT_IN_SKILLS) {
      expect(skill.content.length).toBeGreaterThan(2_000);
      expect(skill.content).toContain('affaan-m/ECC'); // vendoring header
      expect(skill.content).toMatch(/^#|^<!--/m);
      expect(skill.licence).toContain('MIT');
      expect(skill.triggers.length).toBeGreaterThan(2);
    }
    expect(findBuiltInSkill('tdd-workflow')?.agents).toContain('editor');
  });

  it('selects by trigger words and agent role', () => {
    const securityTask = selectSkills({ task: 'Add a login screen with secure token storage', agent: 'security-reviewer' });
    expect(securityTask.skills.map((skill) => skill.name)).toContain('security-review');
    expect(securityTask.characters).toBeGreaterThan(1_000);

    // The editor does not get security-review (the security-reviewer owns it).
    const editor = selectSkills({ task: 'Add a login screen with secure token storage', agent: 'editor' });
    expect(editor.skills.map((skill) => skill.name)).not.toContain('security-review');

    const testing = selectSkills({ task: 'Write unit tests for the parser and fix the failing test', agent: 'test-fixer' });
    const names = testing.skills.map((skill) => skill.name);
    expect(names).toContain('tdd-workflow');
    expect(names).toContain('kotlin-testing');
  });

  it('returns nothing for an unrelated task', () => {
    expect(selectSkills({ task: 'Reorder the changelog', agent: 'editor' }).skills).toEqual([]);
  });

  it('respects the character budget and reports what it dropped', () => {
    const selection = selectSkills({
      task: 'kotlin coroutines flow stateflow test architecture',
      agent: 'editor',
      maxCharacters: 4_000,
    });
    expect(selection.characters).toBeLessThanOrEqual(4_000);
    expect(selection.dropped.length).toBeGreaterThan(0);
  });

  it('lets a user skill override a built-in with the same name', () => {
    const userSkill = parseSkillFile(
      '.forgex/skills/kotlin-testing.md',
      '---\nname: kotlin-testing\ndescription: house style\ntriggers: test\n---\nUse JUnit4 only.',
    );
    const selection = selectSkills({ task: 'add tests', agent: 'editor', userSkills: [userSkill] });
    const match = selection.skills.find((skill) => skill.name === 'kotlin-testing');
    expect(match?.origin).toBe('user');
    expect(match?.content).toContain('JUnit4');
  });

  it('renders a tagged block the model can identify', () => {
    const selection = selectSkills({ task: 'security review of the login flow', agent: 'reviewer' });
    const rendered = renderSkillContext(selection);
    expect(rendered).toContain('<skill name="security-review" origin="ECC">');
    expect(rendered).toContain('</skill>');
    expect(renderSkillContext({ skills: [], characters: 0, dropped: [] })).toBe('');
  });

  it('parses the vendored ECC files, whose attribution comment precedes the front matter', () => {
    for (const skill of BUILT_IN_SKILLS) {
      const parsed = parseSkillFile(`.forgex/skills/${skill.name}.md`, skill.content);
      expect(parsed.body.length).toBeGreaterThan(1_000);
      expect(parsed.body.startsWith('<!--')).toBe(false);
      expect(parsed.enabled).toBe(true);
    }
  });

  it('matches triggers case-insensitively', () => {
    expect(matchesTriggers('Add a KOTLIN data class', ['kotlin'])).toBe(true);
    expect(matchesTriggers('Add a data class', ['kotlin', 'sealed'])).toBe(false);
  });

  it('installs a built-in skill into the workspace so the user can edit it', async () => {
    const memory = createMemoryPlatform();
    const library = new SkillLibrary(memory, `${ROOT}/.forgex/skills`);
    const skill = findBuiltInSkill('tdd-workflow')!;
    const path = await installSkillToWorkspace(library, `${ROOT}/.forgex/skills`, skill);
    expect(path).toBe(`${ROOT}/.forgex/skills/tdd-workflow.md`);
    const raw = await memory.fs.read(path);
    expect(raw.startsWith('---\nname: tdd-workflow')).toBe(true);
    expect(raw).toContain('origin: ECC (MIT');
    const [parsed] = await library.list();
    expect(parsed.name).toBe('tdd-workflow');
    expect(parsed.triggers).toContain('tdd');
    expect(parsed.body.length).toBeGreaterThan(2_000);
    expect(parsed.enabled).toBe(true);
  });
});

describe('skills reach the agent prompt', () => {
  function makeOrchestrator(task: string) {
    const memory = createMemoryPlatform();
    const events = new EventStore(new MemoryKv(), 'run-skills');
    const llm = new ScriptedLlm([{ content: `Plan: ${task}` }]);
    const seen: { agent: string; names: string[] }[] = [];
    const orchestrator = new Orchestrator({
      platform: memory,
      llm: () => llm,
      registry: ToolRegistry.standard(memory, ROOT),
      approvals: new ApprovalManager('FULL_AUTO'),
      events,
      workspaceRoot: ROOT,
      onSkillsSelected: (agent, selection) => seen.push({ agent, names: selection.skills.map((skill) => skill.name) }),
    });
    return { orchestrator, events, llm, seen };
  }

  it('injects the selected skills into the system prompt and records them', async () => {
    const { orchestrator, events, llm, seen } = makeOrchestrator('login screen architecture');
    const result = await orchestrator.ask('planner', 'Plan a login screen with architecture notes');
    expect(result).toContain('Plan');
    expect(seen).toHaveLength(1);
    expect(seen[0].agent).toBe('planner');
    expect(seen[0].names).toContain('android-clean-architecture');

    const system = llm.systemPrompt();
    expect(system).toContain('<skill name="android-clean-architecture" origin="ECC">');
    expect(system).toContain('## Skills');

    const notes = (await events.all()).filter((event) => event.kind === 'note');
    expect(notes.some((event) => JSON.stringify(event).includes('skills loaded'))).toBe(true);
  });

  it('sends no skill block when nothing matches', async () => {
    const { orchestrator, llm } = makeOrchestrator('changelog');
    await orchestrator.ask('editor', 'Reorder the changelog');
    expect(llm.systemPrompt()).not.toContain('## Skills');
  });

  it('loads user skills from the workspace alongside the built-ins', async () => {
    const memory = createMemoryPlatform();
    await memory.fs.write(
      `${ROOT}/.forgex/skills/house-style.md`,
      '---\nname: house-style\ndescription: house rules\ntriggers: screen\n---\nAlways add a Preview composable.',
    );
    const library = new SkillLibrary(memory, `${ROOT}/.forgex/skills`);
    const llm = new ScriptedLlm([{ content: 'ok' }]);
    const orchestrator = new Orchestrator({
      platform: memory,
      llm: () => llm,
      registry: ToolRegistry.standard(memory, ROOT),
      approvals: new ApprovalManager('FULL_AUTO'),
      events: new EventStore(new MemoryKv(), 'run-user-skills'),
      workspaceRoot: ROOT,
      userSkills: () => library.list(),
    });
    await orchestrator.ask('editor', 'Add a settings screen');
    const system = llm.systemPrompt();
    expect(system).toContain('house-style');
    expect(system).toContain('Preview composable');
  });

  it('exposes the hook graph on the orchestrator', () => {
    const { orchestrator } = makeOrchestrator('x');
    expect(orchestrator.hookIds()).toContain('pre:secret-scan');
    expect(orchestrator.hookIds()).toContain('pre:destructive-command');
  });
});
