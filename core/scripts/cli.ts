/**
 * ForgeX CLI harness.
 *
 * Runs the real pipeline against a real provider and (optionally) a real GitHub
 * repository, using the Node platform. This exists so the engine can be verified
 * end to end from a laptop without the APK, and so a user can reproduce what the
 * phone does.
 *
 *   node --experimental-strip-types scripts/cli.ts plan  "a habit tracker"
 *   FORGEX_API_KEY=sk-... node --experimental-strip-types scripts/cli.ts run "a habit tracker" --out ./out
 *   FORGEX_API_KEY=... GH_TOKEN=... node ... scripts/cli.ts ship "..." --owner me --repo app
 */
import { createNodePlatform } from '../src/platform/node';
import { ProjectSession } from '../src/app/session';
import { presetEntry } from '../src/app/session';
import { renderPlanMarkdown } from '../src/run/plan';
import { trimCiLog } from '../src/ci/monitor';

/** `scan` runs without a provider: it is a pre-flight check anyone can run. */
async function scanWorkspace(args: Args): Promise<number> {
  const platform = createNodePlatform({
    workspaceRoot: `${args.out}/workspace`,
    dataDir: `${args.out}/.forgex`,
  });
  const entries = await platform.fs.list(`${args.out}/workspace`, { recursive: true, includeDirs: false });
  const { scanText } = await import('../src/security/scanner');
  const findings: string[] = [];
  for (const entry of entries) {
    if (entry.size > 400_000) continue;
    if (/\.(png|jpg|jpeg|webp|apk|jar|zip|so|dex|class)$/i.test(entry.name)) continue;
    let content = '';
    try {
      content = await platform.fs.read(entry.path);
    } catch {
      continue;
    }
    for (const finding of scanText(content, { path: entry.name, strict: true })) {
      findings.push(`${entry.name}:${finding.line} ${finding.rule} ${finding.excerpt}`);
    }
  }
  console.log(findings.length ? findings.join('\n') : 'No secrets found.');
  return findings.length ? 1 : 0;
}

interface Args {
  command: 'plan' | 'run' | 'ship' | 'scan';
  request: string;
  out: string;
  owner?: string;
  repo?: string;
  provider: string;
  model?: string;
}

function parseArgs(argv: string[]): Args {
  const command = (argv[0] ?? 'run') as Args['command'];
  const rest = argv.slice(1);
  let request = '';
  let out = './forgex-out';
  let owner: string | undefined;
  let repo: string | undefined;
  let provider = 'openrouter';
  let model: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--out') out = rest[++i];
    else if (arg === '--owner') owner = rest[++i];
    else if (arg === '--repo') repo = rest[++i];
    else if (arg === '--provider') provider = rest[++i];
    else if (arg === '--model') model = rest[++i];
    else if (!arg.startsWith('--')) request = arg;
  }
  return { command, request, out, owner, repo, provider, model };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.request) {
    console.error('usage: cli <plan|run|ship|scan> "<app request>" [--out dir] [--provider id] [--model m] [--owner o --repo r]');
    return 2;
  }
  // `scan` never calls a model and `plan`/`run` do, so the key check is scoped:
  // scanning a workspace before you have a key is a legitimate thing to want.
  const apiKey = process.env['FORGEX_API_KEY'] ?? '';
  if (!apiKey && args.command !== 'scan') {
    console.error('FORGEX_API_KEY is not set. Export a provider key; nothing is bundled with ForgeX.');
    return 2;
  }
  const platform = createNodePlatform({
    workspaceRoot: `${args.out}/workspace`,
    dataDir: `${args.out}/.forgex`,
  });
  // Do not write secrets into the workspace where they could be published.
  if (apiKey) await platform.secrets.set('provider/apiKey', apiKey);

  const githubToken = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
  if (args.command === 'scan') {
    return scanWorkspace(args);
  }
  const entry = presetEntry(args.provider, apiKey, args.model ? [args.model] : undefined);
  if (!entry) {
    console.error(`unknown provider preset: ${args.provider}`);
    return 2;
  }
  const session = new ProjectSession({
    platform,
    projectId: 'cli',
    workspaceRoot: `${args.out}/workspace`,
    skillsRoot: `${args.out}/workspace/.forgex/skills`,
    providers: [entry],
    approvalMode: args.command === 'plan' ? 'ASK' : 'FULL_AUTO',
    approvalHandler: async (request) => {
      console.error(`[approval] ${request.description}`);
      return { approved: true };
    },
    pollIntervalMs: 10_000,
  });
  if (githubToken && args.owner && args.repo) {
    session.setGitHub({ token: githubToken, owner: args.owner, repo: args.repo });
  }

  if (args.command === 'plan') {
    const { draft } = await session.orchestrator.plan(args.request);
    console.log(renderPlanMarkdown(draft));
    return 0;
  }

  const state = await session.run(args.request);
  console.log(`\nstatus: ${state.status}`);
  if (state.plan) console.log(renderPlanMarkdown(state.plan));
  if (state.ship) {
    console.log(`pushed ${state.ship.repoFullName}@${state.ship.commitSha.slice(0, 12)} ci=${state.ship.ciStatus}`);
    if (state.ship.ciUrl) console.log(`run: ${state.ship.ciUrl}`);
    if (state.ship.apkLocalPath) console.log(`apk: ${state.ship.apkLocalPath}`);
  }
  if (state.error) console.error(`error: ${state.error}`);
  const events = await session.events.all();
  const logs = events.filter((event) => event.kind === 'log') as { detail: string }[];
  if (logs.length) {
    console.log('\n--- ci excerpt ---');
    console.log(trimCiLog(logs[logs.length - 1].detail));
  }
  return state.status === 'done' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
