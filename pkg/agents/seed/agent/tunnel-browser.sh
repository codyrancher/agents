#!/bin/sh
# Give each downstream-hosted workspace the shared github-browser at 127.0.0.1:9223, so an agent's
# github media upload - which runs in the workspace pod via dev-shell - reaches the one Chromium that
# holds the github.com login, exactly as a local workspace does by service name.
#
# A downstream workspace pod is on another cluster and can reach nothing here: the browser
# (github-browser.dev-system.svc) does not resolve there, and the parent Rancher is not reachable
# from it either. The only channel in is the kubectl-exec stream the mount and dev-shell already use.
# CDP is not one connection - a /json probe then a WebSocket, and clients may overlap them - so a raw
# pipe (as the sshfs mount uses for its single sftp stream) will not do; ssh reverse-forwarding
# multiplexes every CDP connection over one exec stream. We run sshd in inetd mode (-i) in the
# workspace pod straight over `kubectl exec` (no listening port, no service), authenticate with a
# keypair this pod owns, and open `-R 127.0.0.1:9223 -> github-browser:9222` (reachable from here).
# layout.mjs sets the downstream workspace's GITHUB_BROWSER_CDP to http://127.0.0.1:9223 to match.
SECRET=/var/run/downstream-exec
LOCAL=local
BROWSER=github-browser.dev-system.svc.cluster.local:9222
PORT=9223
DIR=/workspace/.tunnel
KEY=$DIR/id
PATH=/workspace/.home/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export PATH

# kubectl arrives from terminal-tools.sh; ssh/ssh-keygen from boot.sh (openssh-client).
n=0
while ! command -v ssh >/dev/null 2>&1 || ! command -v kubectl >/dev/null 2>&1; do
  n=$((n + 1))
  [ "$n" -gt 120 ] && { echo "ssh/kubectl never arrived; not tunnelling"; exit 0; }
  sleep 10
done

# One keypair for this pod, reused for every workspace; its public half is authorized in each.
mkdir -p "$DIR"
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -f "$KEY"
PUB=$(cat "$KEY.pub")

# kubectl exec into a downstream workspace pod, through that cluster's Rancher proxy with the durable
# token - the same address the mount and dev-shell build. $1.. are the argv to run in the pod.
# No -i, and stdin from /dev/null: this runs inside a `while read` piped from kubectl, and an exec
# that holds stdin would swallow the rest of that list, so only the first workspace got a tunnel.
kexec() {
  name=$1; cluster=$2; shift 2
  kubectl --server="$RURL/k8s/clusters/$cluster" --token="$TOKEN" --insecure-skip-tls-verify=true \
    exec -n "dev-$name" "deploy/dev-$name" -c workspace -- "$@" </dev/null
}

# Install sshd, a host key, and our pubkey in the workspace pod, and free port 9223. Idempotent.
# The pubkey is passed as an argument (not interpolated into the script) so its spaces need no
# quoting care. Freeing 9223 matters: an sshd left by a dropped exec (an agent-pod restart orphans
# the workspace pod's inetd sshd) keeps the -R listener bound, and a fresh tunnel then fails to bind
# it ("Address already in use") forever. We only run this when there is no live tunnel (see alive),
# so killing every sshd here is safe.
ensure_sshd() {
  name=$1; cluster=$2
  kexec "$name" "$cluster" sh -c '
    command -v sshd >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq openssh-server; } >/dev/null 2>&1
    mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh
    [ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -A >/dev/null 2>&1
    grep -qxF "$1" /root/.ssh/authorized_keys 2>/dev/null || printf "%s\n" "$1" >> /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
    for p in $(pgrep -x sshd 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  ' sh "$PUB" >/dev/null 2>&1
}

# Is the tunnel for this workspace up AND carrying? The ssh process alive, and 9223 answering the
# CDP probe inside the pod - an ssh can stay up (ServerAliveInterval keeps the transport) while its
# -R forward is broken, so the process being alive is not enough. This does re-establish a broken
# one, and that no longer flaps: ensure_sshd frees 9223 first, so the re-establish binds and the next
# probe passes, rather than failing "address in use" forever.
alive() {
  name=$1; cluster=$2; pidf=$DIR/$name.pid
  [ -f "$pidf" ] && kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null || return 1
  kexec "$name" "$cluster" sh -c "curl -s -m4 -o /dev/null http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1
}

tunnel_one() {
  name=$1; cluster=$2; pidf=$DIR/$name.pid
  alive "$name" "$cluster" && return 0
  # No live tunnel: drop any old ssh (its exec, and the pod's sshd with it) before a fresh one.
  [ -f "$pidf" ] && { kill "$(cat "$pidf" 2>/dev/null)" 2>/dev/null; rm -f "$pidf"; }
  ensure_sshd "$name" "$cluster"
  # sshd -i speaks the ssh protocol over the exec stdio (inetd mode); ssh multiplexes the -R forward
  # over it. Root, pubkey-only, remote forwarding on - the pod's exec already runs as root.
  # ClientAliveInterval makes an orphaned sshd (its client gone) exit and free 9223 on its own.
  proxy="kubectl --server=$RURL/k8s/clusters/$cluster --token=$TOKEN --insecure-skip-tls-verify=true exec -i -n dev-$name deploy/dev-$name -c workspace -- /usr/sbin/sshd -i -e -o PermitRootLogin=prohibit-password -o PubkeyAuthentication=yes -o PasswordAuthentication=no -o AllowTcpForwarding=remote -o AuthorizedKeysFile=/root/.ssh/authorized_keys -o ClientAliveInterval=15 -o ClientAliveCountMax=2"
  ssh -N -T \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o "ProxyCommand=$proxy" \
    -i "$KEY" \
    -R "127.0.0.1:$PORT:$BROWSER" \
    root@downstream >/dev/null 2>&1 </dev/null &
  echo $! > "$pidf"
  echo "$(date -u +%FT%TZ) tunnel (re)started for $name ($cluster)"
}

while true; do
  TOKEN=$(cat "$SECRET/token" 2>/dev/null)
  RURL=$(cat "$SECRET/rancherUrl" 2>/dev/null)
  if [ -n "$TOKEN" ] && [ -n "$RURL" ]; then
    kubectl get appinstances.appsplus.io -A -o jsonpath='{range .items[*]}{.metadata.labels.dev\.rancher\.io/workspace}{" "}{.metadata.labels.dev\.rancher\.io/cluster}{"\n"}{end}' 2>/dev/null | \
    while read -r name cluster; do
      [ -n "$name" ] && [ -n "$cluster" ] || continue
      [ "$cluster" = "$LOCAL" ] && continue
      case "$name" in preview-*) continue ;; esac
      tunnel_one "$name" "$cluster"
    done
  fi
  sleep 20
done
