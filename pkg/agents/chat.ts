// The chat view of a conversation: what it reads, and how it reads it.
//
// A pane is claude's own terminal UI inside tmux, and the chat view is another face on the
// same session rather than a second client of anything. Two things feed it, both read out of
// the pod the pane runs in:
//
//   - the transcript claude writes as it goes (`~/.claude/projects/<cwd>/<uuid>.jsonl`), one
//     JSON object per line, which is what the messages, the tool calls and their results are
//     rendered from. It is the same file `--resume` reads, so what the chat shows is what the
//     conversation is.
//   - the last lines of the pane itself (`tmux capture-pane`), which is where the things the
//     transcript never carries show up: a question with numbered answers, a permission
//     prompt, the login flow, "session expired", a survey. The chat turns those into buttons
//     and inputs; what it sends back is keystrokes to the same pane.
//
// Everything here is pure: given text, it answers with structure. ChatPane.vue does the
// fetching and the sending.

export interface ChatToolCall {
  id: string;
  name: string;
  input: unknown;
  /** The tool's answer, once it has one. */
  result?: string;
  resultIsError?: boolean;
  /** Images the tool returned (a screenshot read back, a Read of a png), as data URLs. */
  images?: string[];
}

export interface ChatMessage {
  /** The transcript's own uuid for the line, for keys. */
  key: string;
  /** `note` is the CLI talking: a local command and what it printed, an interrupt. */
  role: 'user' | 'assistant' | 'summary' | 'note';
  /** Text, as written (markdown). */
  text: string;
  /** Tool calls in this assistant turn, results attached as they arrive. */
  tools: ChatToolCall[];
  /** The model's thinking, when the transcript carries it. */
  thinking: string;
  /** Files a user message attached (the paths claude was handed). */
  images: string[];
  at: string;
}

/**
 * Transcript lines to messages.
 *
 * The transcript interleaves user turns, assistant turns and tool results (which arrive as a
 * `user` line whose content is `tool_result` blocks). Tool results are folded into the call
 * they answer, so a turn reads as: what was said, what was done, what came back.
 */
export function parseTranscript(lines: string[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const calls = new Map<string, ChatToolCall>();

  for (const line of lines) {
    let entry: any; // eslint-disable-line @typescript-eslint/no-explicit-any

    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // A message typed while claude was busy and absorbed into the running turn. The CLI takes
    // it off its queue ("remove … absorbed_mid_turn") and records it as an attachment of the
    // turn, timestamped when it was typed - never as a user line. It is the person speaking all
    // the same, and without this it vanished from the log the moment claude started reading it.
    if (entry?.type === 'attachment' && entry.attachment?.type === 'queued_command') {
      const prompt = String(entry.attachment.prompt || '').trim();

      if (prompt) {
        messages.push({
          key: entry.uuid || `${ messages.length }`, role: 'user', text: prompt, tools: [], thinking: '', images: [], at: entry.timestamp || '',
        });
      }
      continue;
    }

    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant') || !entry.message) {
      continue;
    }

    const content = entry.message.content;
    const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : (Array.isArray(content) ? content : []); // eslint-disable-line @typescript-eslint/no-explicit-any
    const at = entry.timestamp || '';

    if (entry.type === 'user') {
      const results = blocks.filter((b) => b.type === 'tool_result');

      for (const result of results) {
        const call = calls.get(result.tool_use_id);

        if (call) {
          call.result = resultText(result.content);
          call.resultIsError = !!result.is_error;
          const shots = Array.isArray(result.content) ? result.content.map(imageUrl).filter(Boolean) : [];

          if (shots.length) {
            call.images = shots;
          }
        }
      }

      const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text || '')).join('\n').trim();
      const images = blocks.filter((b) => b.type === 'image').map((b, i) => imageUrl(b) || b.source?.path || `image ${ i + 1 }`);

      // A user line that is only tool results is not something the person said.
      if (!text && !images.length) {
        continue;
      }
      // The CLI's own lines: a slash command, what it printed, an interrupt. Shown as notes
      // rather than dropped, because `/model sonnet` and what `/cost` said are things the
      // person wants to see happened - and because dropping them left the log saying nothing
      // while the terminal said "Set model to Sonnet".
      const note = noteFrom(text);

      if (note !== null) {
        if (note) {
          messages.push({
            key: entry.uuid || `${ messages.length }`, role: 'note', text: note, tools: [], thinking: '', images: [], at,
          });
        }
        continue;
      }
      // A compact's summary arrives as a user line, because that is how it is fed back to the
      // model. It is not something the person said; it is the conversation so far, folded.
      const summary = entry.isCompactSummary === true || /^This session is being continued from a previous conversation/.test(text);

      messages.push({
        key: entry.uuid || `${ messages.length }`, role: summary ? 'summary' : 'user', text, tools: [], thinking: '', images, at,
      });
      continue;
    }

    const message: ChatMessage = {
      key:      entry.uuid || `${ messages.length }`,
      role:     'assistant',
      text:     blocks.filter((b) => b.type === 'text').map((b) => String(b.text || '')).join('\n').trim(),
      tools:    [],
      thinking: blocks.filter((b) => b.type === 'thinking').map((b) => String(b.thinking || '')).join('\n').trim(),
      images:   [],
      at,
    };

    for (const block of blocks.filter((b) => b.type === 'tool_use')) {
      const call: ChatToolCall = { id: block.id, name: block.name, input: block.input };

      calls.set(block.id, call);
      message.tools.push(call);
    }

    // An assistant line with nothing in it (a stop with no text) adds nothing to read.
    if (message.text || message.tools.length || message.thinking) {
      // Consecutive assistant lines are one turn (claude writes a line per content block).
      const last = messages[messages.length - 1];

      if (last && last.role === 'assistant' && last.at && at && sameTurn(last, message)) {
        last.text = [last.text, message.text].filter(Boolean).join('\n\n');
        last.tools.push(...message.tools);
        last.thinking = [last.thinking, message.thinking].filter(Boolean).join('\n\n');
      } else {
        messages.push(message);
      }
    }
  }

  return messages;
}

