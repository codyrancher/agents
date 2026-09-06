// The settings a fresh claude stops and asks for, answered in advance.
//
// A pod is a fresh machine every time, so without this the first thing the
// editor's terminal shows is a theme picker, then a "do you trust this folder"
// dialog, then a "Yes, I accept" for bypass permissions - three questions whose
// answers are the same every time and none of which the person opening the
// editor is being asked anything real by. What they should land in is a prompt,
// or a login.
//
// Only the flags are set here. The login itself is pulled from a Kubernetes
// Secret before the pane starts (see claude-credentials.mjs); what this file
// adds for it is the Stop hook that pushes a refreshed token back, so the pod
// that happens to refresh does not leave every other pod on a stale one.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.env.HOME || '/app/.home';
const CONFIG = path.join(HOME, '.claude.json');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');

// The directories a pane may start claude in, which is not the same list in
// every pod: the dev server's tabs land in its own tree, and a workspace's land
// in the checkout it cloned. shell.sh passes the pane's own directory; the
// default is this pod's source and the app around it, which is what boot.sh's
// background run has no directory to pass.
//
// Found rather than named, because the package directory is called whatever the package is
// called - the same rule PACKAGE_DIR uses. A pod with no tree yet trusts /app alone.
function packageDir() {
  try {
    const dirs = fs.readdirSync('/app/pkg', { withFileTypes: true }).filter((entry) => entry.isDirectory());

    return dirs.length ? [path.join('/app/pkg', dirs[0].name)] : [];
  } catch {
    return [];
  }
}

const TRUSTED = (process.env.TRUST_DIRS ? process.env.TRUST_DIRS.split(':') : [...packageDir(), '/app']).filter(Boolean);

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing, or half-written by a claude that was killed. Either way the
    // defaults below are a better starting point than failing here.
    return {};
  }
}

// Written back only when something actually changed. claude rewrites this file
// as it runs, and this can be called while a session is attached, so the common
// case (everything already set) must not touch it at all.
function update(file, mutate) {
  const before = read(file);
  const after = JSON.parse(JSON.stringify(before));

  mutate(after);

  if (JSON.stringify(after) === JSON.stringify(before)) {
    return false;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${ JSON.stringify(after, null, 2) }\n`, { mode: 0o600 });

  return true;
}

function claudeVersion() {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim().split(' ')[0];
  } catch {
    return undefined;
  }
}

const changed = [
  update(CONFIG, (config) => {
    // Skips the whole first-run flow, the theme picker included.
    config.hasCompletedOnboarding = true;

    // claude re-runs onboarding when its version is newer than this, so it is
    // stamped with whatever is installed rather than hardcoded.
    const version = claudeVersion();

    if (version) {
      config.lastOnboardingVersion = version;
    }

    config.projects = config.projects || {};

    for (const dir of TRUSTED) {
      config.projects[dir] = {
        ...config.projects[dir],
        // The pod's tree came from this extension's own seed, so asking whether
        // it is trusted is asking the wrong side.
        hasTrustDialogAccepted:       true,
        hasCompletedProjectOnboarding: true,
      };
    }
  }),

  // The "Yes, I accept" dialog for --dangerously-skip-permissions, which the
  // pane's claude is always started with, and the hook that shares a refreshed
  // token with the other pods.
  update(SETTINGS, (settings) => {
    settings.skipDangerousModePermissionPrompt = true;

    // Which model a pane starts on. Opus, unless somebody picked something else themselves:
    // a home that outlives the pod keeps whatever `/model` last chose, and a choice made in a
    // session should survive the next tab. What does not survive is the fable default an
    // earlier build wrote here, which is the one this replaces.
    if (!settings.model || /fable/i.test(String(settings.model))) {
      settings.model = 'opus';
    }

    // Stop, not a session end: it runs every time claude finishes a response,
    // which is the only moment this can be sure a refresh has already landed in
    // the file. The script itself does nothing when the local copy is not newer,
    // so running it that often costs a comparison.
    //
    // Merged rather than assigned, so a hook someone added by hand survives, and
    // matched on the command so this cannot accumulate copies of itself.
    const hooks = settings.hooks || (settings.hooks = {});

    /**
     * Whether a hook names a script this pod does not have.
     *
     * Not every pod carries every script. The agent pod's /seed is the terminal and nothing
     * else - there is no extension tree in it, so no provenance to record - and a hook whose
     * script is absent does not quietly do nothing: it ends every single turn with a
     * MODULE_NOT_FOUND printed into the pane, under the answer.
     */
    const missingScript = (command) => {
      const named = /\/seed\/[A-Za-z0-9._-]+/.exec(command || '');

      return !!named && !fs.existsSync(named[0]);
    };

    // Written first, and this is a prune rather than a guard on the registration below because
    // the home these settings live in outlives the pod. /app and /workspace are both hostPaths,
    // so a settings file written by a pod that had a script is read by a later one that does
    // not, and nothing else would ever take the dead hook back out.
    for (const [event, list] of Object.entries(hooks)) {
      const kept = list
        .map((entry) => ({ ...entry, hooks: (entry.hooks || []).filter((hook) => !missingScript(hook.command)) }))
        .filter((entry) => entry.hooks.length);

      // The event goes with its last hook, so a pod that runs none of them has no hooks block
      // rather than a row of empty lists for a reader to wonder about.
      if (kept.length) {
        hooks[event] = kept;
      } else {
        delete hooks[event];
      }
    }

    /**
     * Add one hook to one event, once.
     *
     * Matched on the command string rather than on position, for the reason the credentials
     * hook already had: this runs on every boot and on every tab, and a settings file that
     * accumulated a copy of each hook per tab would run the same commit five times.
     *
     * Skipped outright when this pod does not have the script, which is what keeps the list
     * below readable: every hook this product wants is stated once, and the pods that cannot
     * run one simply do not get it.
     */
    const register = (event, command, matcher) => {
      if (missingScript(command)) {
        return;
      }

      const list = hooks[event] || (hooks[event] = []);
      const already = list.some((entry) => (entry.hooks || []).some((hook) => hook.command === command));

      if (!already) {
        const entry = { hooks: [{ type: 'command', command }] };

        if (matcher) {
          entry.matcher = matcher;
        }

        list.push(entry);
      }
    };

    register('Stop', 'node /seed/claude-credentials.mjs push');

    // Provenance: what produced each line of a change, recorded while it is being made. See
    // barn-provenance.mjs for what these three record and, just as importantly, for the four
    // things they deliberately do not claim.
    //
    // claude's own hooks rather than anything read off the pane. `tmux send-keys` is
    // write-only, so the product can say what it sent and nothing about what happened next,
    // and the pane's output is a character stream rather than a sequence of typed events.
    register('UserPromptSubmit', 'node /seed/barn-provenance.mjs prompt');
    register('PostToolUse', 'node /seed/barn-provenance.mjs touch', 'Edit|Write|MultiEdit|NotebookEdit');

    // Last, so a refreshed credential is already pushed by the time this commits: both are
    // Stop hooks and they run in the order they are listed.
    register('Stop', 'node /seed/barn-provenance.mjs stop');
  }),
].some(Boolean);

console.log(changed ? '[claude] defaults written' : '[claude] defaults already set');
