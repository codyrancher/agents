// One claude login, shared by every pod, through a Kubernetes Secret.
//
//   node /seed/claude-credentials.mjs pull    before claude starts
//   node /seed/claude-credentials.mjs push    after it has run
//
// The reason both halves exist is the same reason the harness mirrors its credential file
// between the global session and the project containers: OAuth tokens refresh, and whoever
// refreshed last has the only working one. Pull without push means every pod that did not do
// the refresh is stranded on a token that has expired; push without pull means a pod that has
// never been logged in stays that way.
//
// Newest wins, on `expiresAt`, which is the only ordering these two copies have in common: file
// mtimes are per pod and a pod that merely read the file would otherwise look newer than the
// pod that refreshed it.
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
const LOCAL = path.join(process.env.HOME || os.homedir(), '.claude', '.credentials.json');

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

const local = readLocal();
const remote = readRemote();

if (remote === null) {
  say('the shared secret is not readable from this pod, so this terminal keeps its own login');
  process.exit(0);
}

if (MODE === 'push') {
  if (expiresAt(local) <= expiresAt(remote)) {
    process.exit(0);
  }

  const merged = { ...remote, claudeAiOauth: local.claudeAiOauth };
  const encoded = Buffer.from(JSON.stringify(merged)).toString('base64');

  try {
    kubectl([
      '-n', NAMESPACE, 'patch', 'secret', SECRET, '--type=merge',
      '-p', JSON.stringify({ data: { [KEY]: encoded } }),
    ]);
    say('pushed a newer token to the shared secret');
  } catch {
    say('could not write the shared secret, so the refreshed token stays in this pod only');
  }

  process.exit(0);
}

if (expiresAt(remote) <= expiresAt(local)) {
  process.exit(0);
}

writeLocal({ ...local, claudeAiOauth: remote.claudeAiOauth });
say('pulled the shared login');