/** An image block as something an <img> can show, or ''. */
function imageUrl(block: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const source = block?.type === 'image' ? block.source : null;

  if (source?.type === 'base64' && source.data) {
    return `data:${ source.media_type || 'image/png' };base64,${ source.data }`;
  }

  return '';
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * The CLI's own user lines, as a note; '' for one not worth showing; null for a person's line.
 *
 * `<command-name>/model</command-name>` with `<command-args>` is the command as typed; a
 * `<local-command-stdout>` is what it printed, ANSI stripped; `[Request interrupted by user]`
 * is the interrupt. Everything else in these tags (`<command-message>`, an empty stdout) adds
 * nothing to read.
 */
function noteFrom(text: string): string | null {
  if (/^\[Request interrupted by user/.test(text)) {
    return 'Interrupted';
  }
  if (!/^<(local-command-stdout|local-command-stderr|command-name|command-message)/.test(text)) {
    return null;
  }
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim() || '';
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() || '';

  if (name) {
    return `${ name }${ args ? ` ${ args }` : '' }`;
  }
  const out = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/.exec(text)?.[1] || '';

  return out.replace(ANSI, '').trim();
}

function sameTurn(a: ChatMessage, b: ChatMessage): boolean {
  // Within a few seconds of each other and no user turn between: the same response.
  return Math.abs(Date.parse(b.at) - Date.parse(a.at)) < 90_000;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((c) => (c?.type === 'text' ? String(c.text || '') : c?.type === 'image' ? '[image]' : '')).join('\n');
  }

  return content == null ? '' : JSON.stringify(content);
}

/** One line that says what a tool call did, for the collapsed row. */
export function toolSummary(call: ChatToolCall): string {
  const input = (call.input || {}) as Record<string, unknown>;

  switch (call.name) {
  case 'Bash': return String(input.description || input.command || '').slice(0, 140);
  case 'Read': return String(input.file_path || '');
  case 'Edit': case 'Write': case 'MultiEdit': return String(input.file_path || '');
  case 'Grep': return `${ input.pattern || '' }${ input.path ? ` in ${ input.path }` : '' }`;
  case 'Glob': return String(input.pattern || '');
  case 'Agent': case 'Task': return String(input.description || input.prompt || '').slice(0, 140);
  case 'Skill': return String(input.skill || '');
  case 'AskUserQuestion': return 'asked a question';
  case 'TodoWrite': return 'updated the plan';
  default: {
    const first = Object.values(input).find((v) => typeof v === 'string');

    return String(first || '').slice(0, 140);
  }
  }
}

// ── Markdown, enough of it ──────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(text: string): string {
  let out = escapeHtml(text);

  out = out.replace(/`([^`]+)`/g, (m, code) => `<code>${ code }</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  return out;
}

