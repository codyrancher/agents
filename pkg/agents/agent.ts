// The agent pod: one claude in the cluster, reachable from every page.
//
// Not one agent per extension. The extension pods already have one each, pointed at one tree
// and knowing about one extension. This is the other thing you want when something is wrong -
// somebody who can see all of them at once, ask the cluster a question, and read the Studio's
// own API document - and it has to be reachable from wherever you noticed, which is usually a
// Rancher page that has nothing to do with the Studio.
//
// It is made the way the service is made: a ConfigMap holding the pod's source, a Deployment
// running stock node over it, and both fingerprinted so a cluster running last month's copy is
// replaced rather than left alone. There is no Service, because nothing here is served - the
// only way in is the exec subresource, which addresses a pod.
//
// Its terminal is PodTerminal, and its panes are shell.sh, tmux and a claude loop - the same
// scripts Extension Studio's dev-server pods run, carried here in seed/ for this pod.
import {
  EXT_NS, EXT_ACCOUNT, EXT_IMAGE, EXT_BASE, AGENT_OBJECT, AGENT_CONTAINER, execUrl, podExecResult,
  namespaceBody, serviceAccountBody, clusterRoleBindingBody, EXT_ROLE_BINDING,
} from './pod';
import type { InstallStep } from './ensure';
import { VERSION_ANNOTATION, contentVersion, ensureCurrent } from './ensure';
import { AGENT_FILES } from './seed.generated';
import { rancherFetch } from './api';

export { AGENT_OBJECT, AGENT_CONTAINER };

/**
 * Where the node keeps this pod's conversations and its claude login between restarts.
 *
 * Beside the extension trees rather than inside one, and named for what it is: an extension's
 * directory is claimed by that extension's name, and the agent is not an extension.
 */
const AGENT_HOST_PATH = '/var/lib/rancher/extension-studio/agent';

/** Where those conversations live inside the pod. Mirrors hostCachePath's role for /app. */
const AGENT_WORKSPACE = '/workspace';

/**
 * The directory every extension's tree is already a child of, on the node.
 *
 * `hostCachePath` puts an extension's `/app` at `/var/lib/rancher/extension-studio/<name>-extension`,
 * and this pod's own `/workspace` is `.../agent` beside them - so the trees are not somewhere
 * that has to be reached, they are one directory up. Mounting the parent is the whole of it.
 */
const EXT_HOST_ROOT = AGENT_HOST_PATH.replace(/\/agent$/, '');

/**
 * Where those trees appear in this pod.
 *
 * Under `/workspace` rather than at the root, because `/workspace` is the durable half of this
 * pod and this is the same node storage the rest of it is on - putting it anywhere else would
 * suggest it is something different. A pane's own directory is `/workspace/conversations`, so
 * an extension's source is one `cd` from where the agent already is.
 *
 * `<mount>/agent` is this pod's own `/workspace`, seen from outside. That is not a loop and it
 * does not recurse: the nesting exists only inside this container, so the host directory it
 * resolves to has no `extensions` of its own.
 */
const AGENT_EXT_MOUNT = `${ AGENT_WORKSPACE }/extensions`;

/** The source this pod runs, taken out of the bundle it travels in. */
export function agentSourceFiles(): Record<string, string> {
  return { ...AGENT_FILES };
}

/**
 * A fingerprint of that source, for the same reason the service has one.
 *
 * A pod created once and then left alone keeps whatever source it was first given for ever, and
 * nothing reports the mismatch. It goes on the ConfigMap, on the Deployment (which is what
 * ensureCurrent compares) and on the pod template (which is what makes a changed script
 * actually roll the pod, since /seed is a mounted volume nothing re-reads).
 */
export function agentSourceVersion(): string {
  const files = agentSourceFiles();

  return contentVersion(Object.keys(files).sort().flatMap((key) => [key, files[key]]));
}

export function agentConfigMapBody(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   {
      namespace:   EXT_NS,
      name:        AGENT_OBJECT,
      labels:      { app: AGENT_OBJECT },
      annotations: { [VERSION_ANNOTATION]: agentSourceVersion() },
    },
    data: agentSourceFiles(),
  };
}

