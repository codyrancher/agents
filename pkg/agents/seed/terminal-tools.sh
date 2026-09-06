#!/bin/sh
# What a terminal tab needs, on top of what the dev server needs: tmux, so a
# session outlives the browser tab that opened it, and the claude CLI, which is
# what actually runs in the pane.
#
# Both land in the container filesystem, which a restart throws away, so this
# runs on every boot. It is called twice, deliberately:
#
#   - from boot.sh, in the background, because the dev server does not depend on
#     any of it and must not wait for it;
#   - from shell.sh, in the foreground, so a tab opened before the background
#     run finished waits here, where the waiting is visible, rather than landing
#     in a pane with no claude in it.
#
# Hence the lock: the two can overlap on a pod that has just started.
set -e

LOCK=/tmp/terminal-tools.lock

# Which home the tools are installed into and run with. HOME_DIR is passed by shell.sh, since
# which directory outlives the pod depends on which kind of pod this is: /app for a dev server,
# /workspace for the agent. The default is for the background run from boot.sh, which is a dev
# server's.
#
# Read at the top rather than at the bottom, where it used to be, because the claude install is
# now inside it and so is the question of whether there is anything to install.
APP_HOME=${HOME_DIR:-/app/.home}
CLAUDE_BIN="$APP_HOME/.local/bin/claude"

# Run something as the node user, with the home and the PATH a pane will have.
#
# Every pane is that user - claude refuses --dangerously-skip-permissions as root, and the files
# it edits are the ones webpack is watching - so anything installed into a home has to be
# installed by the user who will run it. The exec subresource arrives as root; boot.sh calls
# this before it drops.
as_node() {
  # TRUST_DIRS is forwarded here rather than by the one caller that sets it, because
  # `VAR=x some_function` does not reliably export VAR to what the function then runs.
  if [ "$(id -u)" = 0 ]; then
    setpriv --reuid=1000 --regid=1000 --init-groups \
      env "HOME=$APP_HOME" "PATH=$APP_HOME/.local/bin:$PATH" "TRUST_DIRS=${TRUST_DIRS:-}" sh -c "$1"
  else
    env "HOME=$APP_HOME" "PATH=$APP_HOME/.local/bin:$PATH" "TRUST_DIRS=${TRUST_DIRS:-}" sh -c "$1"
  fi
}

# Is there anything to do at all?
#
# Asked before the lock is touched, and that ordering is the point. Everything the lock
# protects is an install, so a tab opening in a pod that finished installing hours ago has
# nothing to serialise with anybody - and a pod is in that state for all but the first few
# minutes of its life. Taking a lock to discover there is no work is how one wedged tab used to
# block every tab after it.
have_tools() {
  command -v tmux >/dev/null 2>&1 &&
    [ -x "$CLAUDE_BIN" ] &&
    command -v kubectl >/dev/null 2>&1
}

# What wedges a tab, and why the waiting had to be bounded.
#
# A tab is a Kubernetes exec on a pty. Close the browser tab and nothing drains that pty any
# more, so the next write into it blocks - and stays blocked, because the reader is never
# coming back. A shell stuck there is alive by every test available: it has a pid, kill -0
# succeeds, and if it was holding the lock when it stopped, it holds it for the life of the pod.
# Observed: six of them in one pod, the oldest four hours old, each stopped mid-echo of the
# message below.
#
# So three things, none of which is sufficient alone. The check above means a settled pod never
# takes the lock. The message is printed once rather than every three seconds, because it was
# the repetition that filled the pty. And the wait gives up: if the tools turn out to be there,
# whoever holds the lock is not installing anything this tab needs.
if ! have_tools; then
  waited=0
  said=""
  took=""

  while true; do
    # Taking it is the loop's exit, and `took` is how the release below knows this shell owns
    # what it is about to delete. The other way out of here is giving up, which must not.
    if mkdir "$LOCK" 2>/dev/null; then
      took=yes
      break
    fi

    holder=$(cat "$LOCK/pid" 2>/dev/null || true)

    # A holder that has exited outright. Older locks carry no pid at all, which is the same
    # conclusion by a different route once nobody has claimed it for a while.
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      echo "[tools] the install holding this lock is gone; clearing it"
      rm -rf "$LOCK"
      continue
    fi

    if [ -z "$holder" ] && [ "$waited" -ge 10 ]; then
      echo "[tools] this lock has no owner; clearing it"
      rm -rf "$LOCK"
      continue
    fi

    # Two minutes is longer than an install of tmux and the claude CLI on a warm image and
    # shorter than anybody will sit and watch. Past it, believe the filesystem over the lock.
    if [ "$waited" -ge 40 ]; then
      if have_tools; then
        echo "[tools] the lock is held but everything is installed; carrying on"
        break
      fi

      echo "[tools] the lock has been held for two minutes; taking it over"
      rm -rf "$LOCK"
      continue
    fi

    if [ -z "$said" ]; then
      echo "[tools] another install is running, waiting for it"
      said=yes
    fi

    waited=$((waited + 1))
    sleep 3
  done

  # Only what this shell actually took. Giving up on a lock somebody else holds and then
  # deleting it on the way out would be worse than the wait it was avoiding.
  if [ -n "$took" ]; then
    echo $$ > "$LOCK/pid" 2>/dev/null || true

    # HUP as well as the rest: an exec that is hung up should release this on the way out
    # rather than leave it for a pod restart to clear.
    trap 'rm -rf "$LOCK" 2>/dev/null || true' EXIT INT TERM HUP
  fi
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "[tools] installing tmux"
  apt-get update -qq
  apt-get install -y -qq tmux </dev/null
