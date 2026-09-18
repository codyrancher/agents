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
  mountpoint -q "$dir" 2>/dev/null && return 0
  ensure_sftp "$name" "$cluster"
  write_wrapper "$name" "$cluster"
  mkdir -p "$dir"
  sshfs -o ssh_command="$WRAP/$name.sftp" x:/workspaces/$name "$dir" \
    -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,allow_other 2>/dev/null \
    && echo "$(date -u +%FT%TZ) mounted $name ($cluster)"
}

while true; do
  TOKEN=$(cat "$SECRET/token" 2>/dev/null)
  RURL=$(cat "$SECRET/rancherUrl" 2>/dev/null)
  if [ -n "$TOKEN" ] && [ -n "$RURL" ]; then
    # The workspaces this Rancher knows, each with the cluster it runs on. Read on this (local)
    # cluster, where every workspace's Installation lives whatever cluster it deploys to.
    kubectl get appinstances.appsplus.io -A -o jsonpath='{range .items[*]}{.metadata.labels.dev\.rancher\.io/workspace}{" "}{.metadata.labels.dev\.rancher\.io/cluster}{"\n"}{end}' 2>/dev/null | \
    while read -r name cluster; do
      [ -n "$name" ] && [ -n "$cluster" ] || continue
      [ "$cluster" = "$LOCAL" ] && continue
      # A preview is a built page with no shell, so nothing runs a conversation in it.
      case "$name" in preview-*) continue ;; esac
      mountpoint -q "/workspaces/$name" 2>/dev/null || mount_one "$name" "$cluster"
    done
  fi
  sleep 20
done