export function agentDeploymentBody(): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   {
      namespace:   EXT_NS,
      name:        AGENT_OBJECT,
      labels:      { app: AGENT_OBJECT },
      annotations: { [VERSION_ANNOTATION]: agentSourceVersion() },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: AGENT_OBJECT } },
      // Recreate, like an extension's and for the same reason: /workspace is a hostPath, and two
      // pods would be two tmux servers writing one set of conversation directories.
      strategy: { type: 'Recreate' },
      template: {
        metadata: {
          labels:      { app: AGENT_OBJECT },
          annotations: { [VERSION_ANNOTATION]: agentSourceVersion() },
        },
        spec: {
          // The same account every pod here runs as, and here it is used rather than declared:
          // kubectl in a pane reads its token, and being able to answer a question about the
          // cluster is most of what this pod is for. See EXT_ACCOUNT for what that grants, and
          // agent-overlay.ts for why the way in is offered to admins only.
          serviceAccountName: EXT_ACCOUNT,
          containers:         [{
            name:    AGENT_CONTAINER,
            image:   EXT_IMAGE,
            command: ['/bin/sh', '/seed/boot.sh'],
            env:     [
              // Rancher's address from inside the cluster, which is the node's: this cluster is
              // k3s inside the Rancher container. Declared before RANCHER_URL because Kubernetes
              // expands $(VAR) only against variables already listed.
              { name: 'NODE_IP', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
              { name: 'RANCHER_URL', value: 'https://$(NODE_IP)' },
              // Where the Studio's own API answers, so the CLAUDE.md can tell the agent to read
              // its OpenAPI document rather than describe the routes and go stale.
              { name: 'EXTENSION_STUDIO_API', value: 'http://extension-studio-api:8006' },
            ],
            volumeMounts: [
              { name: 'seed', mountPath: '/seed' },
              { name: 'workspace', mountPath: AGENT_WORKSPACE },
              // After the workspace mount, and nested inside it, which kubelet handles by
              // mounting in path order. Writable rather than read-only: this pod could already
              // write into any of those trees through the exec subresource, so read-only would
              // buy no safety and cost the one thing that makes this worth having - editing a
              // file with an editor instead of a shell command. What keeps two agents out of
              // one tree is the rule in the CLAUDE.md, not the mount.
              { name: 'extensions', mountPath: AGENT_EXT_MOUNT },
            ],
            // No probes. There is no port and nothing to ask; a pod with neither is Ready as
            // soon as it is Running, which for this one is the truth.
          }],
          volumes: [
            { name: 'seed', configMap: { name: AGENT_OBJECT } },
            { name: 'workspace', hostPath: { path: AGENT_HOST_PATH, type: 'DirectoryOrCreate' } },
            // The parent rather than one entry per extension, so an extension created after this
            // pod started is simply there. A per-extension mount would mean editing this
            // Deployment - and restarting this pod, and ending every conversation in it - every
            // time somebody made one.
            { name: 'extensions', hostPath: { path: EXT_HOST_ROOT, type: 'DirectoryOrCreate' } },
          ],
        },
      },
    },
  };
}

/**
 * What the pod needs to exist first, made here when this extension is the first to arrive.
 *
 * Extension Studio makes the same three objects when it is installed; the bodies are the same
 * and each side treats an object that is already there as its own. Either order works.
 */
export function sharedSteps(): InstallStep[] {
  return [
    {
      id:          'namespace',
      label:       `Namespace ${ EXT_NS }`,
      description: 'Holds the agent pod, and everything Extension Studio makes beside it.',
      type:        'namespaces',
      uiType:      'namespace',
      name:        EXT_NS,
      body:        namespaceBody,
    },
    {
      id:          'serviceaccount',
      label:       `ServiceAccount ${ EXT_ACCOUNT }`,
      description: 'The identity the agent pod runs as.',
      type:        'serviceaccounts',
      uiType:      'serviceaccount',
      namespace:   EXT_NS,
      name:        EXT_ACCOUNT,
      body:        serviceAccountBody,
    },
    {
      id:          'clusterrolebinding',
      label:       `ClusterRoleBinding ${ EXT_ROLE_BINDING }`,
      description: 'Grants that identity cluster-admin, without which a pane gets 403 to every question about the cluster.',
      type:        'rbac.authorization.k8s.io.clusterrolebindings',
      uiType:      'rbac.authorization.k8s.io.clusterrolebinding',
      name:        EXT_ROLE_BINDING,
      body:        clusterRoleBindingBody,
    },
  ];
}