// A GitHub-style table: a header row, a delimiter row of dashes, then body rows. Detected by
// the delimiter row, which is the only part whose shape is unambiguous - a plain paragraph can
// hold a pipe, but only a table's second line is all dashes, colons and pipes.

/** Split a table row into cells: drop the optional edge pipes, split on unescaped `|`. */
function tableCells(line: string): string[] {
  let s = line.trim();

  if (s.startsWith('|')) {
    s = s.slice(1);
  }
  if (s.endsWith('|') && !s.endsWith('\\|')) {
    s = s.slice(0, -1);
  }

  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/** The `|---|:--:|` row under a table's header: every cell is dashes, optionally colon-anchored. */
function isDelimiterRow(line: string): boolean {
  if (!line.includes('|') || !line.includes('-')) {
    return false;
  }

  const cells = tableCells(line);

  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** A table begins where a line with a pipe is followed by a delimiter row. */
function isTableStart(lines: string[], i: number): boolean {
  return i + 1 < lines.length && lines[i].includes('|') && isDelimiterRow(lines[i + 1]);
}

/**
 * Markdown to HTML: paragraphs, headings, fenced code, lists, tables, blockquotes, inline code,
 * bold, italics and links. What claude writes in a reply; anything else stays as text.
 */
export function renderMarkdown(text: string): string {
  const lines = (text || '').replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(\w*)/.exec(line);

    if (fence) {
      const code: string[] = [];

      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i++]);
      }
      i++;
      out.push(`<pre><code${ fence[1] ? ` class="lang-${ escapeHtml(fence[1]) }"` : '' }>${ escapeHtml(code.join('\n')) }</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);

    if (heading) {
      const level = Math.min(6, heading[1].length + 2);

      out.push(`<h${ level }>${ inline(heading[2]) }</h${ level }>`);
      i++;
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];

      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '');

        i++;
        // Continuation lines, indented.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          item += ` ${ lines[i++].trim() }`;
        }
        items.push(`<li>${ inline(item) }</li>`);
      }
      out.push(`<${ ordered ? 'ol' : 'ul' }>${ items.join('') }</${ ordered ? 'ol' : 'ul' }>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = tableCells(line);
      // A cell's alignment comes from where the colons sit in the delimiter row.
      const aligns = tableCells(lines[i + 1]).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');

        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });

      i += 2;
      const rows: string[][] = [];

      // Body rows run until a line without a pipe (a blank line or the next block).
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !/^\s*```/.test(lines[i])) {
        rows.push(tableCells(lines[i++]));
      }

      const align = (idx: number) => (aligns[idx] ? ` style="text-align:${ aligns[idx] }"` : '');
      const head = header.map((c, idx) => `<th${ align(idx) }>${ inline(c) }</th>`).join('');
      const body = rows.map((r) => `<tr>${ header.map((_, idx) => `<td${ align(idx) }>${ inline(r[idx] || '') }</td>`).join('') }</tr>`).join('');

      // Wrapped so a wide table scrolls in its own box rather than widening the chat panel.
      out.push(`<div class="mc-chat__table-wrap"><table><thead><tr>${ head }</tr></thead><tbody>${ body }</tbody></table></div>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];

      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      }
      out.push(`<blockquote>${ renderMarkdown(quote.join('\n')) }</blockquote>`);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [];

    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !isTableStart(lines, i)) {
      para.push(lines[i++]);
    }
    out.push(`<p>${ inline(para.join('\n')).replace(/\n/g, '<br>') }</p>`);
  }

  return out.join('\n');
}

