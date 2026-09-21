#!/bin/sh
# Keep each downstream-hosted workspace mounted at /workspaces/<name> in this agent pod, so a
# conversation's pane - which always runs here - sees the files of a workspace running on another
# cluster exactly as it sees a local one.
#
# A local workspace's tree is on this pod's node and is already at /workspaces/<name> through the
# shared hostPath; this touches only workspaces on another cluster, whose tree is on that
# cluster's node and so absent here. Their files ride sshfs over the kubectl-exec channel - no
# sshd, no port-forward, no keys - through the Rancher proxy for the workspace's own cluster,
# authenticated by the durable token in the downstream-exec Secret. FUSE needs this container to
# be privileged (the Deployment sets it) and allow_other so the node user's panes can read a
# mount root made here. The exec tunnel for commands is the workspace's own bin/dev-shell, which
# layout.mjs writes cluster-aware to match. See downstream-conversation-mount.
SECRET=/var/run/downstream-exec
WRAP=/workspace/.mounts
SFTP=/usr/lib/openssh/sftp-server
LOCAL=local
PATH=/workspace/.home/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export PATH

# The tools this needs arrive asynchronously: kubectl from terminal-tools.sh, sshfs from boot.sh.
n=0
while ! command -v sshfs >/dev/null 2>&1 || ! command -v kubectl >/dev/null 2>&1; do
  n=$((n + 1))
  [ "$n" -gt 120 ] && { echo "sshfs/kubectl never arrived; not mounting"; exit 0; }
  sleep 10
done

# Run this instead of ssh: sshfs appends "host -s sftp", which is ignored, and the command pipes
# straight to sftp-server in the workspace pod over the exec channel via the cluster's proxy.
write_wrapper() {
  name=$1; cluster=$2
  mkdir -p "$WRAP"
  cat > "$WRAP/$name.sftp" <<EOF
#!/bin/sh
exec kubectl --server=$RURL/k8s/clusters/$cluster --token=$TOKEN --insecure-skip-tls-verify=true exec -i -n dev-$name deploy/dev-$name -c workspace -- $SFTP
EOF
  chmod +x "$WRAP/$name.sftp"
}

# The node image has no sftp-server; install it once per pod (idempotent, fast when present).
ensure_sftp() {
  name=$1; cluster=$2
  kubectl --server="$RURL/k8s/clusters/$cluster" --token="$TOKEN" --insecure-skip-tls-verify=true \
    exec -n "dev-$name" "deploy/dev-$name" -c workspace -- \
    sh -c "test -x $SFTP || { apt-get update -qq && apt-get install -y -qq openssh-sftp-server; } >/dev/null 2>&1" >/dev/null 2>&1
}

mount_one() {
  name=$1; cluster=$2; dir=/workspaces/$name
  # Already mounted and answering: nothing to do. A live sshfs mount stats quickly.
  if mountpoint -q "$dir" 2>/dev/null; then
    timeout 5 ls "$dir" >/dev/null 2>&1 && return 0
    # Mounted but dead: the exec channel dropped and reconnect did not bring it back, so every
    # access is an I/O error (and mkdir below would fail on it). Force it off - lazily, in case a
    # handle is stuck - so it can be remounted fresh this pass.
    echo "$(date -u +%FT%TZ) $name mount is dead, remounting"
    fusermount3 -uz "$dir" 2>/dev/null || umount -l "$dir" 2>/dev/null
  fi
  ensure_sftp "$name" "$cluster"
  write_wrapper "$name" "$cluster"
  mkdir -p "$dir" 2>/dev/null
  sshfs -o ssh_command="$WRAP/$name.sftp" x:/workspaces/$name "$dir" \
    -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,allow_other 2>/dev/null \
    && echo "$(date -u +%FT%TZ) mounted $name ($cluster)"
}

# The seed - bin/dev-shell (cluster-aware, since DEV_CLUSTER is set), the tools, .claude, CLAUDE.md.
# For a local workspace the workspace pod fetches this itself (workspace-tools ensureSeed); a
# downstream pod cannot reach the local dev-api, so it is laid out here instead, from the agent pod
# which can - written into the mount, which is the workspace pod's own disk. Refreshed only when the
# seed version or the workspace's issue/pr changes, recorded in the same .dev-seed marker ensureSeed
# reads, so the browser side skips a workspace this has already done.
SEED_URL=http://dev-api.dev-system.svc:8080/agent-seed
SEEDJSON=/workspace/.dev-seed.json
LAYOUT=/workspace/.dev-layout.mjs
SEEDVER=

fetch_seed() {
  curl -fsS -m 30 "$SEED_URL" -o "$SEEDJSON" 2>/dev/null || return 1
  node -e "const s=require(process.argv[1]);require('fs').writeFileSync(process.argv[2],s['layout.mjs'])" "$SEEDJSON" "$LAYOUT" 2>/dev/null || return 1
  SEEDVER=$(curl -fsS -m 10 "$SEED_URL/version" 2>/dev/null | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p')
  [ -n "$SEEDVER" ] || SEEDVER=unknown
  return 0
}

layout_one() {
  name=$1; cluster=$2; dir=/workspaces/$name
  [ -f "$LAYOUT" ] || return 0
  issue=$(printf '%s' "$name" | sed -n 's/^issue-\([0-9][0-9]*\).*/\1/p')
  pr=$(printf '%s' "$name" | sed -n 's/^pr-\([0-9][0-9]*\).*/\1/p')
  marker="$SEEDVER:$issue:$pr:$name"
  [ "$(cat "$dir/.dev-seed" 2>/dev/null)" = "$marker" ] && return 0
  if DEV_PROJECT="$name" DEV_ISSUE="$issue" DEV_PR="$pr" DEV_CLUSTER="$cluster" \
     DEV_ROOT="$dir" DEV_WORKDIR="$dir/dashboard" DEV_HOME="$dir/.home" DEV_SEED_FILE="$SEEDJSON" \
     node "$LAYOUT" >/dev/null 2>&1; then
    printf '%s' "$marker" > "$dir/.dev-seed"
    echo "$(date -u +%FT%TZ) laid out seed for $name ($cluster)"
  fi
}

while true; do
  TOKEN=$(cat "$SECRET/token" 2>/dev/null)
  RURL=$(cat "$SECRET/rancherUrl" 2>/dev/null)
  if [ -n "$TOKEN" ] && [ -n "$RURL" ]; then
    fetch_seed
    # The workspaces this Rancher knows, each with the cluster it runs on. Read on this (local)
    # cluster, where every workspace's Installation lives whatever cluster it deploys to.
    kubectl get appinstances.appsplus.io -A -o jsonpath='{range .items[*]}{.metadata.labels.dev\.rancher\.io/workspace}{" "}{.metadata.labels.dev\.rancher\.io/cluster}{"\n"}{end}' 2>/dev/null | \
    while read -r name cluster; do
      [ -n "$name" ] && [ -n "$cluster" ] || continue
      [ "$cluster" = "$LOCAL" ] && continue
      # A preview is a built page with no shell, so nothing runs a conversation in it.
      case "$name" in preview-*) continue ;; esac
      # mount_one mounts if absent and remounts if the existing mount has gone dead.
      mount_one "$name" "$cluster"
      # Once it answers, lay the seed into it (from here - the workspace pod can't fetch it itself).
      timeout 5 ls "/workspaces/$name" >/dev/null 2>&1 && layout_one "$name" "$cluster"
    done
  fi
  sleep 20
done