/** The two objects, in the order they have to be made: a Deployment naming an absent ConfigMap never starts. */
export function agentSteps(): InstallStep[] {
  return [
    {
      id:          'agent-source',
      label:       `ConfigMap ${ AGENT_OBJECT }`,
      description: 'What the agent pod runs, as source. There is no image, so this is the only copy of it in the cluster.',
      type:        'configmaps',
      uiType:      'configmap',
      namespace:   EXT_NS,
      name:        AGENT_OBJECT,
      body:        agentConfigMapBody,
    },
    {
      id:          'agent-deployment',
      label:       `Deployment ${ AGENT_OBJECT }`,
      description: 'The one claude that can see every extension, which the global terminal opens into.',
      type:        'apps.deployments',
      uiType:      'apps.deployment',
      namespace:   EXT_NS,
      name:        AGENT_OBJECT,
      body:        agentDeploymentBody,
    },
  ];
}

/**
 * Make the agent pod exist, and make it the source this bundle carries.
 *
 * Called when the bundle loads, in front of a page, on behalf of somebody who may not be allowed
 * to create any of it - so it swallows what goes wrong. The overlay says so itself when there is
 * no pod to open into.
 */
let ensureAgentInFlight: Promise<void> | null = null;

export function ensureAgent(): Promise<void> {
  if (ensureAgentInFlight) {
    return ensureAgentInFlight;
  }

  ensureAgentInFlight = ensureCurrent([...sharedSteps(), ...agentSteps()]).finally(() => {
    ensureAgentInFlight = null;
  });

  return ensureAgentInFlight;
}

/**
 * The running agent pod, or null while there isn't one.
 *
 * `Running` rather than `Ready` is not the distinction it is for an extension - this pod has no
 * probes - but the shape is the same as extensionPod's on purpose, because the terminal polls
 * this the same way and a first boot is still installing tmux and claude for a minute or two.
 */
export async function agentPod(): Promise<string | null> {
  const pods = await rancherFetch(`${ EXT_BASE }/v1/pods/${ EXT_NS }`).catch(() => null);

  const running = (pods?.data || []).find((pod: any) => (
    pod.metadata?.labels?.app === AGENT_OBJECT &&
    pod.status?.phase === 'Running' &&
    !pod.metadata?.deletionTimestamp
  ));

  return running?.metadata?.name || null;
}

/**
 * Where every conversation runs.
 *
 * One directory for all of them, deliberately. claude keys its history by working directory, so
 * a directory per conversation meant the resume picker in one tab could not see any of the
 * others - which is what somebody hits the moment they want to pick a conversation up in a
 * different pane, and it reads as the tabs not being the same place.
 *
 * What that costs is spelled out in claude-session.sh: sharing the directory means `--continue`
 * would resume whichever conversation was touched last by any pane, so each pane now tracks the
 * id of its own and resumes that instead.
 *
 * `sessions.sh` still keeps a directory per conversation under `sessions/`, but only for the
 * name and the title. Nothing runs there.
 */
function sharedWorkdir(): string {
  return `${ AGENT_WORKSPACE }/conversations`;
}

/**
 * WebSocket URL for one conversation in the agent pod.
 *
 * The same shell.sh an extension's terminal runs, given a directory of its own and this pod's
 * durable home. The arguments are positional (session, directory, home, mode) and none of them
 * can be skipped, which is why the third is spelled out rather than left to shell.sh's default -
 * that default is /app, and this pod has no /app.
 */
export function agentShellUrl(pod: string, session: string, mode = 'claude'): string {
  return execUrl(
    pod,
    ['/bin/sh', '/seed/shell.sh', session, sharedWorkdir(), `${ AGENT_WORKSPACE }/.home`, mode],
    true,
    AGENT_CONTAINER,
  );
}

/** One conversation: the name that addresses it, and the name a person reads. */
export interface AgentSession {
  /** Names the directory, the tmux session and the exec URL. Never changes. */
  id: string;
  /** What the tab says. Renamable, and kept in the pod beside the conversation. */
  title: string;
}

