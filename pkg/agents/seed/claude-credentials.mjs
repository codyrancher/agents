// One claude login, shared by every pod, through a Kubernetes Secret.
//
//   node /seed/claude-credentials.mjs pull    before claude starts
//   node /seed/claude-credentials.mjs push    after it has run
//   node /seed/claude-credentials.mjs sync    the daemon that keeps both in step
//
// The reason both halves exist is the same reason the harness mirrors its credential file
// between the global session and the project containers: OAuth tokens refresh, and whoever
// refreshed last has the only working one. Pull without push means every pod that did not do
// the refresh is stranded on a token that has expired; push without pull means a pod that has
// never been logged in stays that way.
//
// `sync` is what makes it happen without anyone thinking about it. claude reads its token once,
// at startup, and rotates it as it runs - and the refresh token is single use, so the moment one
// pod's claude refreshes, every other pod still holding the old one is a login waiting to fail.
// The daemon runs one per pod: it pushes this pod's token up whenever it is the newer one (a
// refresh here, or a fresh `/login` in one of its panes), and when a newer login arrives from
// somewhere else it pulls that down and restarts the conversations here onto it, so they resume
// on the live token instead of dying on the dead one. Log in once, anywhere, and every open
// conversation reconnects itself.
//
// Newest wins, on `expiresAt`, which is the only ordering these two copies have in common: file
// mtimes are per pod and a pod that merely read the file would otherwise look newer than the
// pod that refreshed it. A restart is gated on the refresh token actually differing, so a pod
// adopting a token does not then turn round and think itself behind.
//
// Only the `claudeAiOauth` block moves. Everything else in the local file belongs to the pod
// it is in, and the Secret is not a backup of it.
//
// It never fails loudly. A pod with no kubectl, no rights, or no Secret yet is a pod that is
// not sharing a login, which is a thing to say on the way past rather than a reason to stop a
// terminal from opening.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MODE = process.argv[2] || 'pull';
const NAMESPACE = 'dev-system';
const SECRET = 'claude-credentials';
const KEY = 'credentials.json';
const HOME = process.env.HOME || os.homedir();
const LOCAL = path.join(HOME, '.claude', '.credentials.json');

// Where the pane's loop and this daemon meet. shell.sh gives each pane an `MC_RESTART_FLAG`
// under here (named for its tmux session); touching it tells that pane's loop to reconnect the
// moment claude next stops, without waiting for a keypress. `$(dirname HOME)` is the volume both
// the home and the sessions directory sit on, so the flag outlives neither more nor less than
// they do.
const RESTART_DIR = path.join(path.dirname(HOME), '.restart');

// One daemon per pod. shell.sh fires `sync` on every pane attach; the lock is what makes the
// second and every one after it a no-op rather than a second daemon pushing against the first.
const LOCK = path.join(path.dirname(HOME), '.login-sync.lock');

// How often the daemon looks. Fifteen seconds is far below a token's lifetime and far above the
// cost of two reads, so a login is adopted within a breath of arriving and nothing is busy.
const INTERVAL_MS = (Number(process.env.MC_LOGIN_SYNC_INTERVAL) || 15) * 1000;

function say(message) {
  console.log(`[credentials] ${ message }`); // eslint-disable-line no-console
}

/**
 * kubectl as this pod, never as whoever is watching it.
 *
 * `KUBECONFIG` naming nothing sends kubectl to the in-cluster config, which is the pod's own
 * ServiceAccount. That is normally what it would pick anyway, and in the agent pod it is not:
 * a pane there has a kubeconfig holding the Rancher credential of the person who opened the
 * panel, and this Secret is in `dev-system`, where that person may have no rights at all. The
 * shared claude login is a property of the pods, so it is read and written by the pods.
 */
function kubectl(args) {
  return execFileSync('kubectl', args, {
    encoding: 'utf8',
    stdio:    ['ignore', 'pipe', 'pipe'],
    env:      { ...process.env, KUBECONFIG: '/dev/null' },
  });
}

/** A command whose absence or failure is not worth stopping for; the output, or '' either way. */
function quiet(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function readLocal() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
  } catch {
    return {};
  }
}

function readRemote() {
  try {
    const encoded = kubectl(['-n', NAMESPACE, 'get', 'secret', SECRET, '-o', `jsonpath={.data.${ KEY.replace('.', '\\.') }}`]).trim();

    return encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : {};
  } catch {
    return null;
  }
}

/** When the access token in a copy runs out, or 0 for a copy that has none. */
function expiresAt(blob) {
  return Number(blob?.claudeAiOauth?.expiresAt) || 0;
}

/** The refresh token, which changes on every login and every rotation; '' when there is none. */
function refreshToken(blob) {
  return String(blob?.claudeAiOauth?.refreshToken || '');
}

/**
 * Replace the file in one step.
 *
 * A terminal starting while this writes would otherwise be able to read half a token, and the
 * mode is set on the temporary file rather than after the rename so the file is never briefly
 * readable by anything else on the node.
 */
function writeLocal(blob) {
  fs.mkdirSync(path.dirname(LOCAL), { recursive: true });

  const tmp = path.join(path.dirname(LOCAL), `.credentials.${ process.pid }`);

  fs.writeFileSync(tmp, `${ JSON.stringify(blob, null, 2) }\n`, { mode: 0o600 });
  fs.renameSync(tmp, LOCAL);
}

