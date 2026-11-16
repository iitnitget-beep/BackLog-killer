/**
 * Tiny syntax highlighter for the code viewer. It is intentionally simple: no
 * grammar, just token classes that cover Kotlin/TS/Gradle/YAML well enough to
 * make code readable on a phone, with no dependency and no innerHTML injection
 * of unescaped input.
 */
const KEYWORDS =
  /\b(class|object|interface|fun|val|var|if|else|when|for|while|return|import|package|private|public|internal|override|suspend|data|sealed|enum|null|true|false|this|super|const|let|function|async|await|export|default|new|throw|try|catch|finally|type|extends|implements)\b/g;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

export function highlight(code: string, filename: string): string {
  const escaped = escapeHtml(code);
  // Order matters: comments and strings first so keywords inside them are not
  // double-highlighted. We walk line by line to avoid multi-line regex cost.
  return escaped
    .split('\n')
    .map((line) => {
      const isComment = /^\s*(\/\/|#|\/\*|\*)/.test(line);
      if (isComment) return `<span style="color:#6b7a8f">${line}</span>`;
      return line
        .replace(/(&quot;[^&]*?&quot;|'[^']*?')/g, '<span style="color:#9ae6a8">$1</span>')
        .replace(KEYWORDS, '<span style="color:#ff9d5c">$1</span>')
        .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span style="color:#7cc7ff">$1</span>');
    })
    .join('\n');
}

export function renderHighlighted(code: string, filename: string): string {
  return `<pre class="code">${highlight(code, filename)}</pre>`;
}