/** One call to the pod's own account of its conversations. See pod/agent/sessions.sh. */
async function sessionScript(args: string[], what: string): Promise<string> {
  const pod = await agentPod();

  if (!pod) {
    throw new Error('The agent pod is not running yet, so there is nowhere to hold a conversation.');
  }

  // Short, because a person is waiting for each of these with a panel open. None of them is
  // more than a mkdir or a directory listing.
  const result = await podExecResult(pod, ['/bin/sh', '/seed/sessions.sh', ...args], 15000, AGENT_CONTAINER);

  if (result.code !== 0) {
    throw new Error(`Could not ${ what }: ${ result.stderr.trim() || result.status || `exit ${ result.code }` }`);
  }

  return result.stdout;
}

/**
 * Every conversation the pod is holding.
 *
 * Asked of the pod rather than remembered in the browser, and that is the whole design of the
 * tab strip. A conversation outlives the tab that opened it, so a second browser tab, a reload,
 * or a different person's session all have to see the same list and the same names - and the
 * only place either exists is the pod.
 *
 * An empty list is the honest answer for a pod that has just started, so a pod that is not
 * running yet reports nothing rather than throwing: the terminal itself already says when there
 * is no pod, and the panel would otherwise show an error over a pod that is merely booting.
 */
export async function agentSessions(): Promise<AgentSession[]> {
  const listing = await sessionScript(['list'], 'read the conversations in the agent pod').catch(() => '');

  return listing.split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const id = tab === -1 ? line : line.slice(0, tab);

      return { id, title: tab === -1 ? id : line.slice(tab + 1) };
    })
    .filter((session) => /^agent-\d+$/.test(session.id))
    .sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6)));
}

/**
 * Start another conversation, and let the pod choose its name.
 *
 * The name has to be allocated where the conversations are, not counted in the browser, and
 * there are two separate reasons. Two browser tabs pressing + at the same moment both see the
 * same list and would both pick the same next number. And a name whose directory still exists
 * is not free even when no tmux session is using it: `tmux new-session -A` would attach to
 * whatever is there, so + would reopen a finished conversation instead of starting one. The pod
 * answers both with a mkdir. See the `new` verb in pod/agent/sessions.sh.
 */
export async function startAgentSession(): Promise<string> {
  const id = (await sessionScript(['new'], 'start a conversation')).trim();

  if (!/^agent-\d+$/.test(id)) {
    throw new Error(`The agent pod answered "${ id }", which is not a conversation name.`);
  }

  return id;
}

/**
 * A project's conversations, and how to start, name and end one.
 *
 * The same pod, the same panes and the same shared transcript directory as the drawer's
 * conversations, namespaced by the project's name in the pod's own sessions.sh so that the
 * drawer never lists them (its list asks for no project and gets only agent-<n>). The Dev
 * extension's workspaces are the first project; the in-pod API offers the same four verbs to
 * anything that cannot import this file - see pod/service/routes.mjs, /v1/projects.
 */
export const PROJECT_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function assertProject(project: string): string {
  if (!PROJECT_NAME_RE.test(project) || project.length > 40) {
    throw new Error(`"${ project }" is not a project name: lowercase letters, digits and hyphens.`);
  }

  return project;
}

export function isProjectSession(project: string, id: string): boolean {
  return new RegExp(`^p-${ project }-\\d+$`).test(id);
}

export async function projectSessions(project: string): Promise<AgentSession[]> {
  const name = assertProject(project);
  const listing = await sessionScript(['list', name], `read ${ name }'s conversations`).catch(() => '');

  return listing.split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const id = tab === -1 ? line : line.slice(0, tab);

      return { id, title: tab === -1 ? id : line.slice(tab + 1) };
    })
    .filter((session) => isProjectSession(name, session.id))
    .sort((a, b) => Number(a.id.slice(a.id.lastIndexOf('-') + 1)) - Number(b.id.slice(b.id.lastIndexOf('-') + 1)));
}

export async function startProjectSession(project: string, title = '', prompt = ''): Promise<string> {
  const name = assertProject(project);
  const id = (await sessionScript(['new', name], `start a conversation in ${ name }`)).trim();

  if (!isProjectSession(name, id)) {
    throw new Error(`The agent pod answered "${ id }", which is not a conversation name.`);
  }

  if (title.trim()) {
    await sessionScript(['rename', id, title.trim()], `name ${ id }`);
  }

  if (prompt.trim()) {
    await queueSessionPrompt(id, prompt);
  }

  return id;
}

/** Where a queued prompt waits: shell.sh reads `$(dirname home)/.queue/<session>` on a pane's first start. */
const AGENT_QUEUE = `${ AGENT_WORKSPACE }/.queue`;

