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

FAILS=0

while true; do
  start=$(date +%s)

  # Adopt the latest shared login before (re)starting. claude reads its token once, at startup,
  # so a restart is how this pane takes on a login done in another conversation - the sync
  # (claude-credentials.mjs) stops claude here when a newer one arrives, and this is what makes
  # the pane that comes back up hold it.
  node /seed/claude-credentials.mjs pull >/dev/null 2>&1 || true

  transcripts > "$BEFORE"

  # Record which transcript this is as soon as claude has made one, not only when it exits:
  # a pane that dies with its pod (the usual way one ends) never reaches remember_conversation,
  # and the next start would open a new conversation instead of picking this one up.
  if [ -n "$ID_FILE" ] && [ ! -s "$ID_FILE" ]; then
    (
      for _ in $(seq 1 150); do
        sleep 2
        new=$(comm -13 "$BEFORE" <(transcripts) 2>/dev/null)
        if [ "$(printf '%s' "$new" | grep -c .)" = "1" ]; then
          basename "$new" .jsonl > "$ID_FILE"
          break
        fi
      done
    ) &
  fi

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

  # A newer shared login landed while this pane was running: the sync (claude-credentials.mjs)
  # asked for a reconnection and stopped claude to get one. Go straight back - the top of the
  # loop has already pulled the new token - without the pause below, which is for a person.
  if [ -n "$MC_RESTART_FLAG" ] && [ -f "$MC_RESTART_FLAG" ]; then
    rm -f "$MC_RESTART_FLAG"
    echo ""
    echo "[a newer login arrived - reconnecting this conversation]"
    continue
  fi

  # A conversation is the pane, so a claude that stopped is one to bring back on its own rather
  # than one to wait at a prompt for: having to press Enter to get your conversation back, and
  # then resume it by hand, is the thing this loop exists to prevent. It restarts and the top of
  # the loop resumes, so the pane returns to where it was without a keystroke.
  #
  # The exception is a claude that cannot stay up. Several starts that each died within a few
  # seconds is a claude that is broken, not one that was exited, and restarting that is a spin -
  # so after a run of them, and only then, the pane waits at a prompt where it can be dropped to
  # a shell instead of churning. A start that lasted resets the count.
  if [ $((end - start)) -lt 10 ]; then
    FAILS=$((FAILS + 1))
  else
    FAILS=0
  fi

  if [ "$FAILS" -ge 3 ]; then
    FAILS=0
    echo ""
    echo "[claude keeps exiting immediately, which usually means an error.]"
    echo "[press Enter to try again, Ctrl-C for a shell]"
    read -r || exec /bin/bash
  else
    echo ""
    echo "[claude exited - restarting, Ctrl-C for a shell]"
    # A short pause so a person who wanted out has a window for Ctrl-C (the trap drops to a
    # shell), and so a claude failing just over the ten-second mark cannot spin at full speed.
    sleep 2
  fi
done
