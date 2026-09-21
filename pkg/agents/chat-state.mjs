// What a conversation is doing, decided from what claude wrote down rather than from what its
// terminal looks like.
//
// Plain JavaScript on purpose. This is imported by the chat view (ChatPane.vue, through
// chat.ts) and copied into the agent pod by the verifier (scripts/chat-verify.mjs), which
// drives a real claude through every state it has and checks that this file names each one
// correctly. One source, so the thing that is tested is the thing that ships.
//
// Four inputs, in order of authority:
//
//   1. the transcript - claude's own record: turns start with a user prompt line, end with a
//      `turn_duration` system line (or an interrupt), and in between the model's stop_reason
//      says whether it is waiting on a tool; questions are a tool_use with no result yet; the
//      input queue is written as `queue-operation` lines as it changes.
//   2. the hook state file (seed/chat-hook.mjs) - SessionStart, UserPromptSubmit, Stop,
//      Notification, SessionEnd - for the moments the transcript is silent: the seconds before
//      a prompt line lands, and an exit.
//   3. whether the claude process is alive in the pane, which outranks both: a transcript
//      cannot say that its writer died mid-turn.
//   4. the pane's last lines, read for one thing only: the login flow, which no other channel
//      carries.

/** @typedef {{ phase: 'absent'|'gone'|'idle'|'working'|'question'|'waiting'|'login', since: string, status: string, verb: string, queue: string[], question: object|null, login: object|null, model: string, effort: string, mode: string, permissionMode: string, title: string, cost: object|null, outputTokens: number, lastEnd: string, interrupted: boolean }} ChatState */

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Parse transcript lines, dropping the partial and the unreadable. */
export function parseEntries(lines) {
  const out = [];

  for (const line of lines) {
    if (!line || !line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);

      if (entry && typeof entry === 'object') {
        out.push(entry);
      }
    } catch {
      // A line cut mid-write; the next read completes it.
    }
  }

  return out;
}

function blocksOf(entry) {
  const content = entry?.message?.content;

  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  return Array.isArray(content) ? content : [];
}

function textOf(entry) {
  return blocksOf(entry).filter((b) => b.type === 'text').map((b) => String(b.text || '')).join('\n').trim();
}

