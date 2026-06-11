/**
 * A lightweight, zero-dependency Markdown parser that converts basic Markdown
 * syntax to clean, styled HTML suitable for task notes.
 */
export function renderMarkdown(md: string): string {
  if (!md) return '';

  // 1. Escape HTML to prevent XSS
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Fenced Code Blocks (```code```)
  html = html.replace(/```([\s\S]+?)```/g, (_, code) => {
    return `<pre class="bg-surface-700/50 p-2.5 rounded-lg font-mono text-[11px] my-2 overflow-x-auto border border-surface-600/30 text-ci-1/90">${code.trim()}</pre>`;
  });

  // 3. Inline Code (`code`)
  html = html.replace(/`([^`]+)`/g, '<code class="bg-surface-700/50 px-1 py-0.5 rounded font-mono text-[11px] border border-surface-600/30 text-accent-light">$1</code>');

  // 4. Headers (###, ##, #)
  html = html.replace(/^### (.*$)/gim, '<h4 class="text-xs font-bold text-ci-1 mt-3 mb-1 uppercase tracking-wider">$1</h4>');
  html = html.replace(/^## (.*$)/gim, '<h3 class="text-sm font-semibold text-ci-1 mt-4 mb-1.5 border-b border-surface-700/30 pb-0.5">$1</h3>');
  html = html.replace(/^# (.*$)/gim, '<h2 class="text-base font-bold text-accent-light mt-5 mb-2">$1</h2>');

  // 5. Checklists (- [ ] / - [x])
  html = html.replace(/^\s*[-*]\s+\[x\]\s+(.*$)/gim, '<div class="flex items-center gap-2 my-1 text-ci-1/40 line-through"><input type="checkbox" checked disabled class="accent-accent scale-90" /> <span>$1</span></div>');
  html = html.replace(/^\s*[-*]\s+\[ \]\s+(.*$)/gim, '<div class="flex items-center gap-2 my-1 text-ci-1/80"><input type="checkbox" disabled class="accent-accent scale-90" /> <span>$1</span></div>');

  // 6. Unordered Lists (- item / * item)
  // Ensure we don't match checkboxes
  html = html.replace(/^\s*[-*]\s+(?!\[[ x]\])(.*$)/gim, '<li class="list-disc ml-5 my-0.5 text-ci-1/80">$1</li>');

  // 7. Bold (**text**)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // 8. Italic (*text*)
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // 9. Links ([label](url))
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-accent-light hover:underline hover:text-accent">$1</a>');

  // 10. Process linebreaks for text blocks (skip formatting for tags/lists/pre)
  const lines = html.split('\n');
  const processedLines = lines.map(line => {
    const trimmed = line.trim();
    if (
      trimmed.startsWith('<li') ||
      trimmed.startsWith('<h') ||
      trimmed.startsWith('<pre') ||
      trimmed.startsWith('</pre') ||
      trimmed.startsWith('<div') ||
      trimmed.startsWith('</div')
    ) {
      return line;
    }
    return trimmed ? `${line}<br/>` : '<div class="h-1.5"></div>';
  });

  return processedLines.join('\n');
}
