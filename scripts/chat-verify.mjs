// Drive a real claude through every state the chat view has to name, and check that
// chat-state.mjs names each one correctly.
//
// Runs inside the agent pod, as the pane user:
//
//   node chat-verify.mjs [session-name]
//
// It makes a scratch tmux session exactly the way shell.sh does, sends it prompts the way the
// chat view does (a tmux paste, then Enter), and after each step samples the four things the
// chat view samples - the transcript, the hook state file, whether claude is alive, and the
// pane's last lines - and asks deriveState what it makes of them. Every expectation here is
// something a person can see in the terminal, so a failure is the chat view being wrong about
// the terminal, which is the one thing it must never be.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deriveState, isPromptEntry, parseEntries, sentSeen } from '/workspace/.chat-state.mjs';

const SESSION = process.argv[2] || 'verify-1';
const HOME = process.env.HOME || '/workspace/.home';
const ROOT = path.dirname(HOME);
const WORKDIR = `/workspace/conversations/${ SESSION }`;
const TMUX = `mc-${ SESSION }`;
const ID_FILE = `${ ROOT }/sessions/${ SESSION }.id`;
const STATE_FILE = `${ ROOT }/sessions/${ SESSION }.state.json`;
const PROJECT = `${ HOME }/.claude/projects/${ WORKDIR.replace(/[/.]/g, '-') }`;

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => { try { return execFileSync('/bin/bash', ['-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stdout || ''); } };
const tmux = (args) => sh(`tmux ${ args }`);

function sample() {
  let entries = [];
  let hook = null;
  const uuid = fs.existsSync(ID_FILE) ? fs.readFileSync(ID_FILE, 'utf8').trim() : '';
  let file = uuid && fs.existsSync(`${ PROJECT }/${ uuid }.jsonl`) ? `${ PROJECT }/${ uuid }.jsonl` : '';

  if (!file && fs.existsSync(PROJECT)) {
    const files = fs.readdirSync(PROJECT).filter((f) => f.endsWith('.jsonl')).map((f) => `${ PROJECT }/${ f }`).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    file = files[0] || '';
  }
  if (file) {
    entries = parseEntries(fs.readFileSync(file, 'utf8').split('\n'));
  }
  try {
    hook = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* none yet */ }
  const attached = tmux(`has-session -t "${ TMUX }" 2>/dev/null && echo yes`).includes('yes');
  let alive = false;
  let paneText = '';

  if (attached) {
    const pid = tmux(`display -p -t "${ TMUX }" '#{pane_pid}'`).trim();

    alive = !!pid && sh(`pgrep -P ${ pid } -x claude`).trim() !== '';
    paneText = tmux(`capture-pane -p -t "${ TMUX }" | tail -n 40`);
  }
  const state = deriveState({
    entries, hook, attached, alive, paneText,
  });

  return {
    entries, hook, attached, alive, paneText, state, file,
  };
}

/** The pane's own word for it, as a cross-check: what a person reading the terminal would say. */
function paneSays(paneText) {
  const tail = paneText.split('\n').slice(-14).join('\n');

  if (/esc to interrupt/i.test(tail)) {
    return 'working';
  }
  if (/^\s*[❯>]\s*$/m.test(tail)) {
    return 'idle';
  }

  return '?';
}

async function waitFor(label, test, timeoutMs = 120000) {
  const started = Date.now();
  let last = sample();

  while (Date.now() - started < timeoutMs) {
    if (test(last)) {
      results.push({ label, ok: true, ms: Date.now() - started, state: last.state.phase, pane: paneSays(last.paneText) });
      console.log(`PASS  ${ label }  (${ Date.now() - started }ms) phase=${ last.state.phase } pane=${ paneSays(last.paneText) } status="${ last.state.status }"`);

      return last;
    }
    await sleep(1000);
    last = sample();
  }
  results.push({ label, ok: false, ms: Date.now() - started, state: last.state.phase, pane: paneSays(last.paneText) });
  console.log(`FAIL  ${ label }  phase=${ last.state.phase } pane=${ paneSays(last.paneText) } status="${ last.state.status }" hook=${ JSON.stringify(last.hook) }`);
  console.log('      pane tail:', JSON.stringify(last.paneText.split('\n').filter((l) => l.trim()).slice(-6)));
  console.log('      last entries:', last.entries.slice(-4).map((e) => `${ e.type }/${ e.subtype || e.operation || e.message?.stop_reason || '' }`).join(' '));

  return last;
}

function paste(text) {
  const f = `/tmp/.verify-${ Date.now().toString(36) }`;

  fs.writeFileSync(f, text);
  tmux(`load-buffer -b verify ${ f } && tmux paste-buffer -b verify -t "${ TMUX }" -d -p && sleep 0.3 && tmux send-keys -t "${ TMUX }" Enter`);
  fs.unlinkSync(f);

  return Date.now();
}

/**
 * Send, the way the chat view does - and, the way the chat view does, notice when the pane
 * did not take it. A paste into the CLI is occasionally dropped (seen once, right after a
 * /model switch): the transcript never records it and no hook fires. The chat shows that as
 * "not delivered - send again"; here it is sent again once, and said so, because the run is
 * about what the chat reads and not about whether tmux delivered a paste.
 */
function send(text) {
  const at = paste(text);
  const slash = /^\//.test(text.trim());

  // A slash command may be a local one that records nothing; only a prompt is checked.
  if (slash) {
    return at;
  }
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    const s = sample();

    if (sentSeen(text, at, s.entries, s.hook, s.state.queue)) {
      return at;
    }
    execFileSync('/bin/sleep', ['0.5']);
  }
  console.log(`      (the pane did not take "${ text.slice(0, 40) }…" within 8s - sending it again)`);

  return paste(text);
}

function keys(...ks) {
  tmux(`send-keys -t "${ TMUX }" ${ ks.map((k) => `'${ k }'`).join(' ') }`);
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────

console.log(`# chat-verify: session ${ SESSION }`);
tmux(`kill-session -t "${ TMUX }" 2>/dev/null`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
fs.rmSync(PROJECT, { recursive: true, force: true });
fs.rmSync(ID_FILE, { force: true });
fs.rmSync(STATE_FILE, { force: true });
fs.mkdirSync(WORKDIR, { recursive: true });
fs.mkdirSync(`${ ROOT }/sessions`, { recursive: true });
fs.writeFileSync(`${ WORKDIR }/CLAUDE.md`, '# Verification session\nYou are being used to verify a chat UI. Do exactly what each message asks, briefly.\n');

const env = `env HOME=${ HOME } PATH=${ HOME }/.local/bin:$PATH TERM=xterm-256color MC_SESSION=${ SESSION } MC_RESTART_FLAG=${ ROOT }/.restart/${ SESSION }`;

tmux(`-f /seed/tmux.conf new-session -d -s "${ TMUX }" -c "${ WORKDIR }" "${ env } /bin/bash /seed/claude-session.sh '' '${ ID_FILE }'"`);

// S1: it comes up idle.
// Idle by the state *and* a prompt drawn on the screen: the state is right about claude
// being up before the input row exists, and a message pasted into that gap is lost - which is
// not something a person at the terminal can do, so it is not something this should do.
await waitFor('S1 starts, alive, idle, prompt drawn', (s) => s.alive && s.state.phase === 'idle' && paneSays(s.paneText) === 'idle', 90000);

// S2: one message, start to finish.
let t = send('Reply with exactly the word OK and nothing else.');

await waitFor('S2 working within seconds of Enter', (s) => s.state.phase === 'working', 15000);
await waitFor('S2 the sent message is seen (not stuck as pending)', (s) => sentSeen('Reply with exactly the word OK and nothing else.', t, s.entries, s.hook, s.state.queue), 15000);
let s = await waitFor('S2 idle again when it answers', (s) => s.state.phase === 'idle', 180000);

console.log(`      pane says: ${ paneSays(s.paneText) }  model=${ s.state.model } effort=${ s.state.effort }`);

// S3: a message while busy is queued, then taken.
//
// The CLI absorbs its queue at the next tool boundary ("remove … absorbed_mid_turn"), so a
// queued message is visible for exactly as long as the running tool call - which is why the
// command is asked for in the foreground with a long timeout. What has to hold whatever claude
// does with it: the message is recorded as queued at some point, it counts as seen the whole
// time (never "waiting for claude" for good), and the turn ends with it taken.
// Not a bare `sleep`: the CLI refuses that in the foreground ("use Monitor"), so a loop that
// prints as it waits, which is an ordinary command and takes the 40 seconds.
t = send('Use the Bash tool, in the foreground (run_in_background false, timeout 90000), to run exactly this and wait for it: for i in $(seq 1 40); do sleep 1; echo tick $i; done ; then reply with the word done.');
await waitFor('S3 working on the long command', (s) => s.state.phase === 'working', 15000);
await sleep(4000);
const t2 = send('After that finishes, reply with the single word SECOND.');
const wasQueued = (s) => s.state.queue.includes('After that finishes, reply with the single word SECOND.')
  || s.entries.some((e) => e.type === 'queue-operation' && e.operation === 'enqueue' && e.content === 'After that finishes, reply with the single word SECOND.');

s = await waitFor('S3 second message is recorded as queued by the CLI', wasQueued, 20000);
console.log(`      queue now: ${ JSON.stringify(s.state.queue) }`);
await waitFor('S3 queued message counts as seen', (s) => sentSeen('After that finishes, reply with the single word SECOND.', t2, s.entries, s.hook, s.state.queue), 5000);
await waitFor('S3 queue drains when the turn takes it', (s) => s.state.queue.length === 0, 180000);
await waitFor('S3 idle after both, nothing left queued', (s) => s.state.phase === 'idle' && s.state.queue.length === 0, 180000);

// S4: a question, asked and answered.
send('Use the AskUserQuestion tool to ask me one question: "Which colour?" with exactly two options, "Red" and "Blue". Do nothing else before asking.');
// The transcript can lag the question by minutes (seen: the tool_use line written only once
// answered), so either the transcript's question or the hook's "claude is waiting" counts -
// both put the chat in a state that is not "working", which is the thing that must never be
// wrong. The options come from the transcript when it has them and from the pane otherwise.
s = await waitFor('S4 question pending (transcript) or waiting (hook)', (s) => (s.state.phase === 'question' && (s.state.question?.questions?.[0]?.options?.length || 0) === 2) || s.state.phase === 'waiting', 180000);
console.log(`      via ${ s.state.phase }: ${ s.state.phase === 'question' ? (s.state.question?.questions?.[0]?.options || []).map((o) => o.label).join(' | ') : JSON.stringify(s.paneText.split('\n').filter((l) => /^\s*(❯|›)?\s*\d\./.test(l)).slice(0, 3)) }`);
keys('1');
await sleep(300);
keys('Enter');
// The answer has to land: the tool_result appears, and the state stops being a question or a
// wait. A state that stays "waiting" here means the keystrokes did not answer the dialog,
// which is a real failure of the chat's answer path, not of its reading.
s = await waitFor('S4 answered: the question is gone (working or idle)', (s) => s.state.phase !== 'question' && s.state.phase !== 'waiting', 30000);
console.log(`      after answer: phase=${ s.state.phase } pane=${ JSON.stringify(s.paneText.split('\n').filter((l) => l.trim()).slice(-4)) }`);
await waitFor('S4 idle after the answer', (s) => s.state.phase === 'idle', 180000);

// S5: /model changes the model the next turn runs on (a local command: no turn of its own).
send('/model sonnet');
await sleep(4000);
s = sample();
console.log(`      after /model: phase=${ s.state.phase } pane=${ paneSays(s.paneText) }`);
await waitFor('S5 /model does not read as working', (s) => s.state.phase === 'idle', 20000);
send('Reply with exactly the word OK.');
await waitFor('S5 the next turn runs on sonnet', (s) => s.state.phase === 'idle' && /sonnet/.test(s.state.model), 180000);
send('/model opus');
await sleep(4000);

// S6: /cost is a local command the transcript does not record at all (its output goes to
// the terminal only): idle throughout, and the session's totals are on the cost-state lines.
send('/cost');
await sleep(3000);
await waitFor('S6 /cost stays idle', (s) => s.state.phase === 'idle', 20000);
// The cost-state line is written on the CLI's own schedule, so its presence is reported
// rather than required: the state that matters here is "idle", which the terminal agrees with.
s = sample();
console.log(`      cost-state: ${ s.state.cost ? `$${ s.state.cost.totalCostUSD.toFixed(4) }` : 'not written yet' }`);
console.log(`      pane after /cost: ${ JSON.stringify(s.paneText.split('\n').filter((l) => /cost|\$|tokens/i.test(l)).slice(-3)) }`);

// S9: a message with an image in it. The chat's screenshots go into the box as a path, and
// the CLI records the prompt with the path gone and `[Image #1]` in front - which read as a
// message that was never delivered while claude was answering it. A real (tiny) PNG, since the
// CLI only rewrites a path it can read as an image.
const shot = `/workspace/.images/verify-${ Date.now().toString(36) }.png`;

fs.mkdirSync('/workspace/.images', { recursive: true });
fs.writeFileSync(shot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
const withShot = `Reply with exactly the word SEEN and nothing else. ${ shot }`;
const t9 = send(withShot);

await waitFor('S9 a message with an image path reads as seen', (s) => sentSeen(withShot, t9, s.entries, s.hook, s.state.queue), 20000);
s = await waitFor('S9 idle again after it', (s) => s.state.phase === 'idle', 180000);
console.log(`      recorded as: ${ JSON.stringify((s.entries.filter(isPromptEntry).pop() || {}).message?.content?.[0]?.text || '') }`);
try {
  fs.unlinkSync(shot);
} catch { /* already gone */ }

// S7: interrupting a turn.
send('Run this shell command: sleep 90');
await waitFor('S7 working on sleep 90', (s) => s.state.phase === 'working', 15000);
await sleep(3000);
keys('Escape');
await waitFor('S7 idle and interrupted after Esc', (s) => s.state.phase === 'idle' && s.state.interrupted, 30000);

// S8: exit and restart (the pane loop restarts claude), then a real death.
send('/exit');
await waitFor('S8 SessionEnd seen or claude back', (s) => s.hook?.event === 'SessionEnd' || (s.alive && s.hook?.event === 'SessionStart'), 60000);
await waitFor('S8 back idle after the loop restarts claude', (s) => s.alive && s.state.phase === 'idle', 120000);
// A claude that keeps dying: the loop gives up after three quick exits and waits for Enter,
// and that is a pane with no claude in it - which the chat has to say, not "idle".
// Whether the loop gives up depends on how fast claude comes back, which varies with the
// pod; what must hold is that every moment claude was not running read as "gone" and never
// as "idle" or "working".
let sawGone = false;
let wrongWhileDead = 0;

for (let i = 0; i < 3; i++) {
  await waitFor(`S8 claude alive before kill ${ i + 1 }`, (s) => s.alive, 60000);
  const pid = tmux(`display -p -t "${ TMUX }" '#{pane_pid}'`).trim();

  sh(`pkill -P ${ pid } -x claude`);
  for (let j = 0; j < 6; j++) {
    await sleep(400);
    const s2 = sample();

    if (!s2.alive) {
      if (s2.state.phase === 'gone') {
        sawGone = true;
      } else {
        wrongWhileDead++;
      }
    }
  }
}
results.push({ label: 'S8 a dead claude always reads as gone', ok: sawGone && !wrongWhileDead, ms: 0, state: '', pane: '' });
console.log(`${ sawGone && !wrongWhileDead ? 'PASS' : 'FAIL' }  S8 a dead claude always reads as gone  (seen gone=${ sawGone }, wrong=${ wrongWhileDead })`);
s = sample();
if (s.state.phase === 'gone') {
  console.log(`      status: "${ s.state.status }"`);
  keys('Enter');
}
await waitFor('S8 idle again once claude is back', (s) => s.alive && s.state.phase === 'idle', 90000);

// ── Report ──────────────────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);

console.log(`\n# ${ results.length - failed.length }/${ results.length } passed`);
tmux(`kill-session -t "${ TMUX }" 2>/dev/null`);
process.exit(failed.length ? 1 : 0);
