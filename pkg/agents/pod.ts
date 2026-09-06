// Pods, as this extension reaches them: by name, in one namespace, through Rancher's proxy.
//
// Two ways in, and both are the apiserver's exec subresource. A terminal holds one open on a
// TTY (components/PodTerminal.vue); everything else here runs one command, without a TTY, and
// reads what it printed - a directory listing, a file's bytes, an image written in chunks. There
// is no service pod behind any of it: the browser opens the socket, with the session cookie it
// already has, which is what makes this extension something a Rancher can install on its own.
import { rancherFetch } from './api';

/** The cluster the agent pod is in, which is this Rancher's own. */
const EXT_CLUSTER = 'local';

/**
 * The namespace, the account and the names, kept from Extension Studio on purpose.
 *
 * This code lived in the Studio, and the agent pod it made - its conversations on the node under
 * `/var/lib/rancher/extension-studio/agent`, its credential Secret, the account it runs as - is
 * the pod this extension now owns. Renaming any of it would be a migration of every
 * conversation anybody has, for a name. So the objects keep theirs, and the Studio is what makes
 * the namespace and the account when it is installed too; this extension makes them when it is
 * the first to arrive (see index.ts).
 */
export const EXT_NS = 'extension-studio';
export const EXT_ACCOUNT = 'extension-studio';
export const EXT_ROLE_BINDING = 'extension-studio-cluster-admin';
export const EXT_IMAGE = 'node:24';
export const EXT_BASE = `/k8s/clusters/${ EXT_CLUSTER }`;

/** The one name for the ConfigMap, the Deployment and the pod's label. */
export const AGENT_OBJECT = 'extension-studio-agent';

/** The container a pane execs into. Named in the exec URL, so named once. */
export const AGENT_CONTAINER = 'agent';

/**
 * WebSocket URL for a command in a pod.
 *
 * The Kubernetes exec subresource, the one the dashboard's own container shell uses, so it
 * carries the browser's Rancher session and needs nothing else. The protocol is
 * `base64.channel.k8s.io`: every frame is a channel digit (0 stdin, 1 stdout, 2 stderr, 3 the
 * apiserver's status, 4 resize) followed by base64.
 */
export function execUrl(
  pod: string, command: string[], interactive: boolean, container: string = AGENT_CONTAINER, namespace: string = EXT_NS,
): string {
  const origin = window.location.origin.replace(/^http/, 'ws');
  const params = new URLSearchParams({
    container,
    stdin:  interactive ? '1' : '0',
    stdout: '1',
    stderr: '1',
    tty:    interactive ? '1' : '0',
  });

  // Repeated, not comma-joined: this is argv.
  for (const arg of command) {
    params.append('command', arg);
  }

  return `${ origin }${ EXT_BASE }/api/v1/namespaces/${ namespace }/pods/${ pod }/exec?${ params }`;
}

/** How long a one-shot exec may run. The slowest thing here is a base64 of a screenshot. */
const EXEC_TIMEOUT_MS = 120000;

/** Everything one exec produced: its output, its error output, and whether it worked. */
export interface PodExecResult {
  stdout: string;
  stderr: string;
  /** 0 when it succeeded, its own code when it failed, -1 when it never ran. */
  code: number;
  /** The apiserver's status line, '' when the command succeeded. */
  status: string;
  /** True when the failure is the connection rather than the command. */
  transport: boolean;
}

/**
 * Run one command in a pod and report everything about how it went.
 *
 * Resolves rather than rejects for a non-zero exit: an exit code is a fact, and a caller that
 * runs `tmux has-session` wants the answer either way. Channel 3 carries the apiserver's status
 * as JSON when the command ends, which is where the exit code is read from.
 */
