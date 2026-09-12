#!/bin/sh
# Entrypoint for the one agent pod.
#
# There is nothing to serve here, which is the whole difference between this pod and an
# extension's. It exists so that the terminal a person opens with a chord from any page in
# Rancher has somewhere to exec into, and everything that terminal needs - tmux, the claude CLI,
# kubectl - is installed by /seed/terminal-tools.sh, the same script every extension pod's
# terminal already runs. Sharing it is the point: a second, slightly different install is how
# the agent would end up with a different claude from the ones it is meant to help.
#
# This stays root. An extension pod drops to the node user here because its dev server has to
# own the tree webpack is watching; there is no dev server in this pod, and shell.sh drops each
# pane to the node user itself, so dropping the container's own process would only mean the
# install below could not use apt.
set -e

WORKSPACE=/workspace
AGENT_HOME="$WORKSPACE/.home"

# One directory per conversation, under the hostPath so both outlive the pod. They are separate
# because claude keys its history by working directory: two panes sharing one would mean the
# second resumed the first's conversation instead of having its own.
mkdir -p "$WORKSPACE/sessions" "$AGENT_HOME"

if [ "$(id -u)" = 0 ]; then
  # The hostPath arrives owned by root, and everything inside a pane is the node user. A login
  # claude cannot write is a login that has to be done again after every restart, which is the
  # one thing keeping HOME on this volume is for.
  chown node:node "$WORKSPACE" "$WORKSPACE/sessions" "$AGENT_HOME"
fi

# In the background, because nothing in this pod is waiting for it and a terminal opened before
# it finishes waits for it in shell.sh, where the waiting is visible. Idempotent and lock-guarded
# on the other side, so the two overlapping is a wait rather than two installs.
HOME_DIR="$AGENT_HOME" /bin/sh /seed/terminal-tools.sh >"$WORKSPACE/.terminal-tools.log" 2>&1 &

# The panes that were running when this pod last went down come back on their own. shell.sh
# records every conversation pane it starts (/workspace/.panes/<session>: the arguments, one
# per line); each is started again here, detached, once the tools it needs are installed, and
# the loop inside resumes the conversation by its id. Before this, a restart - Rancher's or
# this Deployment's - ended every conversation until somebody opened each one again, and a
# fix left running overnight was found stopped in the morning. Staggered a little: each start
# is a claude coming up.
(
  n=0
  while ! command -v tmux >/dev/null 2>&1 || [ ! -x "$AGENT_HOME/.local/bin/claude" ]; do
    n=$((n + 1))
    [ "$n" -gt 90 ] && { echo "tools never arrived; not restoring panes"; exit 0; }
    sleep 10
  done
  for f in "$WORKSPACE"/.panes/*; do
    [ -f "$f" ] || continue
    S=$(sed -n 1p "$f"); W=$(sed -n 2p "$f"); H=$(sed -n 3p "$f"); P=$(sed -n 5p "$f")
    [ -n "$S" ] || continue
    echo "$(date -u +%FT%TZ) restoring pane $S in $W"
    /bin/sh /seed/shell.sh "$S" "$W" "$H" start "$P" || echo "  could not restore $S"
    sleep 2
  done
  echo "$(date -u +%FT%TZ) done"
) >"$WORKSPACE/.panes.log" 2>&1 &

# The container's only remaining job is to stay up so there is something to exec into. `tail -f`
# on /dev/null is the smallest thing that does that and says nothing; a `sleep` with a number on
# it would end, and a pod that ends is a pod Kubernetes restarts for no reason.
exec tail -f /dev/null