/** A user line that is the person (or a queued prompt) speaking - not a tool result, not the CLI's furniture. */
export function isPromptEntry(entry) {
  if (entry.type !== 'user' || entry.isMeta === true) {
    // isMeta: the CLI's own line (the `[Image: source: …]` companion of a pasted image), not
    // the person's and not a turn of its own.
    return false;
  }
  const blocks = blocksOf(entry);

  if (blocks.some((b) => b.type === 'tool_result')) {
    return false;
  }
  const text = textOf(entry);

  if (!text && !blocks.some((b) => b.type === 'image')) {
    return false;
  }
  if (/^\[Request interrupted by user/.test(text)) {
    return false;
  }
  // A local command (`/model`, `/cost`), its output and the caveat the CLI writes above them
  // are all user lines; the command ran inside the CLI and no turn started for it. Matched on
  // the tag families rather than a list of tags: `<local-command-caveat>` was the one the list
  // did not have, and it read as a prompt for twenty seconds after every `/model`.
  if (/^<(local-command-|command-)/.test(text)) {
    return false;
  }
  // A background task's completion (`<task-notification>`) is a user line too, and it does
  // start a turn - claude picks the result up and works - so it counts here, for the phase.
  // It is not the person speaking, and the chat shows it as a note (chat.ts, noteFrom).

  return true;
}

export function isInterruptEntry(entry) {
  return entry.type === 'user' && /^\[Request interrupted by user/.test(textOf(entry));
}

function isTurnEnd(entry) {
  if (entry.type === 'system' && (entry.subtype === 'turn_duration' || entry.subtype === 'stop_hook_summary')) {
    return true;
  }
  if (entry.type === 'assistant') {
    const stop = entry.message?.stop_reason;

    return stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens';
  }

  return isInterruptEntry(entry);
}

function isTurnStart(entry) {
  return isPromptEntry(entry) || (entry.type === 'queue-operation' && entry.operation === 'dequeue');
}

/**
 * The CLI's input queue, replayed from its own record of it.
 *
 * `enqueue` adds what was typed while claude was busy; `dequeue` takes the front to start a
 * turn on it; `remove` takes a named one out (absorbed into the running turn, or deleted);
 * `popAll` empties it. What is left is what is still waiting - and it is the CLI's list, not a
 * guess made from matching text, so a message shows as queued exactly as long as it is.
 */
export function foldQueue(entries, sinceIndex = 0) {
  let queue = [];

  for (let i = sinceIndex; i < entries.length; i++) {
    const entry = entries[i];

    if (entry.type !== 'queue-operation') {
      continue;
    }
    const content = typeof entry.content === 'string' ? entry.content : '';

    switch (entry.operation) {
    case 'enqueue': queue.push(content); break;
    case 'dequeue': queue.shift(); break;
    case 'remove': {
      const at = queue.indexOf(content);

      if (at >= 0) {
        queue.splice(at, 1);
      } else {
        queue.shift();
      }
      break;
    }
    case 'popAll': queue = []; break;
    default: break;
    }
  }

  return queue;
}

/** The question claude is waiting on, if the last one it asked has no answer yet. */
export function pendingQuestion(entries) {
  const answered = new Set();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];

    if (entry.type === 'user') {
      for (const b of blocksOf(entry)) {
        if (b.type === 'tool_result') {
          answered.add(b.tool_use_id);
        }
      }
      continue;
    }
    if (entry.type !== 'assistant') {
      continue;
    }
    for (const b of blocksOf(entry)) {
      if (b.type !== 'tool_use') {
        continue;
      }
      if (QUESTION_TOOLS.has(b.name)) {
        if (answered.has(b.id)) {
          return null;
        }

        return {
          id:        b.id,
          tool:      b.name,
          at:        entry.timestamp || '',
          questions: b.name === 'AskUserQuestion' ? (b.input?.questions || []) : [],
          plan:      b.name === 'ExitPlanMode' ? String(b.input?.plan || '') : '',
        };
      }
      // Any other tool call after the question means it was answered and the turn moved on.
      if (!answered.has(b.id)) {
        // An unanswered non-question tool: claude is mid-tool, no question pending.
        return null;
      }
    }
  }

  return null;
}

const OAUTH_RE = /(https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com)\/[^\s]*oauth[^\s]*)/i;

/** The login flow, the one state only the pane shows. */
export function loginFrom(paneText) {
  const flat = String(paneText || '').replace(/\r/g, '').split('\n').slice(-40).map((l) => l.replace(/[│┃]/g, ' ').trimEnd()).join('\n');
  const url = OAUTH_RE.exec(flat.replace(/\n(?=\S)/g, ''))?.[1] || '';
  const code = /Paste code here/i.test(flat);

  if (!url && !code) {
    return null;
  }

  return { kind: code ? 'code' : 'login', url };
}

/** The spinner's verb, when the pane has one ("Herding" from "✻ Herding… (5m 30s · ↓ 25.2k tokens)"). */
export function verbFrom(paneText) {
  const lines = String(paneText || '').replace(/\r/g, '').split('\n').slice(-12);

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*[✻✽✶✳·∗*]\s*([A-Z][a-z]+)…/.exec(lines[i]);

    if (m) {
      return m[1];
    }
  }

  return '';
}

export function duration(ms) {
  if (!(ms > 0)) {
    return '0s';
  }
  const s = Math.floor(ms / 1000);

  if (s < 60) {
    return `${ s }s`;
  }
  const m = Math.floor(s / 60);

  if (m < 60) {
    return `${ m }m ${ s % 60 }s`;
  }

  return `${ Math.floor(m / 60) }h ${ m % 60 }m`;
}

export function tokens(n) {
  return n >= 1000 ? `${ (n / 1000).toFixed(1) }k` : String(n);
}

/**
 * The state, from the four inputs.
 *
 * @param {object} input
 * @param {object[]} input.entries   parsed transcript lines, in file order
 * @param {object|null} input.hook   the last hook event (chat-hook.mjs), or null
 * @param {boolean} input.attached   the tmux session exists
 * @param {boolean} input.alive      a claude process is running in it
 * @param {string} input.paneText    the pane's last lines
 * @param {number} [input.now]       ms
 * @returns {ChatState}
 */
