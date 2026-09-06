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

# The container's only remaining job is to stay up so there is something to exec into. `tail -f`
# on /dev/null is the smallest thing that does that and says nothing; a `sleep` with a number on
# it would end, and a pod that ends is a pod Kubernetes restarts for no reason.
exec tail -f /dev/null