export function podExecResult(
  pod: string, command: string[], timeoutMs = EXEC_TIMEOUT_MS, container: string = AGENT_CONTAINER, namespace: string = EXT_NS,
): Promise<PodExecResult> {
  return new Promise((resolve) => {
    const out = { stdout: '', stderr: '', status: '', code: -1, transport: false };
    let settled = false;
    let socket: WebSocket | null = null;
    // Two streaming decoders, because a multibyte character can straddle two frames.
    const decoders = { 1: new TextDecoder(), 2: new TextDecoder() } as Record<number, TextDecoder>;
    const finish = (transport = false, status = '') => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (transport) {
        out.transport = true;
        out.status = out.status || status;
      }
      try {
        socket?.close();
      } catch { /* already gone */ }
      resolve(out);
    };
    const timer = setTimeout(() => finish(true, `no answer from the pod in ${ Math.round(timeoutMs / 1000) }s`), timeoutMs);

    try {
      socket = new WebSocket(execUrl(pod, command, false, container, namespace), 'base64.channel.k8s.io');
    } catch (e: any) {
      finish(true, e?.message || String(e));

      return;
    }

    socket.onmessage = (event) => {
      const frame = String(event.data || '');
      const channel = Number(frame.slice(0, 1));
      let bytes: Uint8Array;

      try {
        bytes = Uint8Array.from(atob(frame.slice(1)), (c) => c.charCodeAt(0));
      } catch {
        return;
      }

      if (channel === 1 || channel === 2) {
        const text = decoders[channel].decode(bytes, { stream: true });

        if (channel === 1) {
          out.stdout += text;
        } else {
          out.stderr += text;
        }

        return;
      }

      if (channel === 3) {
        const message = new TextDecoder().decode(bytes);

        try {
          const status = JSON.parse(message);

          if (status.status === 'Success') {
            out.code = 0;
          } else {
            out.status = status.message || 'the command failed';
            const cause = (status.details?.causes || []).find((c: any) => c.reason === 'ExitCode');

            out.code = cause ? Number(cause.message) || 1 : 1;
          }
        } catch {
          out.status = message;
          out.code = out.code === -1 ? 1 : out.code;
        }
      }
    };

    socket.onclose = () => {
      out.stdout += decoders[1].decode();
      out.stderr += decoders[2].decode();
      // A socket that closed without the apiserver saying how the command went is one that was
      // refused or dropped - unless output arrived, in which case the command ran and the
      // status frame was the casualty.
      if (out.code === -1) {
        if (out.stdout || out.stderr) {
          out.code = 0;
        } else {
          finish(true, out.status || 'the exec was refused or dropped');

          return;
        }
      }
      finish();
    };
    socket.onerror = () => finish(true, 'could not open an exec to the pod');
  });
}

/** One command's stdout, whatever happened. For reads that may find nothing. */
export async function podExecOnce(
  pod: string, command: string[], timeoutMs?: number, container?: string, namespace?: string,
): Promise<string> {
  return (await podExecResult(pod, command, timeoutMs ?? EXEC_TIMEOUT_MS, container, namespace)).stdout;
}

