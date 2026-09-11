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
  if (entry.type !== 'user') {
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
 * Whether a message this view sent has been taken by claude: it is in the queue, or it became
 * the prompt of a turn, or the hook saw it submitted. Text-equal, and only on or after the
 * moment it was sent; a message that matches nothing for a while was not delivered.
 */
export function sentSeen(text, sentAt, entries, hook, queue) {
  const wanted = String(text || '').trim();

  if (!wanted) {
    return true;
  }
  if (queue.some((q) => String(q).trim() === wanted)) {
    return true;
  }
  if (hook?.event === 'UserPromptSubmit' && String(hook.prompt || '').trim() === wanted && Date.parse(hook.at) >= sentAt - 2000) {
    return true;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const at = Date.parse(entry.timestamp || '') || 0;

    if (at && at < sentAt - 2000) {
      break;
    }
    if (entry.type === 'queue-operation' && entry.operation === 'enqueue' && String(entry.content || '').trim() === wanted) {
      return true;
    }
    if (isPromptEntry(entry) && textOf(entry) === wanted) {
      return true;
    }
  }

  return false;
}
