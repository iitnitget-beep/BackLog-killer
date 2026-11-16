export interface PlanFeature {
  name: string;
  acceptance?: string;
}

export interface PlanStep {
  id: number;
  title: string;
  files: string[];
  doneWhen: string;
}

/** The editable Plan card shown on the Build screen. */
export interface PlanDraft {
  summary: string;
  features: PlanFeature[];
  steps: PlanStep[];
  risks: string[];
  verify: string[];
}

export function renderPlanMarkdown(plan: PlanDraft): string {
  const lines: string[] = [`### Plan`, '', plan.summary, ''];
  if (plan.features.length) {
    lines.push('**Features**');
    for (const feature of plan.features) {
      lines.push(`- ${feature.name}${feature.acceptance ? ` — _${feature.acceptance}_` : ''}`);
    }
    lines.push('');
  }
  lines.push('**Steps**');
  for (const step of plan.steps) {
    lines.push(`${step.id}. ${step.title}${step.files.length ? ` (${step.files.join(', ')})` : ''} — done when: ${step.doneWhen}`);
  }
  if (plan.risks.length) {
    lines.push('', '**Risks**');
    for (const risk of plan.risks) lines.push(`- ${risk}`);
  }
  if (plan.verify.length) {
    lines.push('', `**Verify**: ${plan.verify.join(' · ')}`);
  }
  return lines.join('\n');
}

/** Applies a human edit from the Plan card, keeping step ids stable. */
export function updatePlanStep(plan: PlanDraft, stepId: number, title: string): PlanDraft {
  return {
    ...plan,
    steps: plan.steps.map((step) => (step.id === stepId ? { ...step, title } : step)),
  };
}

export function removePlanStep(plan: PlanDraft, stepId: number): PlanDraft {
  return { ...plan, steps: plan.steps.filter((step) => step.id !== stepId) };
}