// ── What the pane is asking, read off its last lines ────────────────────────────────────────

export interface PaneOption {
  key: string;
  label: string;
  selected: boolean;
}

export interface PaneDialog {
  kind: 'options' | 'yes-no' | 'login' | 'code' | 'text';
  /** The lines above the choices: the question. */
  prompt: string;
  options: PaneOption[];
  /** The login URL, when the pane is showing one. */
  url: string;
}

export interface PaneState {
  /** claude is working (its status line says "esc to interrupt"). */
  busy: boolean;
  /** The prompt is up and empty: claude is waiting to be told something. */
  idle: boolean;
  /** Something is being asked that is not a free-text prompt. */
  dialog: PaneDialog | null;
  /** Claude exited to a shell, or has not started. */
  gone: boolean;
  /** The status line's own words, when it has some ("Brewing for 12s"). */
  status: string;
}

const FURNITURE = /^[\s─╌═┃│┌┐└┘╭╮╰╯▔▁]+$/;

function clean(line: string): string {
  return line.replace(/[│┃]/g, ' ').replace(/\s+$/, '');
}

/**
 * The pane's state from its last lines.
 *
 * Claude Code's UI is regular enough to read: a numbered list with `❯` on the current choice
 * is a question; `(y/n)` is a confirmation; an oauth URL is a login; "esc to interrupt" means
 * it is working; a bare `❯` on the input row means it is listening.
 */
export function readPane(text: string): PaneState {
  const raw = text.replace(/\r/g, '').split('\n');
  const lines = raw.map(clean);
  const tail = lines.slice(-40);
  const all = tail.join('\n');
  // Working: the status line says so, or a spinner line is up that has not said "done".
  const spinner = tail.filter((l) => /^\s*[✻✽✶✳⏳·]\s*\S/.test(l) && /(ing|ed)\b.*\d+s/.test(l)).pop() || '';
  const busy = /esc to interrupt|Interrupt ·|tokens · esc|⏳|Thinking…|Working…/i.test(all) || (!!spinner && !/· done|done /.test(spinner));
  const gone = /\[claude exited|\$ $|# $/.test(tail.slice(-3).join('\n')) && !busy;
  const statusMatch = /^\s*[✻✽✶✳·]\s*(\S.*?)(?:\s+·\s+esc to interrupt.*)?$/m.exec(all);
  const status = statusMatch ? statusMatch[1].replace(/\s+/g, ' ').slice(0, 80) : '';

  // A login flow: the URL is what matters, and whether a code is being asked for.
  const url = /(https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com)\/[^\s]*oauth[^\s]*)/i.exec(all.replace(/\n(?=\S)/g, ''))?.[1] || '';

  if (url || /Paste code here/i.test(all)) {
    return {
      busy: false, idle: false, gone: false, status, dialog: {
        kind: /Paste code here/i.test(all) ? 'code' : 'login', prompt: 'Claude needs you to sign in.', options: [], url,
      },
    };
  }

  // Numbered choices, consecutive, the current one marked with ❯.
  const options: PaneOption[] = [];
  let start = -1;

  for (let i = 0; i < tail.length; i++) {
    const m = /^\s*(❯|›|>)?\s*(\d{1,2})\.\s+(\S.*)$/.exec(tail[i]);

    if (m) {
      if (start < 0 || options.length === 0) {
        start = i;
        options.length = 0;
      }
      options.push({ key: m[2], label: m[3].replace(/\s{2,}.*$/, '').trim(), selected: !!m[1] });
    } else if (options.length && tail[i].trim() && !FURNITURE.test(tail[i]) && !/^\s+\S/.test(tail[i])) {
      // A non-empty, non-indented line after the list ends it - unless it is the input row.
      if (/^\s*❯\s*$/.test(tail[i]) || /shift\+tab|esc to|for shortcuts/i.test(tail[i])) {
        break;
      }
      start = -1;
      options.length = 0;
    }
  }

  if (options.length >= 2 && start >= 0) {
    const prompt = tail.slice(Math.max(0, start - 6), start).filter((l) => l.trim() && !FURNITURE.test(l)).join('\n').trim();

    return {
      busy: false, idle: false, gone: false, status, dialog: {
        kind: 'options', prompt, options, url: '',
      },
    };
  }

  if (/\((y\/n|Y\/n|y\/N)\)|\[y\/n\]|\[Y\/n\]/i.test(tail.slice(-6).join('\n'))) {
    const prompt = tail.slice(-6).filter((l) => l.trim() && !FURNITURE.test(l)).join('\n').trim();

    return {
      busy: false, idle: false, gone: false, status, dialog: {
        kind: 'yes-no', prompt, options: [{ key: 'y', label: 'Yes', selected: false }, { key: 'n', label: 'No', selected: false }], url: '',
      },
    };
  }

  const idle = !busy && /^\s*[❯>]\s*$/m.test(tail.slice(-8).join('\n'));

  return {
    busy, idle, gone, status, dialog: null,
  };
}

