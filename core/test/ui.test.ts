import { describe, expect, it, beforeEach, vi } from 'vitest';
import { computeDiff, diffLines } from '../src/ui/diff';
import { highlight, escapeHtml, renderHighlighted } from '../src/ui/highlight';

/**
 * A deliberately tiny DOM shim. It is enough to run the real UI module:
 * `getElementById('app')` captures the rendered markup and
 * `querySelectorAll` returns nothing, so bind() becomes a no-op. That means
 * these tests exercise the actual render code, not a copy of it.
 */
interface ShimElement {
  innerHTML: string;
  value?: string;
  textContent?: string;
  dataset: Record<string, string>;
  addEventListener: (event: string, handler: () => void) => void;
  checked?: boolean;
}

function installDom(): { container: ShimElement; rendered: () => string } {
  const container: ShimElement = {
    innerHTML: '',
    dataset: {},
    addEventListener: () => undefined,
  };
  const documentShim = {
    getElementById: (id: string) => (id === 'app' ? container : null),
    querySelectorAll: () => [] as ShimElement[],
    querySelector: () => null,
  };
  const windowShim = {
    forgeXBridge: undefined,
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
    prompt: () => null,
  };
  vi.stubGlobal('document', documentShim);
  vi.stubGlobal('window', windowShim);
  vi.stubGlobal('navigator', { clipboard: { writeText: async () => undefined } });
  return { container, rendered: () => container.innerHTML };
}

describe('UI renders', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('boots on the home screen with the build form', async () => {
    const { rendered } = installDom();
    await import('../src/ui/main');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const html = rendered();
    expect(html).toContain('ForgeX');
    expect(html).toContain('What should ForgeX build?');
    expect(html).toContain('New build');
    expect(html).toContain('Projects');
    expect(html).toContain('data-nav="build"');
    expect(html).toContain('data-nav="settings"');
    // Browser preview must be labelled honestly.
    expect(html).toContain('preview');
  });

  it('renders every screen through the real navigation code', async () => {
    const { rendered } = installDom();
    await import('../src/ui/main');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Home is the landing screen.
    expect(rendered()).toContain('What should ForgeX build?');

    const expectations: Record<string, string> = {
      build: 'Agent timeline',
      workspace: 'Workspace',
      ship: 'Commit message',
      settings: 'Approval mode',
    };
    const navigate = (window as unknown as { __forgexNavigate?: (s: string) => void }).__forgexNavigate;
    expect(typeof navigate).toBe('function');
    for (const [screen, marker] of Object.entries(expectations)) {
      navigate!(screen);
      const html = rendered();
      // The tab bar marks the active screen and the screen body rendered.
      expect(html).toContain(`data-nav="${screen}" class="active"`);
      expect(html).toContain(marker);
    }
  });
});

describe('syntax highlighting', () => {
  it('escapes html before highlighting', () => {
    const html = highlight('<script>alert(1)</script>', 'a.kt');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('highlights keywords, strings and numbers', () => {
    const html = highlight('fun add(a: Int) = a + 42 // sum', 'a.kt');
    expect(html).toContain('ff9d5c'); // keyword colour
    expect(html).toContain('7cc7ff'); // number colour
  });

  it('escapes quotes and ampersands', () => {
    expect(escapeHtml(`a & b "c" 'd'`)).toBe('a &amp; b &quot;c&quot; &#39;d&#39;');
  });

  it('wraps output in a code block', () => {
    expect(renderHighlighted('val x = 1', 'a.kt')).toContain('<pre class="code">');
  });
});

describe('diff', () => {
  it('marks additions and deletions', () => {
    const diff = computeDiff('a\nb\nc', 'a\nB\nc');
    expect(diff.filter((line) => line.type === 'add')).toHaveLength(1);
    expect(diff.filter((line) => line.type === 'del')).toHaveLength(1);
    expect(diff.filter((line) => line.type === 'same')).toHaveLength(2);
  });

  it('handles whole-file replacement and empty input', () => {
    expect(computeDiff('', 'a\nb').every((line) => line.type === 'add')).toBe(true);
    expect(computeDiff('a\nb', '').every((line) => line.type === 'del')).toBe(true);
    expect(computeDiff('', '')).toEqual([]);
  });

  it('renders counts and coloured lines', () => {
    const html = diffLines('old', 'new');
    expect(html).toContain('diff-add');
    expect(html).toContain('diff-del');
    expect(html).toContain('+1');
    expect(html).toContain('-1');
  });

  it('caps very large files', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const diff = computeDiff('', big, 100);
    expect(diff.length).toBeLessThanOrEqual(100);
  });
});