export function deriveState(input) {
  const {
    entries = [], hook = null, attached = false, alive = false, paneText = '',
  } = input;
  const now = input.now || Date.now();
  const state = {
    phase:          'idle',
    since:          '',
    status:         '',
    verb:           '',
    queue:          [],
    question:       null,
    login:          null,
    model:          '',
    effort:         '',
    mode:           '',
    permissionMode: '',
    title:          '',
    cost:           null,
    outputTokens:   0,
    lastEnd:        '',
    interrupted:    false,
  };

  // The facts that ride on the transcript whatever the phase is.
  let lastStart = -1;
  let lastEnd = -1;
  let lastStartAt = '';
  let lastEndAt = '';
  let sessionStartIndex = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (entry.type === 'assistant' && entry.message?.model) {
      state.model = entry.message.model;
    }
    if (entry.perTurnEffort) {
      state.effort = String(entry.perTurnEffort);
    } else if (entry.effort) {
      state.effort = String(entry.effort);
    }
    if (entry.type === 'mode' && entry.mode) {
      state.mode = entry.mode;
    }
    if (entry.type === 'permission-mode' && entry.permissionMode) {
      state.permissionMode = entry.permissionMode;
    }
    if (entry.type === 'ai-title' && entry.aiTitle) {
      state.title = entry.aiTitle;
    }
    if (entry.type === 'cost-state') {
      state.cost = {
        totalCostUSD: entry.totalCostUSD || 0, modelUsage: entry.modelUsage || {}, totalDuration: entry.totalDuration || 0,
      };
    }
    if (isTurnStart(entry)) {
      lastStart = i;
      lastStartAt = entry.timestamp || lastStartAt;
    }
    if (isTurnEnd(entry)) {
      lastEnd = i;
      lastEndAt = entry.timestamp || lastEndAt;
      state.interrupted = isInterruptEntry(entry);
    }
  }

  // The hook's SessionStart, if newer than the transcript's last queue activity, empties the
  // queue: claude starts with nothing queued, whatever the file still says was.
  if (hook?.event === 'SessionStart' && hook.at) {
    const startedAt = Date.parse(hook.at);

    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === 'queue-operation' && Date.parse(entries[i].timestamp || '') < startedAt) {
        sessionStartIndex = i + 1;
        break;
      }
    }
  }
  state.queue = foldQueue(entries, sessionStartIndex);
  state.lastEnd = lastEndAt;

  // Output this turn, for the status line.
  if (lastStart > lastEnd) {
    for (let i = lastStart; i < entries.length; i++) {
      if (entries[i].type === 'assistant') {
        state.outputTokens += Number(entries[i].message?.usage?.output_tokens || 0);
      }
    }
  }

  // Liveness first: nothing below can be true of a claude that is not running.
  if (!attached) {
    state.phase = 'absent';
    state.queue = [];

    return state;
  }
  if (!alive) {
    state.phase = 'gone';
    state.queue = [];
    // The pane's loop (claude-session.sh) says what it is doing when claude is not there:
    // restarting in a moment, or giving up after three quick exits and waiting for Enter.
    // Its own words beat a guess, and the last one is the one that stands.
    const loop = String(paneText || '').match(/\[claude (?:exited|keeps exiting)[^\]]*\]/g);

    if (loop && loop.length) {
      state.status = loop[loop.length - 1].slice(1, -1);
      state.status = state.status.charAt(0).toUpperCase() + state.status.slice(1);
    } else if (hook?.event === 'SessionEnd') {
      state.status = `Claude exited (${ hook.reason || 'unknown' })`;
    } else {
      state.status = 'Claude is not running in this pane';
    }

    return state;
  }

  state.login = loginFrom(paneText);
  if (state.login) {
    state.phase = 'login';
    state.status = 'Claude needs you to sign in';

    return state;
  }

  state.question = pendingQuestion(entries);
  if (state.question) {
    state.phase = 'question';
    state.since = state.question.at;
    state.status = state.question.tool === 'ExitPlanMode' ? 'Waiting for you to approve the plan' : 'Waiting for your answer';

    return state;
  }

  // claude said it is waiting - a permission prompt, a question the transcript has not caught
  // up with, an idle prompt - and nothing has started since. The Notification hook is the CLI
  // saying so directly, and it outranks the transcript's "a turn is open" for as long as no
  // newer prompt has been submitted.
  const hookAt = hook?.at ? Date.parse(hook.at) : 0;

  const startMs = lastStartAt ? Date.parse(lastStartAt) : 0;
  const endMs = lastEndAt ? Date.parse(lastEndAt) : 0;
  // A notification is spent once claude has written anything after it: the answer went in,
  // the turn moved on, and the CLI sends no "no longer waiting" of its own.
  let activityMs = 0;

  for (let i = entries.length - 1; i >= 0 && !activityMs; i--) {
    if ((entries[i].type === 'user' || entries[i].type === 'assistant') && entries[i].timestamp) {
      activityMs = Date.parse(entries[i].timestamp);
    }
  }

  if (hook?.event === 'Notification' && hookAt && hookAt >= startMs - 2000 && hookAt > endMs && hookAt >= activityMs - 2000) {
    // "Waiting for your input" is sent for an empty prompt *and* for a dialog left open a
    // minute - the CLI does not distinguish. The transcript does: a turn that has started and
    // not ended is a dialog inside a turn, which is "waiting", not "ready". Reading idle_prompt
    // as idle regardless is how a question left open came to be shown as a free prompt.
    if (hook.notification === 'idle_prompt' && lastStart <= lastEnd) {
      state.phase = 'idle';
      state.since = hook.at;
      state.status = state.interrupted ? 'Interrupted' : 'Ready';

      return state;
    }
    state.phase = 'waiting';
    state.since = hook.at;
    state.status = hook.notification === 'idle_prompt' ? 'Claude is waiting for you in the terminal' : (hook.message || 'Claude is waiting for you in the terminal');

    return state;
  }

  // Working, by the transcript's order; the hook can only move it forward in time, which is
  // the case it exists for: the seconds between Enter and the prompt line landing, and the
  // Stop that lands before turn_duration does.
  let working = lastStart > lastEnd;

  if (hook && hookAt) {
    const startAt = lastStartAt ? Date.parse(lastStartAt) : 0;
    const endAt = lastEndAt ? Date.parse(lastEndAt) : 0;

    if (hook.event === 'UserPromptSubmit' && hookAt > endAt && hookAt >= startAt - 2000) {
      working = true;
      if (!lastStartAt || hookAt > startAt) {
        lastStartAt = hook.at;
      }
    } else if (hook.event === 'Stop' && hookAt >= startAt) {
      working = false;
    } else if (hook.event === 'Notification' && hook.notification === 'idle_prompt' && hookAt >= startAt) {
      working = false;
    }
  }

  if (working) {
    state.phase = 'working';
    state.since = lastStartAt;
    state.verb = verbFrom(paneText) || 'Working';
    const elapsed = lastStartAt ? now - Date.parse(lastStartAt) : 0;

    state.status = `${ state.verb } for ${ duration(elapsed) }${ state.outputTokens ? ` · ↓ ${ tokens(state.outputTokens) } tokens` : '' }`;

    return state;
  }

  state.phase = 'idle';
  state.since = lastEndAt;
  state.status = state.interrupted ? 'Interrupted' : 'Ready';

  return state;
}