fi

if [ ! -x "$CLAUDE_BIN" ]; then
  echo "[tools] installing the claude cli (this takes a moment)"

  # The native installer, into the pane's own durable home, and it is worth saying what that
  # buys over the `npm install -g` it replaces. `claude doctor` in a pod used to report
  # `npm-global` and a warning - "can't auto-update: npm global folder isn't writable" - because
  # /usr/local/lib belongs to root and the pane does not, so the CLI in here could never take an
  # update. The harness's own claude reports `native`, and now so does this. It also lands on
  # the hostPath, so a pod restart no longer spends a minute reinstalling it.
  #
  # npm stays as the fallback rather than the default: it reaches a different host, so the two
  # do not fail together, and a pane with a slightly older claude in it beats a pane with none.
  as_node "curl -fsSL https://claude.ai/install.sh | bash -s latest" || true

  if [ ! -x "$CLAUDE_BIN" ] && ! command -v claude >/dev/null 2>&1; then
    echo "[tools] the native installer did not land; falling back to npm"
    npm install -g --silent @anthropic-ai/claude-code
  fi
fi

# A pod that was started before this change keeps its npm copy in the container filesystem until
# it restarts, and `claude doctor` calls that a leftover - correctly, since two claudes on one
# PATH is a coin toss about which one a pane gets. Only when the native one is actually there,
# so a pod that fell back to npm above keeps the only claude it has.
if [ -x "$CLAUDE_BIN" ] && [ "$(id -u)" = 0 ] && [ -e /usr/local/bin/claude ]; then
  echo "[tools] removing the npm copy this pod installed before"
  npm -g uninstall @anthropic-ai/claude-code >/dev/null 2>&1 || rm -f /usr/local/bin/claude
fi

# kubectl, so the pod's own ServiceAccount is usable from a terminal. It needs
# no configuration: in-cluster credentials are mounted and client-go finds them,
# which is the whole reason the terminals can manage the cluster at all.
#
# Pinned to the cluster's version rather than "stable", so what a terminal gets
# does not change under it on a day when upstream moves.
if ! command -v kubectl >/dev/null 2>&1; then
  echo "[tools] installing kubectl"
  curl -sSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/v1.36.1/bin/linux/amd64/kubectl"
  chmod 0755 /usr/local/bin/kubectl
fi

# Answer claude's first-run questions before it can ask them, so a tab opens on
# a prompt or a login rather than on a theme picker. Idempotent, and a no-op
# once the flags are set, so it is safe to run on every boot and every tab.
#
# As the node user: this writes into the home claude runs with, and a root-owned
# .claude.json is one claude cannot then update. APP_HOME is set at the top of this file.
#
# TRUST_DIRS is the pane's own directory, passed by shell.sh, so the folder the
# tab is about to open in is one claude already trusts rather than one it stops
# and asks about.
as_node "node /seed/claude-defaults.mjs"

echo "[tools] ready"
