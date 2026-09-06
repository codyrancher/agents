// Giving the agent pod the identity of whoever opened the terminal.
//
// The pod has a ServiceAccount, as every pod does, and it is the wrong credential in both
// directions. Rancher does not accept a Kubernetes ServiceAccount token at all - it resolves to
// `system:cattle:error` and answers 401 - so the Studio's own service, which forwards whatever
// its caller presented and holds nothing of its own, tells the agent it sent no credential. And
// where the ServiceAccount does work, straight at the apiserver, it works as cluster-admin:
// more than the person watching is likely to have, the same for everybody, and attributable to
// nobody afterwards.
//
// So the browser mints a Rancher API token as the signed-in user and leaves it in a Secret the
// pod reads at pane start. One token is the whole answer, because everything the agent might
// want is behind the same Rancher:
//
//   Rancher's own API          $RANCHER_URL/v1/..., /v3/...
//   Kubernetes                 $RANCHER_URL/k8s/clusters/local, as a kubeconfig
//   the Studio's service       http://extension-studio-api:8006 directly, in-cluster
//   a registered extension     $RANCHER_URL + the registry entry's url, which is a path on it
//
// The direct address for the service is not an optimisation. Rancher's proxy consumes the
// Authorization header on the way through - which is why the browser authenticates with the
// R_SESS cookie instead - so a token sent through the proxy arrives as no credential at all.
//
// Two things to be clear about rather than quiet about. This puts a named person's Rancher
// credential in a pod that any admin can exec into, and all panes run as one user, so it is not
// separated per conversation; the chord is already admin-only, which is what makes that a
// bounded rather than a new exposure. And a conversation outlives the panel, so a detached
// agent loses its credential when the token expires - which is the intended end of it, not a
// bug to work around.
import { EXT_NS, EXT_BASE } from './pod';
import { rancherFetch } from './api';

/** The Secret the pod reads. One object, replaced, rather than one per person or per pane. */
export const AGENT_CREDENTIAL_SECRET = 'extension-studio-agent-credential';

/**
 * How long a minted token lives.
 *
 * Long enough that a working session is not interrupted, short enough that a token forgotten in
 * a pod stops being useful the same day. It is refreshed every time the panel opens, so the
 * only thing this actually bounds is how long an agent keeps working after the last person
 * closed their browser.
 */
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** What the token is called in Rancher's own list, where somebody may go looking to revoke it. */
const TOKEN_DESCRIPTION = 'Extension Studio agent terminal';

interface MintedToken {
  /** The value, `token-xxxxx:secret`, which Rancher returns exactly once. */
  token: string;
  /** The object to delete to revoke it. */
  id: string;
  /** Who it acts as. */
  userId: string;
}

function secretPath(): string {
  return `${ EXT_BASE }/v1/secret/${ EXT_NS }/${ AGENT_CREDENTIAL_SECRET }`;
}

/**
 * Mint a Rancher API token as the person whose session this is.
 *
 * Norman's `/v3/token` rather than Steve's token collection, because only this one answers with
 * the secret half. Rancher returns it once and never again, which is also why nothing here
 * tries to reuse a token it can see in the Secret: it can read that one back, but it cannot
 * check it, and a token somebody revoked from Rancher's own page would otherwise be handed to
 * the agent for ever.
 */
async function mintToken(): Promise<MintedToken> {
  const created = await rancherFetch('/v3/token', {
    method: 'POST',
    body:   JSON.stringify({
      type: 'token', description: TOKEN_DESCRIPTION, ttl: TOKEN_TTL_MS,
    }),
  });

  if (!created?.token) {
    throw new Error('Rancher created a token but did not return its value, so there is nothing to give the agent.');
  }

  return { token: created.token, id: created.id, userId: created.userId || '' };
}

/**
 * Revoke every token this feature has minted for this person except the one just made.
 *
 * A sweep rather than "delete the one the Secret used to hold", which is what this did first
 * and which leaks. Two panels opening at once, or a mint whose Secret write lost the race, both
 * leave a token nothing has a record of - and nothing would ever revoke it, so they accumulate
 * in the person's own API key list until somebody notices. Measured on this cluster after an
 * afternoon of reloading: three live where there should have been one.
 *
 * Scoped to this person's own tokens by `userId`, and that is not belt-and-braces. An admin
 * listing `/v3/tokens` sees everybody's, so a sweep on the description alone would revoke a
 * colleague's agent credential and end their conversation from across the cluster.
 *
 * It never fails loudly. A tidy-up that could not run is a token to clear next time, not a
 * reason to refuse somebody a terminal.
 */
async function revokeOthers(minted: MintedToken): Promise<void> {
  const listing = await rancherFetch('/v3/tokens').catch(() => null);
  const stale = (listing?.data || []).filter((token: any) => (
    token?.description === TOKEN_DESCRIPTION &&
    token?.userId === minted.userId &&
    token?.id !== minted.id
  ));

  await Promise.all(stale.map((token: any) => (
    rancherFetch(`/v3/tokens/${ token.id }`, { method: 'DELETE' }).catch(() => null)
  )));
}

function secretBody(minted: MintedToken): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind:       'Secret',
    type:       'Opaque',
    metadata:   {
      namespace: EXT_NS,
      name:      AGENT_CREDENTIAL_SECRET,
      labels:    { app: 'extension-studio-agent' },
    },
    data: {
      token:   btoa(minted.token),
      user:    btoa(minted.userId),
      tokenId: btoa(minted.id),
    },
  };
}

/**
 * Put the credential where the pod will find it, replacing whatever was there.
 *
 * Read first for the resourceVersion, because Steve refuses a replace without one. A create
 * that loses a race with another tab is retried as a replace rather than reported: both tabs
 * are the same person minting the same kind of token, and the later one winning is correct -
 * the one that lost is then swept by revokeOthers rather than stranded.
 */
async function writeSecret(minted: MintedToken): Promise<void> {
  const existing = await rancherFetch(secretPath()).catch(() => null);

  if (!existing) {
    await rancherFetch(`${ EXT_BASE }/v1/secret`, { method: 'POST', body: JSON.stringify(secretBody(minted)) })
      .catch(async() => {
        const now = await rancherFetch(secretPath());

        await replaceSecret(minted, now.metadata.resourceVersion);
      });

    return;
  }

  await replaceSecret(minted, existing.metadata.resourceVersion);
}

function replaceSecret(minted: MintedToken, resourceVersion: string): Promise<unknown> {
  const body = secretBody(minted);

  return rancherFetch(secretPath(), {
    method: 'PUT',
    body:   JSON.stringify({ ...body, metadata: { ...(body.metadata as object), resourceVersion } }),
  });
}

/**
 * Make sure the agent pod is holding a usable credential for this person, and return who it
 * now acts as.
 *
 * Called when the panel opens, before any pane is started, because the pane reads the Secret on
 * the way up and a pane that started first would be the one without an identity. Minting every
 * time rather than checking is deliberate: checking would cost a call that can only answer
 * "there is a token here", which is not the question - the question is whether it still works,
 * and the cheapest honest answer to that is a fresh one.
 */
export async function ensureAgentCredential(): Promise<string> {
  const minted = await mintToken();

  await writeSecret(minted);

  // After the new one is in place, so a failure here leaves the agent working with a spare
  // token rather than leaves it with none.
  await revokeOthers(minted);

  return minted.userId;
}
