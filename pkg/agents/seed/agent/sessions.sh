#!/bin/sh
# The conversations this pod is holding: list them, start one, rename one, end one.
#
# One script for four verbs, because all four rest on one fact that is easy to get wrong in four
# different ways: a conversation IS a directory under /workspace/sessions. Not a tmux session.
# tmux is where a conversation is currently *running*, and that is a different set - it is empty
# for the first minute after this pod restarts, while every conversation is still there on the
# hostPath with its transcript and its name intact, waiting to be reattached.
#
# Listing tmux instead was the first version and it had two bugs in it. Every conversation
# vanished from the strip when the pod rolled. And `new` could hand back a name whose directory
# still existed, so pressing + dropped you into somebody's finished conversation, because
# `tmux new-session -A` attaches to what is there - exactly right for reopening a tab and
# exactly wrong for asking for a new one.
#
# Run as the node user. A tmux server is per user and shell.sh starts every session as that
# user, so `kill-session` run as root would report no such session; and everything written here
# has to be writable by the pane that reads it.
set -e

if [ "$(id -u)" = 0 ]; then
  exec setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh /seed/sessions.sh "$@"
fi

SESSIONS=/workspace/sessions

# Where the conversations actually run, which is one directory for all of them - see the note in
# agent.ts. Spelled here as well because this script has to build the path claude keeps a
# transcript under, and that path is the working directory with its slashes turned into dashes.
WORKDIR=/workspace/conversations

# The pane's home, spelled out rather than read from $HOME.
#
# This script arrives as root through the exec subresource, and `setpriv` changes the user
# without changing the environment - so $HOME is still /root on the other side of the re-exec
# above, and everything below would look for the panes' claude state in root's home. The first
# version did exactly that and `end` failed with "cannot remove /root/.claude/projects/...",
# after it had already removed the conversation's own directory.
AGENT_HOME=/workspace/.home

VERB=${1:-list}
ID=$2

# A conversation belongs either to the drawer or to one project, and the two never mix.
#
# The drawer's conversations are `agent-<n>`. A project's are `p-<project>-<n>`, held in the
# same directory and run by the same panes, but listed only when that project is asked for -
# and never by the drawer, which asks with no project and gets only its own. That is what keeps
# a workspace's conversations out of the terminal strip: not a filter in the browser, which a
# second caller would have to know to apply, but the list itself, which answers one question.
#
# `list` and `new` take the project as their second argument. `end` and `rename` take an id,
# which already says which it is.
PROJECT=''

case "$VERB" in
  list|new) PROJECT=$2; ID='' ;;
esac

case "$PROJECT" in
  '') ;;
  *[!a-z0-9-]*|-*|*-)
    echo "not a project name: $PROJECT" >&2
    exit 2
    ;;
esac

if [ -n "$PROJECT" ]; then
  PREFIX="p-$PROJECT-"
else
  PREFIX="agent-"
fi

mkdir -p "$SESSIONS"

# An id names a directory, so it is checked rather than trusted. Everything that reaches here
# was made by `new` below, but the check is what keeps that true when something else calls it.
case "$ID" in
  '') ;;
  -*|*[!a-zA-Z0-9-]*)
    echo "not a session id: $ID" >&2
    exit 2
    ;;
esac

# What a person called this conversation, or the ordinal it was given.
#
# The name lives in the conversation's own directory rather than in the browser, for the same
# reason the list does: a second browser tab has to see the same names, and a reload must not
# lose them. Beside the transcript rather than as the tmux session name, because the id names
# the directory, the tmux session AND the exec URL a pane opens - renaming it would mean the
# pane could no longer reattach to the conversation it is showing.
# What claude called this conversation, if it has called it anything yet.
#
# It writes a line of its own into the transcript once it has enough to name it - the same title
# its resume picker lists - so the tab can say what the conversation is about rather than which
# number it was. The last one wins: claude renames a conversation as it goes.
#
#   {"type":"ai-title","aiTitle":"Extension pods count and arithmetic","sessionId":"..."}
#
# Read with grep and sed rather than a JSON parser because this runs in a pod that is only
# guaranteed a shell, and because a wrong answer here costs a tab label rather than anything
# that matters.
ai_title_of() {
  [ -f "$SESSIONS/$1.id" ] || return 0

  conversation=$(cat "$SESSIONS/$1.id" 2>/dev/null)
  [ -n "$conversation" ] || return 0

  transcript="$AGENT_HOME/.claude/projects/$(printf '%s' "$WORKDIR" | tr '/' '-')/$conversation.jsonl"
  [ -f "$transcript" ] || return 0

  grep '"type":"ai-title"' "$transcript" 2>/dev/null |
    tail -1 |
    sed -n 's/.*"aiTitle":"\([^"]*\)".*/\1/p' |
    tr -d '\000-\037' |
    cut -c1-200
}