/**
 * ── What the CLI does to the words before it writes them down ──────────────────────────
 *
 * A message sent from this view is a bracketed paste into the CLI's input box (say(), in
 * ChatPane), and past about a hundred characters - or at the first newline - the box folds a
 * paste into a placeholder, `[Pasted text #1]`. At submit it writes the placeholder back out
 * into the transcript, wrapped:
 *
 *     <pasted_content id="9232">
 *     Also, it seems like I'm having an issue with the new workspace I just created …
 *     </pasted_content id="9232">
 *
 * So the sentence that was sent and the sentence that was recorded are two different strings,
 * and both of the things this view does with a person's message were wrong about it. The log
 * drew the tags, verbatim, with the sentence inside them. The matcher, comparing character for
 * character, never saw the two as one message, so the copy held while the transcript caught up
 * stayed on screen and then said it had not been delivered. One message, shown twice, the
 * second copy carrying an error.
 *
 * The closing tag carries the id, which makes it not XML, so a general tag strip does not
 * match it. Read here the way the CLI reads it - the id is four hex characters, each tag owns
 * the newline after it, and the blank lines the CLI put around the block come away with it -
 * so text that merely mentions `<pasted_content id="…">` is left alone.
 */

const PASTE_OPEN = '<pasted_content id="';
const PASTE_ID = /^[0-9a-f]{4}$/;