export function shellQuote(value: string): string {
  return `'${ value.split("'").join(`'\\''`) }'`;
}

/**
 * A command, run as the pod's own user with its own home.
 *
 * The exec subresource runs as the container's user, root, and everything a pane touches
 * belongs to uid 1000 - claude refuses to run as root. A file written here as root is one the
 * pane cannot edit a minute later. `home` is the pane's, which is not the same directory in
 * every pod this is used on.
 */
export function asPodUser(script: string, home = '/workspace/.home'): string[] {
  const withHome = `export HOME=${ shellQuote(home) }; ${ script }`;

  return ['/bin/sh', '-c', `setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh -c ${ shellQuote(withHome) }`];
}

/** Where to run a read or a write, when it is not the agent pod. */
export interface PodTarget {
  pod: string;
  container?: string;
  namespace?: string;
  /** The pane's home in that pod, for asPodUser. */
  home?: string;
}

function inPod(target: PodTarget, script: string, timeoutMs?: number): Promise<string> {
  return podExecOnce(target.pod, asPodUser(script, target.home), timeoutMs, target.container || AGENT_CONTAINER, target.namespace || EXT_NS);
}

/** Base64 goes into the pod this many characters at a time: an exec is URL arguments. */
const IMAGE_CHUNK = 4 * 1024;

/**
 * Write an image into a pod, where a pane can hand its path to claude.
 *
 * Chunked through printf, then decoded in the pod: an exec's command is URL arguments, and a
 * screenshot is bigger than a URL is allowed to be.
 */
export async function writeImageToPod(target: PodTarget, path: string, data: ArrayBuffer, label = 'the pod'): Promise<void> {
  const bytes = new Uint8Array(data);
  let binary = '';

  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }

  const encoded = btoa(binary);
  const quoted = shellQuote(path);
  const stage = `${ quoted }.b64`;

  await inPod(target, `mkdir -p "$(dirname ${ quoted })" && : > ${ stage }`);

  for (let i = 0; i < encoded.length; i += IMAGE_CHUNK) {
    const chunk = encoded.slice(i, i + IMAGE_CHUNK);

    await inPod(target, `printf %s '${ chunk }' >> ${ stage }`);
  }

  const out = await inPod(target, `base64 -d ${ stage } > ${ quoted } && rm -f ${ stage } && wc -c < ${ quoted }`);

  if (!parseInt(out.trim(), 10)) {
    throw new Error(`the image did not land in ${ label }`);
  }
}

/** Reading what a terminal is talking about, out of the pod it is attached to. */
export interface PodPath {
  kind: 'dir' | 'file' | 'none';
  size: number;
}

/** How large a file this will pull through an exec. Beyond it, offer nothing rather than hang. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

export async function statPodPath(target: PodTarget, path: string): Promise<PodPath> {
  const quoted = shellQuote(path);
  const out = await inPod(target, `if [ -d ${ quoted } ]; then echo dir; elif [ -f ${ quoted } ]; then echo file; else echo none; fi; wc -c < ${ quoted } 2>/dev/null || echo 0`);
  const [kind, size] = out.trim().split(/\s+/);

  return { kind: (kind as PodPath['kind']) || 'none', size: parseInt(size, 10) || 0 };
}

/** One directory, directories first - the order a file manager uses. */
export async function listPodDir(target: PodTarget, path: string): Promise<{ name: string; dir: boolean }[]> {
  const out = await inPod(target, `ls -1Ap ${ shellQuote(path) } 2>/dev/null`);

  return out.split('\n')
    .map((line) => line.trim())
    .filter((line) => !!line && line !== './' && line !== '../')
    .map((line) => ({ name: line.replace(/\/$/, ''), dir: line.endsWith('/') }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

/** A file's bytes, base64 as they come off the exec, for an <img src> or a decode to text. */
export async function readPodFileBase64(target: PodTarget, path: string): Promise<string> {
  const { kind, size } = await statPodPath(target, path);

  if (kind !== 'file') {
    throw new Error(kind === 'dir' ? 'that is a directory' : 'no such file in this pod');
  }

  if (size > MAX_READ_BYTES) {
    throw new Error(`too large to open here (${ Math.round(size / 1024 / 1024) }MB)`);
  }

  // -w0 keeps it one line; busybox base64 has no -w, hence the tr for the wrapped case.
  return (await inPod(target, `{ base64 -w0 ${ shellQuote(path) } 2>/dev/null || base64 ${ shellQuote(path) } | tr -d '\\n'; }; echo`)).trim();
}

// ── Objects in the cluster ─────────────────────────────────────────────────────────────────

export interface ObjectSpec {
  type: string;
  namespace?: string;
  name: string;
  body: () => Record<string, unknown>;
}

export function objectPath(spec: { type: string; namespace?: string; name: string }): string {
  return spec.namespace
    ? `${ EXT_BASE }/v1/${ spec.type }/${ spec.namespace }/${ spec.name }`
    : `${ EXT_BASE }/v1/${ spec.type }/${ spec.name }`;
}

export async function objectExists(spec: { type: string; namespace?: string; name: string }): Promise<boolean> {
  return !!await rancherFetch(objectPath(spec)).catch(() => null);
}

/**
 * Create an object that is not there, and treat one that is as success.
 *
 * Two tabs opened at once both see nothing and both POST; one wins and the other is told the
 * object already exists. That is the outcome both wanted.
 */
export async function createIfAbsent(spec: ObjectSpec): Promise<'present' | 'created'> {
  if (await objectExists(spec)) {
    return 'present';
  }

  try {
    await rancherFetch(`${ EXT_BASE }/v1/${ spec.type }`, { method: 'POST', body: JSON.stringify(spec.body()) });

    return 'created';
  } catch (e: any) {
    if (/409|already exists|alreadyexists/i.test(e?.message || '')) {
      return 'present';
    }

    throw e;
  }
}

export function namespaceBody(): Record<string, unknown> {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: { name: EXT_NS } };
}

export function serviceAccountBody(): Record<string, unknown> {
  return { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { namespace: EXT_NS, name: EXT_ACCOUNT } };
}

/**
 * The grant: cluster-admin, because the agent's whole usefulness is that it can reach every pod
 * and ask the cluster anything. See overlay.ts for who is offered the way in.
 */
export function clusterRoleBindingBody(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRoleBinding',
    metadata:   { name: EXT_ROLE_BINDING },
    roleRef:    { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
    subjects:   [{ kind: 'ServiceAccount', name: EXT_ACCOUNT, namespace: EXT_NS }],
  };
}
