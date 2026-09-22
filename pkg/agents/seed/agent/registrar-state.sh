#!/bin/sh
# Report each downstream workspace's live state into the `dev-workspaces-downstream` ConfigMap on
# local, so dev-api can fold it into the `dev-workspaces` registrar the sidebar reads. dev-api runs
# on local and cannot see downstream pods; this pod already reaches them (the downstream-exec token
# through the Rancher proxy, like the mount daemon). This is the single writer of that ConfigMap.
# See dev-api's reconcileRegistrar.
SECRET=/var/run/downstream-exec
NS=dev-system
CM=dev-workspaces-downstream
LOCAL=local
DIR=/workspace/.registrar
PATH=/workspace/.home/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export PATH

# kubectl from terminal-tools.sh, node from the image.
n=0
while ! command -v kubectl >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; do
  n=$((n + 1))
  [ "$n" -gt 120 ] && { echo "kubectl/node never arrived; not reporting downstream state"; exit 0; }
  sleep 10
done
mkdir -p "$DIR"

while true; do
  TOKEN=$(cat "$SECRET/token" 2>/dev/null)
  RURL=$(cat "$SECRET/rancherUrl" 2>/dev/null)
  if [ -n "$TOKEN" ] && [ -n "$RURL" ]; then
    # Every workspace and the cluster it runs on, from the local Installations. KUBECONFIG=/dev/null
    # makes kubectl use this pod's own in-cluster service account against the local apiserver. A failed
    # read here would truncate the list to empty, and an empty list would blank every downstream
    # workspace to "starting" this tick (the node pass would iterate nothing). On any doubt do nothing
    # this tick, exactly as dev-api skips when its Installation list read throws - do it BEFORE the rm
    # so the previous state.json survives untouched (last-good) rather than being rebuilt from empty.
    if ! KUBECONFIG=/dev/null kubectl get appinstances.appsplus.io -A \
      -o jsonpath='{range .items[*]}{.metadata.labels.dev\.rancher\.io/workspace}{" "}{.metadata.labels.dev\.rancher\.io/cluster}{"\n"}{end}' </dev/null > "$DIR/list" 2>/dev/null; then
      sleep 15
      continue
    fi
    rm -f "$DIR"/*.deploy.json 2>/dev/null
    : > "$DIR/downstream"
    # Read from a file (not a pipe) and give every inner command </dev/null, so an exec that holds
    # stdin cannot swallow the rest of the list (the bug that once left all but the first workspace).
    while read -r name cluster; do
      [ -n "$name" ] && [ -n "$cluster" ] || continue
      [ "$cluster" = "$LOCAL" ] && continue
      case "$name" in preview-*|storybook-*) continue ;; esac
      # Every downstream workspace we mean to report, whether or not the read below succeeds. The node
      # pass carries a failed read's LAST-GOOD state forward rather than blanking it to "starting".
      echo "$name" >> "$DIR/downstream"
      # On a read failure leave no file (the rm above cleared it): absent = "could not read", which
      # the node pass treats as last-good, not as "stopped". A '{}' here would flap it to "starting".
      kubectl --server="$RURL/k8s/clusters/$cluster" --token="$TOKEN" --insecure-skip-tls-verify=true \
        get deploy "dev-$name" -n "dev-$name" -o json </dev/null > "$DIR/$name.deploy.json" 2>/dev/null \
        || rm -f "$DIR/$name.deploy.json"
    done < "$DIR/list"
    # One node pass -> { name: { state, detail, replicas, ready, lastSeen } }, mirroring api.ts
    # stateOf at the Deployment level (pod-level error detail is left to the browser). For a workspace
    # whose read failed this tick, keep the previous entry (its lastSeen ages, so staleness shows)
    # instead of flapping it. Workspaces no longer in the list are dropped. Then apply on local
    # (create-or-update). A node crash leaves the previous state.json untouched - last-good, not blank.
    node -e '
      const fs = require("fs"), path = require("path");
      const dir = process.argv[1];
      let prev = {};
      try { prev = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")); } catch (e) {}
      const names = fs.readFileSync(path.join(dir, "downstream"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
      const out = {};
      for (const name of names) {
        let d = null;
        try { d = JSON.parse(fs.readFileSync(path.join(dir, name + ".deploy.json"), "utf8")); } catch (e) {}
        if (d && d.metadata) {
          const replicas = (d.spec && d.spec.replicas) || 0;
          const ready = (d.status && d.status.readyReplicas) || 0;
          const state = replicas === 0 ? "stopped" : ready > 0 ? "running" : "starting";
          out[name] = { state, detail: "", replicas, ready, lastSeen: new Date().toISOString() };
        } else if (prev[name]) {
          out[name] = prev[name]; // read failed this tick: keep last-good, let lastSeen age
        } else {
          out[name] = { state: "starting", detail: "", replicas: 0, ready: 0, lastSeen: new Date().toISOString() };
        }
      }
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(out));
    ' "$DIR" 2>/dev/null || true
    KUBECONFIG=/dev/null kubectl -n "$NS" create configmap "$CM" \
      --from-file=state.json="$DIR/state.json" --dry-run=client -o yaml 2>/dev/null \
      | KUBECONFIG=/dev/null kubectl apply -f - >/dev/null 2>&1
  fi
  sleep 15
done