/** @typedef {{ kind: 'text'|'paste', text: string }} PromptPart */

/**
 * A recorded prompt split into what was typed and what was pasted, in order.
 *
 * @param {string} text
 * @returns {PromptPart[]}
 */
export function splitPasted(text) {
  const s = String(text || '');
  /** @type {PromptPart[]} */
  const parts = [];
  let from = 0;
  let at = 0;

  for (;;) {
    const open = s.indexOf(PASTE_OPEN, at);

    if (open < 0) {
      break;
    }
    const idAt = open + PASTE_OPEN.length;
    const id = s.slice(idAt, idAt + 4);

    if (!PASTE_ID.test(id) || !s.startsWith('">\n', idAt + 4)) {
      at = idAt;
      continue;
    }
    const bodyAt = idAt + 4 + 3;
    const close = `\n</pasted_content id="${ id }">`;
    const closeAt = s.indexOf(close, bodyAt - 1);

    if (closeAt < 0) {
      break;
    }
    // The blank line the CLI put in front of the block belongs to the block, not to the
    // sentence before it; the same after it. Taking them here is what makes the unwrapped
    // text read as the one thing the person sent.
    let head = open;

    for (let i = 0; i < 2 && head > from && s[head - 1] === '\n'; i++) {
      head--;
    }
    if (head > from) {
      parts.push({ kind: 'text', text: s.slice(from, head) });
    }
    parts.push({ kind: 'paste', text: s.slice(bodyAt, closeAt) });
    from = closeAt + close.length;
    for (let i = 0; i < 2 && s[from] === '\n'; i++) {
      from++;
    }
    at = from;
  }
  if (from < s.length) {
    parts.push({ kind: 'text', text: s.slice(from) });
  }

  return parts;
}

/** The same prompt as the person wrote it: the tags gone, nothing else changed. */
export function unwrapPasted(text) {
  return splitPasted(text).map((p) => p.text).join('');
}

/**
 * A prompt's text as it compares, on either side of the CLI.
 *
 * Everything the CLI rewrites between the box and the transcript comes out here, on both
 * sides, so what is compared is the sentence rather than the CLI's rendering of it:
 *
 *   - a paste, wrapped in `<pasted_content>` tags (above);
 *   - an image path - the chat's own screenshots go in as `/workspace/.images/….png` - read,
 *     replaced by `[Image #1]` (or `[Image: source: …]`) and moved to the front;
 *   - a paste the box was still showing folded, as `[Pasted text #1 +40 lines]`, or trimmed,
 *     as `[...Truncated text #1 …]`;
 *   - the spacing left behind by any of it.
 */
