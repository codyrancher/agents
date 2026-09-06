#!/bin/sh
# Entrypoint for a terminal tab. The extension's terminal component runs this
# over the Kubernetes exec subresource, with the tab's session id as $1 and,
# optionally, the directory the pane should start in as $2, the home directory
# claude should keep its state in as $3, and what the pane should run as $4
# (claude, shell, or start - see MODE below).
#
# Everything the tab runs comes out of /seed rather than the tree, so a tab
# always starts the scripts the extension last wrote, without a pod restart.
#
# The session is a tmux session, which is the whole persistence story: `-A`
# attaches to it if it is already there and creates it otherwise, so closing the
# browser leaves claude running and reopening the editor lands back in the same
# conversation.
set -e

SESSION=${1:-main}

# Where the pane starts, and what claude is therefore pointed at. The default is
# DevExtension's own source, the tree this pod's dev server is compiling and
# serving, which is what the editor's pane wants.
#
# It is an argument because claude keys its conversation history by working
# directory, so one directory means one conversation, and two panes sharing a
# directory means the second one resumes the first one's conversation rather than
# having its own. The harness gives each terminal tab a directory for exactly
# this reason. Callers that want several independent sessions (the Dev product's
# global terminals) pass one per session; callers that want the source tree pass
# nothing.
#
# The source tree is found rather than named. It used to be spelled out, because every pod
# served the same package; now a pod serves whatever it was seeded, cloned or imported as, and
# the directory is called whatever that package's name is. First directory under /app/pkg, the
# same rule PACKAGE_DIR uses on the other side of this. /app is the fallback's fallback, for a
# pod whose tree has not been written yet - a shell in the wrong directory beats no shell.
WORKDIR=$2

if [ -z "$WORKDIR" ]; then
  # By name first. A pod created before extensions were renamed off their seed holds two package
  # directories, and `head -1` takes them alphabetically - which started demo's assistant in
  # base's tree, so every turn it committed and every file it touched belonged to the wrong
  # extension. The glob stays for an imported repository, whose package keeps its upstream name.
  if [ -n "$EXTENSION_NAME" ] && [ -d "/app/pkg/$EXTENSION_NAME" ]; then
    WORKDIR="/app/pkg/$EXTENSION_NAME"
  else
    WORKDIR=$(ls -d /app/pkg/*/ 2>/dev/null | head -1 | sed 's|/$||')
  fi
  WORKDIR=${WORKDIR:-/app}
fi

# Where claude's login and settings live, which has to be on whatever storage
# outlives the pod or every restart is another /login. It is an argument because
# this script runs in two kinds of pod: the dev server's, whose durable
# directory is /app, and a workspace's, whose is /workspace.
HOME_DIR=${3:-/app/.home}

# Made here as well as by whatever booted the pod, because everything below
# writes into it and a missing one is a login that cannot be saved. Cheap, and
# a no-op on the second tab.
if [ ! -d "$HOME_DIR" ]; then
  mkdir -p "$HOME_DIR"

  if [ "$(id -u)" = 0 ]; then
    chown node:node "$HOME_DIR"
  fi
fi

# A prompt this conversation was opened with, if something queued one. It is a file rather
# than an argument because whoever queues it is not the thing that starts the pane: a page
# writes it into the pod and the pane picks it up whenever it next starts. Beside the home
# directory, so it is on the same storage and outlives a pod restart the way a login does.
QUEUE_DIR="$(dirname "$HOME_DIR")/.queue"
MC_QUEUE="$QUEUE_DIR/$SESSION"

export MC_QUEUE

# The skills this pod's assistant can use, where claude looks for them.
#
# Copied rather than linked, and refreshed on every tab, so an extension picks up
# a corrected skill without a pod restart - the same reasoning as everything else
# coming out of /seed rather than the tree. A skill the assistant cannot find is
# a skill nobody wrote.
SKILL_SEP=__PATH_SEPARATOR__

for f in /seed/skills"$SKILL_SEP"*; do
  [ -f "$f" ] || continue

  # /seed is a read-only ConfigMap mount and a ConfigMap key cannot hold a slash,
  # so a skill arrives as one flat file per path and is un-flattened here, into
  # the one place claude looks and this script can write.
  rel=$(basename "$f" | sed "s|$SKILL_SEP|/|g")
  dest="$HOME_DIR/.claude/$rel"

  mkdir -p "$(dirname "$dest")"
  cp "$f" "$dest"
done

if [ "$(id -u)" = 0 ] && [ -d "$HOME_DIR/.claude" ]; then
  chown -R node:node "$HOME_DIR/.claude" 2>/dev/null || true
fi

HOME_DIR="$HOME_DIR" TRUST_DIRS="$WORKDIR" /bin/sh /seed/terminal-tools.sh

# A session directory has to exist before tmux is told to start in it, and it has
# to belong to the node user, since everything in the pane is that user and
# claude writes here. Only for a directory this creates: the default is the
# source tree, which boot.sh already handed over.
if [ ! -d "$WORKDIR" ]; then
  mkdir -p "$WORKDIR"

  if [ "$(id -u)" = 0 ]; then
    chown node:node "$WORKDIR"
  fi
fi

# What claude reads before it is asked anything. A session in a directory of its own would
# otherwise start knowing nothing about the cluster it is in and re-derive it, badly, every
# time. Copied rather than linked so a session can edit its own.
#
# Whether an existing one may be replaced depends on whose it is, and the two cases are
# genuinely different.
#
# A directory one conversation has to itself - an extension's tree, or a per-session directory -
# holds that conversation's copy. Editing it is a thing somebody may have done deliberately, so
# it is written once and left alone. The source tree has its own CLAUDE.md, so this is a no-op
# there.
#
# The agent's conversations share one directory, and that changes the answer. Nobody owns the
# file: it was written by whichever conversation happened to start first, and every conversation
# since has read that copy. Writing it once meant the guidance froze on the day the pod was
# created - which is exactly how an agent came to be told the Studio's API was closed to it,
# hours after it had been given a credential that opens it. So there it is refreshed every time
# a pane starts, because what it holds is the product's account of the pod rather than any one
# conversation's notes.
if [ -f /seed/session-claude.md ]; then
  REFRESH_CLAUDE_MD=no

  if [ ! -f "$WORKDIR/CLAUDE.md" ]; then
    REFRESH_CLAUDE_MD=yes
  else
    case "$WORKDIR" in
      */conversations) REFRESH_CLAUDE_MD=yes ;;
    esac
  fi

  if [ "$REFRESH_CLAUDE_MD" = yes ]; then
    cp /seed/session-claude.md "$WORKDIR/CLAUDE.md"

    if [ "$(id -u)" = 0 ]; then
      chown node:node "$WORKDIR/CLAUDE.md"
    fi
  fi