# A name somebody typed, then the one claude gave it, then the ordinal.
#
# Manual first on purpose: renaming a tab is somebody saying what they want it called, and
# having claude overwrite that a minute later because the conversation moved on would make the
# rename look broken.
title_of() {
  found=''

  if [ -f "$SESSIONS/$1/.title" ]; then
    found=$(tr -d '\000-\037' < "$SESSIONS/$1/.title" | cut -c1-200)
  fi

  [ -n "$found" ] || found=$(ai_title_of "$1")

  # Ordinal, which is what the id ends in whichever kind it is, so a conversation nobody has
  # named still has a short label rather than a blank tab.
  [ -n "$found" ] || found=${1##*-}

  printf '%s' "$found"
}

case "$VERB" in
  list)
    for dir in "$SESSIONS"/"$PREFIX"*/; do
      [ -d "$dir" ] || continue

      id=$(basename "$dir")

      # The prefix is a glob, and a glob for project `foo` also matches project `foo-bar`, so
      # what follows the prefix has to be nothing but the ordinal.
      case "${id#"$PREFIX"}" in
        ''|*[!0-9]*) continue ;;
      esac

      # Tab separated, one line each, because a title may contain spaces and an id may not.
      printf '%s\t%s\n' "$id" "$(title_of "$id")"
    done
    ;;

  new)
    # Allocated here, with mkdir, and that is the whole point of this verb. Counting the tabs in
    # the browser picks a name that another browser tab may be picking at the same moment, and
    # picking one whose directory already exists reopens a finished conversation. mkdir is the
    # only thing on this side that is both a question and an answer: it fails if the name is
    # taken, and taking it is what creating it means.
    n=1

    while [ "$n" -lt 1000 ]; do
      id="$PREFIX$n"

      if mkdir "$SESSIONS/$id" 2>/dev/null; then
        printf '%s\n' "$id"
        exit 0
      fi

      n=$((n + 1))
    done

    echo "there are already a thousand conversations in $SESSIONS" >&2
    exit 1
    ;;

  end)
    [ -n "$ID" ] || { echo "end needs a session id" >&2; exit 2; }

    tmux kill-session -t "mc-$ID" 2>/dev/null || true

    # The directory as well as the session, because the directory is what `new` allocates
    # against. Left behind it would be a name that can never be reused and a conversation that
    # comes back from the dead the next time that name is handed out.
    rm -rf "$SESSIONS/$ID"

    # The transcript is deliberately left alone.
    #
    # Every conversation now runs in one shared directory so that any pane's resume picker can
    # see all of them, which means claude keeps every transcript in one place - and removing
    # "this conversation's" transcripts would mean removing the lot. The pane's own id is
    # recorded beside it and could single one out, but a conversation somebody closed a tab on
    # is exactly the one they are most likely to want back, and the resume picker is now how
    # they get it.
    rm -f "$SESSIONS/$ID.id"

    # What is deliberately NOT removed is this conversation's entry in ~/.claude.json, which
    # holds the prompts somebody typed into it and would put them in the next pane's up-arrow.
    # Taking it out means a read-modify-write of a file every running pane is also writing, and
    # losing somebody else's trust flags to a race is worse than a stale line of history.
    ;;

  rename)
    [ -n "$ID" ] || { echo "rename needs a session id" >&2; exit 2; }
    [ -d "$SESSIONS/$ID" ] || { echo "there is no conversation called $ID" >&2; exit 1; }

    # $3 is argv rather than shell. The exec subresource passes each argument as its own
    # parameter, so a title with a space, a quote or a semicolon in it arrives here whole and is
    # never parsed by anything. Control characters go because `list` is one line per
    # conversation, and the length is capped because a tab is not a paragraph.
    printf '%s' "$3" | tr -d '\000-\037' | cut -c1-200 > "$SESSIONS/$ID/.title"
    ;;

  *)
    echo "unknown verb: $VERB (list [project], new [project], end ID, rename ID TITLE)" >&2
    exit 2
    ;;
esac

exit 0
