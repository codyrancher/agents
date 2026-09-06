#!/bin/sh
# Give this pod's panes the identity of the person who opened the terminal.
#
#   /bin/sh /seed/rancher-credential.sh <home-dir>
#
# Run by shell.sh before a pane starts, and a no-op everywhere except the agent pod, where the
# file exists at all.
#
# ---------------------------------------------------------------------------
# Why a pod needs this when it already has a ServiceAccount.
#
# It has one, and it is bound to cluster-admin, and that is the wrong credential twice over.
# Rancher does not accept a Kubernetes ServiceAccount token - it resolves to `system:cattle:error`
# and every call comes back 401 or 403 - so the Studio's own API, which forwards whatever
# credential its caller presented, answers this pod 401 and there is nothing it can do about it.
# And where the ServiceAccount does work, against the apiserver directly, it works as
# cluster-admin: more than the person watching the terminal is likely to have, attributable to
# nobody, and the same for everyone who opens the panel.
#
# So the browser mints a Rancher API token as whoever is signed in, puts it in a Secret, and
# this reads it back. What the pane gets is that person's rights and no more:
#
#   ~/.kube/config      kubectl, through Rancher's cluster proxy, as them
#   ~/.rancher/env      RANCHER_TOKEN and the two addresses, for curl
#
# One token reaches all of it, which is the point of doing it this way rather than per API:
# Rancher's own /v1 and /v3, the apiserver under /k8s/clusters/local, the Studio's service, and
# any extension in the API registry, since a registry entry's URL is a path on the same host.
#
# It never fails loudly. A pod whose Secret has not been written yet - nobody has opened the
# panel since it was created - is a pod with no Rancher identity, which is a thing to say on the
# way past and not a reason to refuse somebody a terminal.
set -e

HOME_DIR=${1:-/workspace/.home}
NAMESPACE=extension-studio
SECRET=extension-studio-agent-credential

say() {
  echo "[rancher] $1"
}

# The ServiceAccount, explicitly, because the file this script is about to write would otherwise
# be the credential it uses to read its own replacement. `KUBECONFIG` naming nothing sends
# kubectl to the in-cluster config, which is the SA - checked in the pod rather than assumed.
sa_kubectl() {
  KUBECONFIG=/dev/null kubectl "$@"
}

TOKEN=$(sa_kubectl -n "$NAMESPACE" get secret "$SECRET" -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || true)

if [ -z "$TOKEN" ]; then
  say "no Rancher credential yet - the panel writes one when somebody opens it"
  exit 0
fi

USER_NAME=$(sa_kubectl -n "$NAMESPACE" get secret "$SECRET" -o jsonpath='{.data.user}' 2>/dev/null | base64 -d 2>/dev/null || true)

if [ -z "$RANCHER_URL" ]; then
  say "RANCHER_URL is not set on this pod, so there is no address to point a credential at"
  exit 0
fi

# Written whole and moved into place, and the mode set on the temporary file rather than after
# the rename, so a second pane starting mid-write reads either the old file or the new one and
# never a half of either, and neither is ever briefly readable by anything else on the node.
write_private() {
  dest=$1
  tmp="$dest.$$"

  mkdir -p "$(dirname "$dest")"
  cat > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$dest"
}

# `insecure-skip-tls-verify`, because RANCHER_URL is the node's address and Rancher's
# certificate is issued for its hostname. This is the same hop the browser makes and the same
# one every curl in the seeded CLAUDE.md makes with -k; pretending otherwise would mean shipping
# a kubeconfig that cannot connect.
write_private "$HOME_DIR/.kube/config" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: rancher
  cluster:
    server: $RANCHER_URL/k8s/clusters/local
    insecure-skip-tls-verify: true
contexts:
- name: rancher
  context:
    cluster: rancher
    user: rancher
current-context: rancher
users:
- name: rancher
  user:
    token: $TOKEN
EOF

# Sourced rather than exported, because tmux passes this script's environment into a session it
# creates and not into one it attaches to - so a pane that came back from a reload would have
# had the variables and the next one would not. A file both of them read has no such difference.
write_private "$HOME_DIR/.rancher/env" <<EOF
# Sourced by a pane: . ~/.rancher/env
RANCHER_URL=$RANCHER_URL
RANCHER_TOKEN=$TOKEN
EXTENSION_STUDIO_API=http://extension-studio-api:8006
export RANCHER_URL RANCHER_TOKEN EXTENSION_STUDIO_API
EOF

if [ "$(id -u)" = 0 ]; then
  chown -R node:node "$HOME_DIR/.kube" "$HOME_DIR/.rancher" 2>/dev/null || true
fi

say "acting as ${USER_NAME:-the signed-in user}"
