// What claude is doing, written down by claude itself.
//
// The chat view used to read a conversation's state off the terminal: regexes over the last
// forty lines of a TUI, looking for "esc to interrupt" and a bare prompt. That is guesswork
// about a picture, and it guessed wrong in both directions - "working" hours after claude had
// stopped, because a spinner line was still in the scrollback, and "ready" while it was mid-tool.
//
// Claude Code has hooks for exactly these moments, and this is the one script behind all of
// them. It is registered (claude-defaults.mjs) for:
//
//   SessionStart      claude is up, on this transcript
//   UserPromptSubmit  a turn began, and what it began with
//   Stop              the turn is over
//   Notification      claude is waiting: an idle prompt, a permission prompt, a question
//   SessionEnd        claude exited, and why
//
// Each firing rewrites one small file, `<sessions>/<pane>.state.json`, with the latest event,
// and appends a line to `<pane>.events.jsonl` so a sequence can be read back when something
// looks wrong. The pane is MC_SESSION, which shell.sh puts in claude's environment; the hook
// payload itself only knows the transcript's uuid.
//
// Nothing here is authoritative on its own. The chat crosses it with the transcript (which
// carries the turn boundaries too) and with whether the claude process is alive - a hook can
// only record what claude lived to tell it.
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/app/.home';
const SESSION = process.env.MC_SESSION || '';
const DIR = path.join(path.dirname(HOME), 'sessions');

let payload = {};

try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  // A hook with nothing readable on stdin still records that it fired.
}

if (!SESSION) {
  process.exit(0);
}

const event = {
  event:      payload.hook_event_name || process.argv[2] || 'unknown',
  at:         new Date().toISOString(),
  sessionId:  payload.session_id || '',
  transcript: payload.transcript_path || '',
  cwd:        payload.cwd || '',
  pid:        process.ppid,
};

// The parts of each payload the chat reads. Kept short on purpose: the transcript has the
// content, this has the moment.
if (payload.prompt !== undefined) {
  event.prompt = String(payload.prompt).slice(0, 2000);
}
if (payload.notification_type) {
  event.notification = payload.notification_type;
  event.message = String(payload.message || '').slice(0, 500);
}
if (payload.reason) {
  event.reason = payload.reason;
}
if (payload.stop_hook_active !== undefined) {
  event.stopHookActive = !!payload.stop_hook_active;
}

try {
  fs.mkdirSync(DIR, { recursive: true });
  const state = path.join(DIR, `${ SESSION }.state.json`);
  const tmp = `${ state }.${ process.pid }`;

  // Rename, so a reader never sees half a file.
  fs.writeFileSync(tmp, `${ JSON.stringify(event) }\n`);
  fs.renameSync(tmp, state);

  const log = path.join(DIR, `${ SESSION }.events.jsonl`);

  fs.appendFileSync(log, `${ JSON.stringify(event) }\n`);
  // Bounded: the last thousand lines are more than a debugging session needs.
  try {
    const stat = fs.statSync(log);

    if (stat.size > 512 * 1024) {
      const lines = fs.readFileSync(log, 'utf8').split('\n');

      fs.writeFileSync(log, `${ lines.slice(-500).join('\n') }\n`);
    }
  } catch { /* the trim is best-effort */ }
} catch {
  // A hook must never fail the turn it is observing.
}

process.exit(0);
