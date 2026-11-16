import { escapeHtml } from './highlight';

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * Line diff via longest-common-subsequence. Files here are small (source files a
 * phone agent wrote), so the O(n*m) table is fine; we cap the input to keep it
 * predictable on a low-end device.
 */
export function computeDiff(before: string, after: string, maxLines = 1500): DiffLine[] {
  const split = (value: string) => (value === '' ? [] : value.split('\n').slice(0, maxLines));
  const a = split(before);
  const b = split(after);
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i], oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: 'del', text: a[i], oldLine: i + 1 });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j], newLine: j + 1 });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ type: 'del', text: a[i], oldLine: i + 1 });
    i += 1;
  }
  while (j < b.length) {
    out.push({ type: 'add', text: b[j], newLine: j + 1 });
    j += 1;
  }
  return out;
}

export function diffLines(before: string, after: string): string {
  const lines = computeDiff(before, after);
  const added = lines.filter((line) => line.type === 'add').length;
  const removed = lines.filter((line) => line.type === 'del').length;
  const body = lines
    .map((line) => {
      const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      const cls = line.type === 'add' ? 'diff-add' : line.type === 'del' ? 'diff-del' : '';
      const number = line.newLine ?? line.oldLine ?? '';
      return `<span class="${cls}">${String(number).padStart(4, ' ')} ${marker} ${escapeHtml(line.text)}</span>`;
    })
    .join('\n');
  return `<div class="row" style="gap:8px;margin-bottom:8px"><span class="chip" style="color:var(--ok)">+${added}</span><span class="chip" style="color:var(--bad)">-${removed}</span></div><pre class="code">${body}</pre>`;
}
