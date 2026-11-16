/**
 * The built-in ECC skill bundle.
 *
 * These are vendored verbatim from affaan-m/ECC (MIT) by
 * `core/scripts/prepare-ecc-skills.mjs`; the licence header is inside each file.
 * They are imported as raw strings by esbuild (`--loader:.md=text`), so the same
 * content ships inside the APK and is available offline.
 */
import androidCleanArchitecture from './android-clean-architecture.md';
import kotlinPatterns from './kotlin-patterns.md';
import composePatterns from './compose-multiplatform-patterns.md';
import kotlinCoroutinesFlows from './kotlin-coroutines-flows.md';
import kotlinTesting from './kotlin-testing.md';
import tddWorkflow from './tdd-workflow.md';
import securityReview from './security-review.md';

export interface BuiltInSkill {
  name: string;
  /** Words that activate the skill; matched case-insensitively against the task. */
  triggers: string[];
  /** Which agents receive it. Empty means every agent. */
  agents: string[];
  /** One line shown in Settings. */
  summary: string;
  content: string;
  source: 'ECC';
  licence: string;
  sourceRepo: string;
}

const ECC_LICENCE = 'MIT (Copyright (c) 2026 Affaan Mustafa)';
const ECC_REPO = 'https://github.com/affaan-m/ECC';

export const BUILT_IN_SKILLS: BuiltInSkill[] = [
  {
    name: 'android-clean-architecture',
    triggers: ['architecture', 'module', 'modules', 'repository', 'usecase', 'clean', 'layer', 'di', 'hilt', 'koin'],
    agents: ['planner', 'editor'],
    summary: 'Module boundaries, UseCase/Repository layering and DI for Android.',
    content: androidCleanArchitecture,
    source: 'ECC',
    licence: ECC_LICENCE,
    sourceRepo: ECC_REPO,
  },
  {
    name: 'kotlin-patterns',
    triggers: ['kotlin', 'sealed', 'data class', 'null', 'idiomatic', 'coroutine', 'extension'],
    agents: ['editor', 'reviewer'],
    summary: 'Idiomatic Kotlin: null safety, sealed types, DSL builders.',
    content: kotlinPatterns,
    source: 'ECC',
    licence: ECC_LICENCE,
    sourceRepo: ECC_REPO,
  },
  {
    name: 'compose-multiplatform-patterns',
    triggers: ['compose', 'ui', 'screen', 'theme', 'navigation', 'state', 'viewmodel'],
    agents: ['editor'],
    summary: 'Jetpack Compose state, navigation, theming and performance.',
    content: composePatterns,
    source: 'ECC',
    licence: ECC_LICENCE,
    sourceRepo: ECC_REPO,
  },
  {
    name: 'kotlin-coroutines-flows',
    triggers: ['coroutine', 'flow', 'stateflow', 'concurrency', 'async', 'cancel', 'dispatcher'],
    agents: ['editor', 'test-fixer'],
    summary: 'Structured concurrency, Flow operators and cancellation.',
    content: kotlinCoroutinesFlows,
    source: 'ECC',
    licence: ECC_LICENCE,
    sourceRepo: ECC_REPO,
  },
  {
    name: 'kotlin-testing',
    triggers: ['test', 'tests', 'testing', 'mockk', 'kotest', 'coverage', 'junit'],
    agents: ['editor', 'test-fixer', 'reviewer'],
    summary: 'Kotest/MockK patterns, coroutine testing and coverage.',
    content: kotlinTesting,
    source: 'ECC',
    licence: ECC_LICENCE,
    sourceRepo: ECC_REPO,
  },
  {
    name: 'tdd-workflow',
    triggers: ['test', 'tdd', 'feature', 'bug', 'refactor', 'coverage'],
    agents: ['editor', 'test-fixer'],
    summary: 'Red/green/refactor with an 80% coverage expectation.',
    content: tddWorkflow,
    source: 'ECC',
    licence: ECC_LICENCE,
    sourceRepo: ECC_REPO,
  },
  {
    name: 'security-review',
    triggers: ['security', 'auth', 'login', 'secrets', 'token', 'permission', 'payment', 'input'],
    agents: ['security-reviewer', 'reviewer'],
    summary: 'OWASP-style checklist for auth, input, secrets and payments.',
    content: securityReview,
    source: 'ECC',
    licence: ECC_LICENCE,
    sourceRepo: ECC_REPO,
  },
];

export function findBuiltInSkill(name: string): BuiltInSkill | undefined {
  return BUILT_IN_SKILLS.find((skill) => skill.name === name);
}
