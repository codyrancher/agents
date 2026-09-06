#!/bin/bash
# What runs in the tmux pane: claude, in a loop.
#
# The loop is the point. If claude exits - a crash, a /quit, an update - the
# pane would die with it and take the tmux session down, so the next tab would
# come up blank instead of where you left off. Restarting keeps the session, and
# `--continue` means the restart resumes the conversation rather than opening a
# new one. A run that ends in under three seconds is treated as an error and
# backed off, so a claude that cannot start does not spin.
#
# bash rather than sh: `read` with no variable name is a bashism, and this is
# the pane's interactive shell anyway.
# The pane's own home, set by shell.sh in the tmux environment. The default is
# only for a pane started some other way.
export HOME=${HOME:-/app/.home}

# Ctrl-C at the prompt below leaves you in a shell rather than closing the pane.
# While claude is running it is claude that gets the signal, not this script, so
# this only fires where it is offered.
trap 'echo; exec /bin/bash' INT

if ! command -v claude >/dev/null 2>&1; then
  echo "[claude is not installed in this pod - see /app/.terminal-tools.log]"
  echo "[dropping to a shell]"
  exec /bin/bash
fi

# A prompt somebody queued for this conversation, used once and then gone.
#
# Read before the loop rather than inside it: it is what this conversation is
# for, and a restart of claude within the same pane should carry on rather than
# ask the same thing again. Deleted before claude runs, not after, so a claude
# that crashes on the prompt does not ask it again on every restart.
QUEUE=${1:-}
PROMPT=""

if [ -n "$QUEUE" ] && [ -f "$QUEUE" ]; then
  PROMPT=$(cat "$QUEUE")
  rm -f "$QUEUE"
fi

if [ -n "$PROMPT" ]; then
  claude --dangerously-skip-permissions "$PROMPT" || true
fi

# Which conversation belongs to this pane, when several share a directory.
#
# `--continue` resumes whatever was touched last in the working directory. That was safe while
# every pane had a directory of its own; the agent panel now puts them all in one, so that any
# pane's resume picker can see every conversation - and `--continue` would then have a pane
# adopt whichever conversation another pane touched last, on its very first start.
#
# So a pane records the conversation it opened and resumes that one by name. The id comes from
# claude's own transcripts: one .jsonl per conversation, named for it, under
# ~/.claude/projects/<working directory with slashes turned to dashes>. The file that appears
# while this pane is running is this pane's.
#
# $2 is where to keep that id. With no $2 - an extension's terminal, which still has a directory
# to itself - this falls back to --continue, which is right there.
ID_FILE=${2:-}
PROJECT_DIR="$HOME/.claude/projects/$(pwd | tr '/' '-')"

transcripts() {
  ls "$PROJECT_DIR"/*.jsonl 2>/dev/null | sort
}

BEFORE=$(mktemp)
AFTER=$(mktemp)
trap 'rm -f "$BEFORE" "$AFTER"' EXIT

# Only when exactly one transcript appeared. If another pane opened a conversation in the same
# moment there is no way to tell them apart, and no id is better than the wrong one: no id
# starts fresh, the wrong one resumes a stranger's conversation.
remember_conversation() {
  [ -n "$ID_FILE" ] || return 0

  transcripts > "$AFTER"

  new=$(comm -13 "$BEFORE" "$AFTER")

  if [ "$(printf '%s' "$new" | grep -c .)" = "1" ]; then
    basename "$new" .jsonl > "$ID_FILE"
  fi
}

while true; do
  start=$(date +%s)

  transcripts > "$BEFORE"

  CONVERSATION=""
  if [ -n "$ID_FILE" ] && [ -s "$ID_FILE" ]; then
    CONVERSATION=$(cat "$ID_FILE")
  fi

  if [ -n "$CONVERSATION" ]; then
    # This pane's own, by name. Falls through to a fresh one when it has been removed, which is
    # what resuming something no longer there should do.
    claude --dangerously-skip-permissions --resume "$CONVERSATION" 2>/dev/null ||
      claude --dangerously-skip-permissions
  elif [ -n "$ID_FILE" ]; then
    # First start in a shared directory: open a new conversation rather than adopt one.
    claude --dangerously-skip-permissions
  else
    # --continue fails when the directory has no conversation yet, which is the
    # only reason for the fallback.
    claude --dangerously-skip-permissions --continue 2>/dev/null ||
      claude --dangerously-skip-permissions
  fi

  remember_conversation

  end=$(date +%s)

  if [ $((end - start)) -lt 3 ]; then
    echo ""
    echo "[claude exited immediately, which usually means an error. Waiting 5s.]"
    sleep 5
  fi

  echo ""
  echo "[claude exited - press Enter to restart, Ctrl-C for a shell]"
  read -r || exec /bin/bash
done