export function promptKey(text) {
  return unwrapPasted(text)
    .replace(/\[(?:Image|Pasted text|\.{3}Truncated text)[^\]]*\]/g, ' ')
    .replace(/(^|\s)\/\S+\.(png|jpe?g|gif|webp|bmp)(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The CLI's own user lines rather than a person's: a background task finishing, a reminder,
 * the summary a compact writes back into the conversation.
 *
 * isPromptEntry counts all three, because each of them does start a turn and the phase has to
 * say so. None of them is evidence that a message typed here landed, which is what separates
 * this from that: a `<task-notification>` arriving two seconds after Enter must not be read as
 * the message being delivered.
 */
function isCliPrompt(entry) {
  const text = textOf(entry);

  return entry.isCompactSummary === true ||
    /^\s*<(task-notification|system-reminder)>/.test(text) ||
    /^This session is being continued from a previous conversation/.test(text);
}

/**
 * Every record of a prompt having reached claude, oldest first.
 *
 * Five channels write one and a message appears in whichever is quickest, so this is the whole
 * evidence that something typed here landed: the CLI's live input queue, the UserPromptSubmit
 * hook, the `enqueue` written when a message is typed into a running turn, the attachment
 * written when that message is absorbed into the turn, and the user line of the transcript.
 *
 * `at` is when claude has it; a queue entry is the live list, so it is now by definition.
 */
export function promptRecords(entries, hook, queue = [], now = Date.now()) {
  const records = [];

  for (const entry of entries) {
    const at = Date.parse(entry.timestamp || '') || 0;

    if (entry.type === 'queue-operation' && entry.operation === 'enqueue') {
      records.push({ key: promptKey(entry.content), at });
    } else if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
      records.push({ key: promptKey(entry.attachment.prompt), at });
    } else if (isPromptEntry(entry) && !isCliPrompt(entry)) {
      records.push({ key: promptKey(textOf(entry)), at });
    }
  }
  if (hook?.event === 'UserPromptSubmit') {
    records.push({ key: promptKey(hook.prompt), at: Date.parse(hook.at || '') || now });
  }
  records.sort((a, b) => a.at - b.at);
  // Last, and timeless: what is in the queue is waiting right now, whenever it was typed.
  for (const text of queue) {
    records.push({ key: promptKey(text), at: now });
  }

  return records.filter((r) => r.key);
}

/** Clock slack between the moment Enter was pressed here and the timestamp claude writes. */
const GRACE = 2000;
/** How long a message with no record of it anywhere may go before the view says so. */
const UNRECORDED_AFTER = 20000;

/**
 * Reconcile the copies this view is holding against claude's own record of them.
 *
 * The copies exist for one reason: the seconds between Enter and the transcript line, where a
 * log that showed only what claude had written down would be missing the thing just sent. So
 * the moment there is a record, the copy goes - and what is left on screen is the transcript,
 * once, which is the only version of a message that can be trusted to be what claude read.
 *
 * Matched in two passes, because matching on the text alone is what kept going wrong. First by
 * what was said: each record is spent on at most one copy, so saying the same thing twice
 * retires one and leaves the other showing. Then, for anything still outstanding, by order:
 * an unclaimed prompt claude recorded after this one was sent retires the oldest copy waiting
 * on one. That second pass is the part that does not rot. The CLI reshapes a prompt on its way
 * to the transcript whenever it likes - `[Image #1]` yesterday, `<pasted_content>` today - and
 * every one of those has shown up here as a delivered message wearing "not delivered". Order
 * survives all of it: nothing but this box and the terminal beside it can put a prompt into
 * that pane, and if the person typed one there directly, the message did go in.
 */
export function reconcilePending(pending, {
  entries = [], hook = null, queue = [], gone = false, now = Date.now(),
} = {}) {
  if (!pending.length) {
    return pending;
  }
  if (gone) {
    // No claude to have taken it: the message is not going anywhere from here.
    return same(pending, pending.map((p) => (p.failed ? p : { ...p, failed: true })));
  }
  const records = promptRecords(entries, hook, queue, now);
  const spent = new Set();
  const claim = (from, wanted) => {
    const hit = records.findIndex((r, i) => !spent.has(i) && r.at >= from - GRACE && (wanted === null || r.key === wanted));

    if (hit >= 0) {
      spent.add(hit);
    }

    return hit >= 0;
  };
  // A copy of something that is not a prompt at all - a slash command, an empty box - has
  // nothing to wait for; it is not this list's business.
  const waiting = pending.map((p) => ({ p, key: promptKey(p.text) })).filter((w) => !!w.key);
  const left = waiting.filter((w) => !claim(w.p.sentAt, w.key)).map((w) => w.p);
  const still = left.filter((p) => !claim(p.sentAt, null))
    .map((p) => (now - p.sentAt > UNRECORDED_AFTER && !p.failed ? { ...p, failed: true } : p));

  return same(pending, still);
}

/** The list it was given when nothing about it changed, so a watcher does not fire on a copy. */
function same(before, after) {
  const unchanged = before.length === after.length && after.every((p, i) => p === before[i]);

  return unchanged ? before : after;
}

/**
 * Whether one message this view sent has reached claude - the single-message form of
 * reconcilePending, for the verifier.
 */
export function sentSeen(text, sentAt, entries, hook, queue) {
  if (!promptKey(text)) {
    return true;
  }

  return !reconcilePending([{ text, sentAt }], {
    entries, hook, queue, now: sentAt,
  }).length;
}
