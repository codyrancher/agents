// Syntax highlighting for the code the chat shows: fenced blocks in messages, files the viewer
// opens, diffs. highlight.js's core with the languages this product meets, registered once;
// anything else falls back to a guess among them, and a failure to a plain escape. The theme is
// the dashboard's, in ChatPane's unscoped styles (`.hljs-*`), so it follows light and dark.
import hljs from 'highlight.js/lib/common';

// The common bundle registers the languages this product meets (javascript, typescript, json,
// yaml, bash, diff, markdown, css, scss, xml, python, go, ini, sql, plaintext and more); the
// aliases below are the names files and fences here actually use.
hljs.registerAliases(['js', 'mjs', 'cjs', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'mts', 'cts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['patch'], { languageName: 'diff' });
hljs.registerAliases(['md'], { languageName: 'markdown' });
hljs.registerAliases(['html', 'vue', 'svg', 'xhtml'], { languageName: 'xml' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['toml', 'cfg', 'conf', 'env'], { languageName: 'ini' });
hljs.registerAliases(['txt', 'log', 'text'], { languageName: 'plaintext' });

/** The language a path is in, by its extension or its name; '' when nothing says. */
export function languageFor(path: string): string {
  const name = (path || '').split('/').pop() || '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';

  if (/^(dockerfile|makefile)$/i.test(name)) {
    return name.toLowerCase() === 'makefile' ? 'makefile' : 'bash';
  }

  return ext && hljs.getLanguage(ext) ? ext : '';
}

/** Whether text is a unified diff, whatever it is called. */
export function looksLikeDiff(text: string): boolean {
  return /^(diff --git |--- a\/|\+\+\+ b\/|@@ -\d)/m.test((text || '').slice(0, 4000));
}

/**
 * Code as HTML: highlighted in the named language, or in a guess when the name is unknown or
 * absent, or escaped when highlighting fails. Never throws, never returns unescaped input.
 */
export function highlight(code: string, language = ''): string {
  const text = code || '';

  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    }
    if (text.length < 40_000) {
      return hljs.highlightAuto(text, ['javascript', 'typescript', 'json', 'yaml', 'bash', 'diff', 'xml', 'css', 'python', 'go']).value;
    }
  } catch { /* fall through to the escape */ }

  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