const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Queue what a conversation opens with.
 *
 * A file rather than keystrokes, because the thing that queues a prompt is a page and the thing
 * that runs it is a pane that may not exist yet: claude-session.sh hands the file to claude as
 * its opening message the first time the session starts (see MC_QUEUE in shell.sh). Base64
 * through the shell so a prompt with quotes, newlines and dollar signs in it arrives whole, and
 * owned by the pane's user, which is who reads it.
 */
export async function queueSessionPrompt(id: string, prompt: string): Promise<void> {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`"${ id }" is not a conversation id.`);
  }

  const pod = await agentPod();

  if (!pod) {
    throw new Error('The agent pod is not running yet, so there is nowhere to queue a prompt.');
  }

  const bytes = new TextEncoder().encode(prompt);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  const script = `mkdir -p ${ AGENT_QUEUE } && echo ${ btoa(binary) } | base64 -d > ${ AGENT_QUEUE }/${ id } && chown 1000:1000 ${ AGENT_QUEUE } ${ AGENT_QUEUE }/${ id } 2>/dev/null; echo queued`;
  const result = await podExecResult(pod, ['/bin/sh', '-c', script], 15000, AGENT_CONTAINER);

  if (!result.stdout.includes('queued')) {
    throw new Error(`The prompt could not be written into the agent pod: ${ result.stderr.trim() || result.status || `exit ${ result.code }` }`);
  }
}

/**
 * The argv a pane runs for one conversation - the thing PodTerminal's `command` prop takes.
 *
 * Spelled here once rather than by every extension that places a pane: shell.sh's arguments are
 * positional and all required, and a caller that copied them would be a caller that stopped
 * matching the first time they changed.
 */
export function sessionCommand(id: string, mode: 'claude' | 'shell' = 'claude'): string[] {
  return ['/bin/sh', '/seed/shell.sh', id, sharedWorkdir(), `${ AGENT_WORKSPACE }/.home`, mode];
}

/**
 * What a conversation's pane is showing, stripped to printable text.
 *
 * Read off tmux in the pod as the pane's own user - a tmux server is per user. `running` is
 * false when nothing has attached to the conversation since the pod started, in which case
 * whatever was queued for it has not run yet.
 */
export async function sessionPane(id: string, lines = 60): Promise<{ text: string; running: boolean }> {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`"${ id }" is not a conversation id.`);
  }

  const pod = await agentPod();

  if (!pod) {
    return { text: '', running: false };
  }

  const count = Math.max(4, Math.min(400, Math.floor(lines) || 60));
  const script = [
    `if tmux has-session -t mc-${ id } 2>/dev/null; then`,
    `tmux capture-pane -p -S -${ count } -t mc-${ id } | tr -cd '\\11\\12\\15\\40-\\176' | sed -e 's/[[:space:]]*$//' | grep -v '^$' | tail -n ${ count };`,
    'else echo BARN-NO-SESSION; fi',
  ].join(' ');
  const result = await podExecResult(pod, ['su', 'node', '-c', script], 15000, AGENT_CONTAINER);
  const text = result.stdout || '';

  return { running: !text.includes('BARN-NO-SESSION'), text: text.replace('BARN-NO-SESSION', '').trim() };
}

/** The pane for one of a project's conversations: the same shell.sh, the same directory. */
export function projectShellUrl(pod: string, id: string, mode = 'claude'): string {
  return agentShellUrl(pod, id, mode);
}

/**
 * Give one conversation a name.
 *
 * In the pod, for the same reason the list is read from there: a name kept in localStorage
 * would be this browser's name for it, and the person in the next tab would see the ordinal.
 */
export async function renameAgentSession(id: string, title: string): Promise<void> {
  await sessionScript(['rename', id, title], `rename ${ id }`);
}

/**
 * End one conversation.
 *
 * The tmux session and the directory both, which is deliberate rather than incidental. The
 * strip is the pod's list, so a close that left either behind would be a control that does
 * nothing: the tab would come back on the next refresh, and the name would never be free again.
 * The thing that leaves conversations running is closing the panel, or the browser, or
 * reloading the page - none of which touch the pod.
 */
export async function endAgentSession(id: string): Promise<void> {
  await sessionScript(['end', id], `end ${ id }`);
}