fi

# The person's Rancher credential, if this pod is the one that has one.
#
# Only the agent pod is seeded with this script, so the guard is what keeps an extension's
# terminal unchanged. It has to run before the claude login below, because that reads a Secret
# with kubectl and this writes the kubeconfig kubectl will then use - see the note there.
if [ -f /seed/rancher-credential.sh ]; then
  /bin/sh /seed/rancher-credential.sh "$HOME_DIR" || true
fi

# The shared login, before anything that would use it. Run as the node user and
# with the pane's HOME, because it writes into that user's ~/.claude and a
# root-owned credentials file is one claude cannot then refresh. It reads its Secret as the
# pod rather than as whoever opened the panel; the reason is in claude-credentials.mjs.
if [ "$(id -u)" = 0 ]; then
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env "HOME=$HOME_DIR" node /seed/claude-credentials.mjs pull || true
else
  env "HOME=$HOME_DIR" node /seed/claude-credentials.mjs pull || true
fi

# tmux does not pass this script's environment into a session it is attaching to, only into one
# it creates, so the queue file is given on the command line of the pane's own script instead.
# What the pane runs, and whether this call attaches to it at all.
#
#   claude  (default) - the assistant's pane, attached. What the Studio's
#                       assistant talks to.
#   shell             - a plain login shell, attached. The Terminal tab is a
#                       terminal: somebody opening it wants a prompt in the
#                       extension's tree, not a second view of the assistant's
#                       conversation, and typing into claude's TUI by accident
#                       is how a stray line becomes a turn.
#   start             - create the assistant's session detached and exit. The
#                       Terminal tab used to be the only thing that ever started
#                       it, so once the tab stopped running claude nothing did,
#                       and every prompt queued against a session that would
#                       never exist.
MODE=${4:-claude}

if [ "$MODE" = shell ]; then
  PANE="/bin/bash -l"
else
  # $2 is where this pane records which conversation is its own, and it is only wanted where
  # panes share a working directory - the agent panel, whose sessions directory is beside the
  # workspace. An extension's terminal has a directory to itself and passes nothing, which
  # leaves claude-session.sh on --continue.
  MC_CONVERSATION=""
  case "$WORKDIR" in
    */conversations) MC_CONVERSATION="$(dirname "$WORKDIR")/sessions/$SESSION.id" ;;
  esac

  PANE="/bin/bash /seed/claude-session.sh '$MC_QUEUE' '$MC_CONVERSATION'"
fi

if [ "$MODE" = start ]; then
  # -d, not -A: there is no terminal on this call to attach to. Idempotent all
  # the same, because a session that already exists makes this a no-op.
  if tmux has-session -t "mc-$SESSION" 2>/dev/null; then
    exit 0
  fi

  set -- tmux -f /seed/tmux.conf new-session -d -s "mc-$SESSION" -c "$WORKDIR" "$PANE"
else
  set -- tmux -f /seed/tmux.conf new-session -A -s "mc-$SESSION" -c "$WORKDIR" "$PANE"
fi

# The exec subresource runs as the container's user, which is root, whatever the
# dev server dropped itself to. Everything in the pane has to be the node user
# instead: claude refuses --dangerously-skip-permissions as root, and the files
# it edits are the ones webpack is watching, which boot.sh made node's.
# The pane's PATH has the home's own bin on the front of it, because that is where the claude
# CLI now installs itself: natively, into whichever directory outlives this pod, so that it can
# take an update and so that a restart does not reinstall it. See terminal-tools.sh.
PANE_PATH="$HOME_DIR/.local/bin:$PATH"

if [ "$(id -u)" = 0 ]; then
  exec setpriv --reuid=1000 --regid=1000 --init-groups \
    env "HOME=$HOME_DIR" "PATH=$PANE_PATH" TERM=xterm-256color "$@"
fi

exec env "HOME=$HOME_DIR" "PATH=$PANE_PATH" TERM=xterm-256color "$@"