/** Send this pod's token up, when it is the newer one. Returns whether it did. */
function pushUp(local, remote) {
  if (expiresAt(local) <= expiresAt(remote)) {
    return false;
  }

  const merged = { ...remote, claudeAiOauth: local.claudeAiOauth };
  const encoded = Buffer.from(JSON.stringify(merged)).toString('base64');

  try {
    kubectl([
      '-n', NAMESPACE, 'patch', 'secret', SECRET, '--type=merge',
      '-p', JSON.stringify({ data: { [KEY]: encoded } }),
    ]);

    return true;
  } catch {
    return false;
  }
}

/** Whether a pid is a live process this user can signal. */
function alive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the claude running in a pane, having first told its loop to reconnect at once.
 *
 * The pane's shell is `claude-session.sh`, and while claude is running it is that shell's only
 * foreground child. Signalling the child ends the `claude ... ` line the loop is blocked on; the
 * loop then sees the flag this leaves and goes straight back to claude - which, because the loop
 * pulls before every start, comes up on the token just written. A pane with no claude child (one
 * sitting at the loop's prompt, or a plain shell) is left alone: it has nothing to reconnect and
 * will pull the new token itself the next time it starts claude.
 */
function reconnectPane(session) {
  const id = session.startsWith('mc-') ? session.slice(3) : session;
  const panePid = quiet('tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}']).split('\n')[0]?.trim();

  if (!panePid) {
    return;
  }

  // The claude process, if this pane has one. It is a child of the pane shell, but which child
  // is not something `comm` can be trusted for: node reports its `comm` as `MainThread`, not
  // `node`, so the reliable mark is the CLI's own name somewhere in the command line (the
  // `claude` wrapper, or the node process running `.../claude-code/cli.js`). If nothing matches
  // but the pane does have children, claude is stopping it the blunt way - every direct child -
  // which is safe here: the only other child the loop ever has is its short-lived transcript
  // watcher, and a pane sitting idle at the loop's prompt has no children at all, so it is left
  // alone to pick the token up itself on its next start.
  const children = quiet('pgrep', ['-P', panePid]).split('\n').map((s) => s.trim()).filter(Boolean);

  if (!children.length) {
    return;
  }

  const named = children.filter((pid) => /claude/i.test(quiet('cat', [`/proc/${ pid }/cmdline`]).replace(/\0/g, ' ')));
  const targets = named.length ? named : children;

  try {
    fs.mkdirSync(RESTART_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESTART_DIR, id), '');
  } catch {
    // No flag means the loop falls back to its keypress prompt - a worse reconnection, not a
    // broken one, so it is not worth refusing the restart over.
  }

  targets.forEach((pid) => {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      // Gone already, which is the state we wanted it in.
    }
  });
}

/** Every conversation open in this pod, reconnected onto the token just pulled. */
function reconnectAll() {
  const sessions = quiet('tmux', ['ls', '-F', '#{session_name}'])
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('mc-'));

  sessions.forEach(reconnectPane);
}

/**
 * One turn of the daemon: share up, or adopt and reconnect down.
 *
 * The two are exclusive and ordered by which copy is newer. A restart is taken only when the
 * refresh token has actually changed, not merely when `expiresAt` has - a pod that has just
 * adopted a token would otherwise reconnect its panes a second time on the next turn.
 */
function syncOnce() {
  const local = readLocal();
  const remote = readRemote();

  if (remote === null) {
    return;
  }

  if (expiresAt(local) > expiresAt(remote)) {
    if (pushUp(local, remote)) {
      say('shared this pod\'s newer login with the others');
    }

    return;
  }

  if (expiresAt(remote) > expiresAt(local) && refreshToken(remote) && refreshToken(remote) !== refreshToken(local)) {
    writeLocal({ ...local, claudeAiOauth: remote.claudeAiOauth });
    say('a newer shared login arrived - reconnecting this pod\'s conversations onto it');
    reconnectAll();
  }
}

/** Take the pod's single daemon slot, or bow out because another already holds it. */
function takeLock() {
  try {
    const fd = fs.openSync(LOCK, 'wx');

    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);

    return true;
  } catch {
    let holder = 0;

    try {
      holder = Number(fs.readFileSync(LOCK, 'utf8').trim());
    } catch {
      holder = 0;
    }

    if (holder && alive(holder)) {
      return false;
    }

    // A dead holder's lock is stale; take it over.
    try {
      fs.writeFileSync(LOCK, String(process.pid));

      return true;
    } catch {
      return false;
    }
  }
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK);
    }
  } catch {
    // Someone else's now, or already gone: not ours to remove.
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────

if (MODE === 'sync') {
  if (!takeLock()) {
    process.exit(0);
  }

  process.on('exit', releaseLock);
  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((sig) => process.on(sig, () => process.exit(0)));

  syncOnce();
  setInterval(syncOnce, INTERVAL_MS);
} else {
  const local = readLocal();
  const remote = readRemote();

  if (remote === null) {
    say('the shared secret is not readable from this pod, so this terminal keeps its own login');
    process.exit(0);
  }

  if (MODE === 'push') {
    if (pushUp(local, remote)) {
      say('pushed a newer token to the shared secret');
    }

    process.exit(0);
  }

  // pull
  if (expiresAt(remote) <= expiresAt(local)) {
    process.exit(0);
  }

  writeLocal({ ...local, claudeAiOauth: remote.claudeAiOauth });
  say('pulled the shared login');
}
