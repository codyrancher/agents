// Talking to Rancher, which for this extension is one function.
//
// Everything goes through Rancher's own API, same-origin: the page already has a session and
// the browser already sends it, so there is no client to construct, nothing to configure and
// no token to keep. What is left is the two things fetch does not do by itself - a CSRF header
// on writes, and an error that says what went wrong rather than resolving to a 500 body.
//
// This file used to be the closet API as well: creating them, listing them, and the per-user
// secret sets they were handed at start. That is gone, and with it the notion of a current
// cluster - every path this extension builds names its cluster outright.

function csrfHeader(): Record<string, string> {
  const match = document.cookie.match(/(?:^|;\s*)CSRF=([^;]*)/);

  return { 'X-Api-Csrf': match ? decodeURIComponent(match[1]) : 'CSRF' };
}

/**
 * A Rancher API call, as JSON, that throws on failure.
 *
 * The path is given whole rather than built here, because the callers know which cluster and
 * which API they mean and this does not.
 */
export async function rancherFetch(path: string, init?: RequestInit): Promise<any> {
  const write = init?.method && init.method !== 'GET';
  const resp = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      ...(write ? csrfHeader() : {}),
      ...(init?.headers || {}),
    },
  });
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(data.message || data.error || `HTTP ${ resp.status }`);
  }

  return data;
}