/** Claude Code's project directory name for a working directory: `/workspace/dashboard` is `-workspace-dashboard`. */
export function projectKey(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

// ── Paths in what was said, as things to open ───────────────────────────────────────────────

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const VIDEO_EXT = /\.(webm|mp4|mov|mkv)$/i;
/**
 * An absolute path under one of the roots a pane works in. Not preceded by a word character,
 * a quote or `=`, so a URL's path and an HTML attribute are left alone; ends before whitespace
 * or markup.
 */
// `workspaces` as well as `workspace`: a workspace's tree moved to /workspaces/<name>, and
// for a while every path an agent named there - every recording, every screenshot - was the
// one kind the log would not open, while /var/lib/... beside it was a link.
const PATH_RE = /(^|[^\w"'=/:@.-])((?:~|\/(?:workspaces?|app|tmp|home|root|etc|var|usr|opt|srv|mnt|data))\/[^\s<>"'`)\]&;]*[^\s<>"'`)\]&;.,:!?])/g;

export function mediaKind(path: string): 'image' | 'video' | '' {
  return IMAGE_EXT.test(path) ? 'image' : VIDEO_EXT.test(path) ? 'video' : '';
}

/**
 * Wrap every path in rendered HTML as something to click: a link for a file or directory,
 * and for an image or a recording a thumbnail placeholder as well (ChatPane fills it in from
 * the pod). Runs over HTML this module produced, so tags are its own and never contain a path
 * in an attribute other than the ones it writes.
 */
export function linkPaths(html: string): string {
  return html.replace(PATH_RE, (whole, before, path) => {
    const kind = mediaKind(path);
    const attr = escapeHtml(path);
    const thumb = kind ? `<span class="mc-chat__media" data-path="${ attr }" data-kind="${ kind }"></span>` : '';

    return `${ before }${ thumb }<a class="mc-chat__path" data-path="${ attr }" title="Open ${ attr }">${ escapeHtml(path) }</a>`;
  });
}

/** Plain text (a person's message) as HTML: escaped, line breaks kept, paths clickable. */
export function renderPlain(text: string): string {
  return linkPaths(escapeHtml(text || '').replace(/\n/g, '<br>'));
}

// ── Subagents: the conversations a conversation started ─────────────────────────────────────

export interface ChatAgent {
  id: string;
  description: string;
}

/**
 * The subagents this conversation launched, from its Agent tool calls: the tool's own answer
 * names the agent's id, and the transcript of each is a file of its own beside the session's
 * (`<session>/subagents/agent-<id>.jsonl`), read the same way as the main one.
 */
export function agentsFrom(messages: ChatMessage[]): ChatAgent[] {
  const out: ChatAgent[] = [];

  for (const m of messages) {
    for (const t of m.tools) {
      if (t.name !== 'Agent' && t.name !== 'Task') {
        continue;
      }
      const id = /agentId:\s*([0-9a-f]{8,})/i.exec(t.result || '')?.[1];

      if (id && !out.some((a) => a.id === id)) {
        const input = (t.input || {}) as Record<string, unknown>;

        out.push({ id, description: String(input.description || input.prompt || id).slice(0, 60) });
      }
    }
  }

  return out;
}
