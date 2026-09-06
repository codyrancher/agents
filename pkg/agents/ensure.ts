// Keeping an object in the cluster equal to the thing this bundle would create.
//
// `createIfAbsent` is the right rule for anything whose value is that it exists - a namespace, a
// ServiceAccount, the browser pod, whose replacement would throw away a live session. It is the
// wrong rule for anything whose value is its contents, and this product has two of those: the
// service's own source, and an extension's entry in the API registry.
//
// Both fail the same way when they are only ever created. A cluster keeps whatever it was first
// given, nothing anywhere reports a mismatch, and the source or the version being advertised
// stops being the one that is running. So an object that carries generated content records a
// fingerprint of that content, and is replaced when the fingerprint no longer matches.
import { rancherFetch } from './api';
import { objectPath, createIfAbsent } from './pod';

/** One object this extension makes: what it is, one sentence on why, and how to make it. */
export interface InstallStep {
  id: string;
  label: string;
  description: string;
  /** The Steve collection, for reading and creating it. */
  type: string;
  uiType: string;
  namespace?: string;
  name: string;
  body: () => Record<string, unknown>;
}

/** Where the fingerprint is recorded. See the note on the prefix in api-registry.ts. */
export const VERSION_ANNOTATION = 'barn.rancher.io/source-version';

/**
 * A short, stable fingerprint of whatever this object is carrying.
 *
 * djb2 rather than a real digest: `crypto.subtle` is async, this is called from body builders
 * that are not, and the requirement is only that a changed byte changes the answer. It is not
 * defending against anything, it is noticing.
 */
export function contentVersion(parts: string[]): string {
  let hash = 5381;

  for (const text of parts) {
    for (let i = 0; i < text.length; i++) {
      hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    }
  }

  return hash.toString(16).padStart(8, '0');
}

/**
 * Create what is missing, and replace what has fallen behind.
 *
 * A step whose body records no fingerprint is only ever created, which is how every step that
 * predates this keeps its old behaviour.
 */
export async function ensureCurrent(steps: InstallStep[]): Promise<void> {
  for (const step of steps) {
    if (await createIfAbsent(step) === 'created') {
      continue;
    }

    await replaceIfStale(step);
  }
}

/**
 * Bring one existing object up to what this bundle would write, and leave it alone otherwise.
 *
 * Read first, and compare the fingerprint rather than the contents: an object Kubernetes has
 * defaulted and annotated is never byte-equal to the one that created it, so "did it change"
 * has to be asked of something we control.
 *
 * The fingerprint has to be on `metadata.annotations`, which is where this looks. Recording it
 * anywhere else - on a pod template, say - means this sees nothing to do while the object it
 * governs is stale, which is worse than not checking at all: the ConfigMap gets rewritten and
 * the Deployment that mounts it does not.
 *
 * A PUT needs the resourceVersion it read, which is also what makes this safe against a second
 * tab doing the same thing: the loser is told the object moved and gives up, and the winner has
 * already written what the loser was going to write.
 */
async function replaceIfStale(step: InstallStep): Promise<void> {
  const wanted = (step.body().metadata as any)?.annotations?.[VERSION_ANNOTATION];

  if (!wanted) {
    return;
  }

  const existing = await rancherFetch(objectPath(step)).catch(() => null);

  if (!existing || existing.metadata?.annotations?.[VERSION_ANNOTATION] === wanted) {
    return;
  }

  const body: any = step.body();

  body.metadata.resourceVersion = existing.metadata?.resourceVersion;

  await rancherFetch(objectPath(step), { method: 'PUT', body: JSON.stringify(body) });
}
