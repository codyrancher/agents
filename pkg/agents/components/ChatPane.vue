<script>
// The chat view of a pane: the same tmux session as the terminal, drawn as messages.
//
// Claude Code's own UI is a terminal one, and it is the one the agent runs in: the login, the
// permission prompts, the questions it asks, the surveys, all of it happens there and needs no
// OAuth of its own. This view does not replace that; it reads it. The transcript claude writes
// is what the messages come from, the pane's last lines are what the prompts come from, and
// what a person types or clicks here goes into the pane as keystrokes. Switching between this
// and the terminal (PodTerminal's toggle) changes nothing about the session.
//
// Reaching the pane: the same way the terminal does. The pane's argv says where it runs - in
// the pod this component is pointed at, or, when it starts with `kubectl exec`, in another pod
// that pod reaches - and every read and write here is a short exec along the same path.
import {
  parseTranscript, renderMarkdown, renderPlain, linkPaths, readPane, toolSummary, projectKey, agentsFrom
} from '../chat';
import { deriveState, parseEntries, sentSeen } from '../chat-state.mjs';
import {
  modelAliases, flagChoices, parseMcpList, currentModel, isSafeOptionValue
} from '../chat-options';
import { podExecOnce, statPodPath, readPodFileBase64 } from '../pod';
import { agentPod, sessionCommand } from '../agent';
import PodFileViewer from './PodFileViewer.vue';


const THUMB_MAX = 400_000;
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
};

function escapeText(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Claude Code's interactive managers: commands that open a full-screen picker rather than
 * answering in the conversation.
 *
 * The chat cannot draw any of these, so sending one is the one thing this view does that leaves
 * the pane in a state it has to hand to the terminal. Listed because knowing *what was sent* is
 * the only reliable way to know that has happened - the pane's own shape cannot be told apart
 * from an ordinary finished turn, which is the mistake the warning above used to make.
 */
const MANAGER_COMMANDS = ['mcp', 'permissions', 'hooks', 'memory', 'agents', 'model', 'config', 'resume', 'vim'];

/** The manager a message opens, if it opens one: `/mcp`, `/mcp something`, and nothing else. */
function managerIn(text) {
  const match = /^\/([a-z-]+)\b/.exec(String(text || '').trim());

  return match && MANAGER_COMMANDS.includes(match[1]) ? match[1] : '';
}

/**
 * Where queued messages are kept between visits.
 *
 * They used to live only in this component's data, which meant they survived exactly as long as
 * the component did: switching conversation or leaving the page unmounts it, and coming back
 * showed a log with the message gone - while the terminal, reading the same pane, still had it
 * in claude's input queue. So the one view that promised "this is waiting" was the one that
 * forgot.
 *
 * Per pane, because a queue belongs to the conversation it was typed into. localStorage can
 * throw outright in a private window or with site data blocked, so every read and write is
 * guarded and an unavailable one simply means the old behaviour.
 */
/**
 * Slash commands that answer in the terminal and nowhere else.
 *
 * `/model` writes what it did into the transcript as a local-command line, and the chat shows
 * that as a note. `/cost`, `/usage`, `/status` and the rest print to the pane only - the
 * transcript has no record they were even typed - so after sending one of these the chat reads
 * what the pane printed and shows that instead. A person asking what this session cost gets
 * the same answer in either view.
 */
const TERMINAL_ONLY = ['cost', 'usage', 'status', 'context', 'doctor', 'help', 'todos', 'release-notes', 'version'];

function terminalOnly(text) {
  const match = /^\/([a-z-]+)\b/.exec(String(text || '').trim());

  return !!match && TERMINAL_ONLY.includes(match[1]);
}

/** Appearance preferences: what they are, and what a fresh browser gets. */
const LOOK_KEY = 'mc-chat.look';
const LOOK_DEFAULTS = {
  size:     'medium', // small | medium | large
  density:  'comfortable', // compact | comfortable
  bubbles:  true, // user messages in a bubble, or flat like the rest
  thoughts: false, // thinking rows open by default
  toolIo:   false, // tool rows open by default
  times:    true, // timestamps on messages
};

function readLook() {
  try {
    return { ...LOOK_DEFAULTS, ...JSON.parse(localStorage.getItem(LOOK_KEY) || '{}') };
  } catch {
    return { ...LOOK_DEFAULTS };
  }
}

const PENDING_KEY = 'mc-chat.pending';

function readPending(paneId) {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');

    return Array.isArray(all[paneId]) ? all[paneId] : [];
  } catch {
    return [];
  }
}

function writePending(paneId, list) {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');

    if (list.length) {
      all[paneId] = list;
    } else {
      delete all[paneId];
    }
    localStorage.setItem(PENDING_KEY, JSON.stringify(all));
  } catch {
    // A browser that will not remember is not a view that fails.
  }
}

const POLL_MS = 1500;
const CHUNK = 3000;

/**
 * Claude Code's own slash commands, for the ones that are not files anywhere.
 *
 * The custom half of the list is read out of the pod, which is authoritative: a project's
 * commands and skills are files, and files can be listed. The built-in half cannot be - claude
 * knows them, the filesystem does not - so it is written here, and that is why an unrecognised
 * command is reported as "not one I know of" and never as invalid, and never blocks sending.
 * This list going stale must cost a hint, not a message.
 */
const BUILTIN_COMMANDS = [
  ['/add-dir', 'Add another working directory'],
  ['/agents', 'Manage agent configurations'],
  ['/clear', 'Clear the conversation history'],
  ['/compact', 'Summarise the conversation so far'],
  ['/config', 'Open the config panel'],
  ['/context', 'Show what is in the context window'],
  ['/cost', 'Token usage for this session'],
  ['/doctor', 'Check the installation'],
  ['/exit', 'Leave'],
  ['/export', 'Export the conversation'],
  ['/help', 'List the commands claude actually has'],
  ['/hooks', 'Configure hooks'],
  ['/init', 'Write a CLAUDE.md for this repository'],
  ['/login', 'Sign in'],
  ['/logout', 'Sign out'],
  ['/mcp', 'MCP servers and their tools'],
  ['/memory', 'Edit the memory files'],
  ['/model', 'Choose the model'],
  ['/permissions', 'Edit tool permissions'],
  ['/resume', 'Resume an earlier conversation'],
  ['/review', 'Review a pull request'],
  ['/rewind', 'Go back to an earlier point'],
  ['/status', 'Version, account and connectivity'],
  ['/todos', 'The current todo list'],
  ['/usage', 'Plan usage limits'],
  ['/vim', 'Toggle vim mode'],
].map(([name, help]) => ({ name, help, source: 'built-in' }));

/**
 * The template's view of the state: the same four things it always drew, decided by
 * chat-state.mjs rather than by the look of the terminal.
 */
function paneFromState(state, paneText = '') {
  const gone = state.phase === 'gone' || state.phase === 'absent';
  let dialog = null;

  if (state.phase === 'question' && state.question) {
    const q = state.question;
    const first = q.questions[0] || {};
    const options = q.tool === 'ExitPlanMode'
      ? [{ key: '1', label: 'Yes, proceed', selected: false }, { key: '2', label: 'No, keep planning', selected: false }]
      : (first.options || []).map((o, i) => ({
        key: String(i + 1), label: o.label || `option ${ i + 1 }`, description: o.description || '', selected: false,
      }));

    dialog = {
      kind:    'options',
      header:  q.tool === 'ExitPlanMode' ? 'Plan ready' : (first.header || ''),
      prompt:  q.tool === 'ExitPlanMode' ? q.plan.slice(0, 4000) : String(first.question || ''),
      options,
      url:     '',
    };
  } else if (state.phase === 'login' && state.login) {
    dialog = {
      kind: state.login.kind, prompt: 'Claude needs you to sign in.', options: [], url: state.login.url,
    };
  } else if (state.phase === 'waiting') {
    // claude said it is waiting (the Notification hook) but the transcript has not written the
    // question yet - it can lag the prompt by minutes. The question is on the screen, though,
    // and the pane reader knows the shape of a numbered list with the current choice marked;
    // its options are the same keystrokes, so the buttons work the same. This is the one place
    // the terminal's look is read for structure, and only while claude itself says to.
    const seen = readPane(paneText);

    if (seen.dialog && seen.dialog.options.length) {
      dialog = { ...seen.dialog, header: '' };
    }
  }

  return {
    busy: state.phase === 'working', idle: state.phase === 'idle', gone, dialog, status: state.status || '',
  };
}

function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export default {
  name: 'ChatPane',

  components: { PodFileViewer },

  props: {
    session:   { type: String, default: 'agent-1' },
    mode:      { type: String, default: 'claude' },
    command:   { type: Array, default: null },
    findPod:   { type: Function, default: null },
    namespace: { type: String, required: true },
    container: { type: String, required: true },
    imageDir:  { type: String, default: '/workspace/.images' },
    home:      { type: String, default: '/workspace/.home' },
    label:     { type: String, default: 'the agent' },
  },

  emits: ['state', 'view'],

  data() {
    return {
      messages:    [],
      lines:       [],
      remainder:   '',
      offset:      0,
      file:        '',
      pane:        {
        busy: false, idle: false, dialog: null, gone: false, status: '',
      },
      /**
       * What the conversation is doing, decided from claude's own record rather than from the
       * look of its terminal: see chat-state.mjs, which is also what the verifier runs. `pane`
       * above is derived from it for the template.
       */
      entries:     [],
      hook:        null,
      alive:       false,
      state:       { phase: 'absent', status: '', queue: [], question: null, login: null, model: '', effort: '', cost: null },
      paneText:    '',
      draft:       '',
      code:        '',
      sending:     false,
      polling:     false,
      timer:       null,
      error:       '',
      pasting:     '',
      openTools:   {},
      openThoughts: {},
      stuck:       false,
      attached:    false,
      // Paths in the log: thumbnails fetched from the pod (path -> data URL, or 'missing'),
      // the one open in the viewer, and where the viewer reads from.
      thumbs:      {},
      viewerPath:  '',
      /** An image from the transcript itself (a screenshot a tool returned), open large. */
      viewerData:  '',
      /** What the terminal printed for a command the transcript does not record (see TERMINAL_ONLY). */
      echoes:      [],
      /** When the last poll came back, as ISO: a stalled poll is a view that stopped being true. */
      polledAt:    '',
      /**
       * The "Mention file" picker: the checkout's files, read once per opening, and the filter.
       * What it inserts is `@path`, which claude resolves at submit the way typing it would.
       */
      files:       { open: false, list: [], filter: '', loading: false },
      /** Whether claude thinks before answering: the alwaysThinkingEnabled setting in the pane's home. */
      thinking:    null,
      /**
       * How the log looks, kept per browser. Every one of these is a class on the root and
       * nothing else, so a preference is a line of CSS rather than a branch in the template.
       */
      look:        readLook(),
      media:       null,
      notice:      '',
      noticeTimer: null,
      hydrating:   false,
      // Which conversation is shown: the main one, or one of the subagents it launched (by
      // agent id), whose transcript is followed the same way with an offset of its own.
      view:        'main',
      sub:         {
        offset: 0, lines: [], remainder: '', messages: [],
      },
      atBottom:    true,
      mineIndex:   -1,
      openSummaries: {},
      // The subagents' last words and when they last wrote, read on every poll; and whether
      // the list of them is open.
      tails:       {},
      showAgents:  false,
      /**
       * What has been sent from this box and is not in the transcript yet.
       *
       * Everything in the log comes from the transcript claude writes, and claude writes a user
       * turn when it *starts* on it. So a message sent while it is working goes into its input
       * queue and is written minutes later, or not until the current turn ends - and until then
       * this view had cleared the box and shown nothing anywhere, which reads as the message
       * having been dropped. These are held here and drawn at the end of the log, marked as
       * queued, until the transcript catches up with them (see prunePending).
       */
      pending:     [],
      // The commands this pane can be sent, and which one the typeahead has highlighted.
      // Read once from the pod (see readCommands) and merged with the built-in list.
      custom:      [],
      slashIndex:  0,
      slashDismissed: false,
      /**
       * What claude here can be set to, read from claude rather than listed in this file.
       *
       * The menus offer the model, the effort level, the permission mode and the MCP servers -
       * the things Claude Code's own UI changes mid-conversation. The values come out of
       * `claude --help` in the pod (see chat-options.ts) because claude updates itself on its
       * own schedule inside that pod, and a model alias written down in this component is
       * wrong the first time a new one ships.
       */
      options:     {
        read: false, models: [], efforts: [], model: '', modelSource: '', effort: '',
      },
      mcp:         {
        read: false, loading: false, servers: [], error: '',
      },
      // Which menu is open, and which one is mid-apply.
      menu:        '',
      optionBusy:  '',
      focused:     false,
      // A touch screen, which is the only place the caret keys below are worth the room.
      coarse:      typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches,
      /**
       * The interactive command this view last put into the pane, while its picker is still up.
       *
       * Set when one is sent and cleared the moment the conversation moves on - see
       * `prunePending`'s neighbour, `clearManager`. It exists so `takenOver` is something known
       * rather than something inferred.
       */
      manager:     '',
      /**
       * Images being written into the pod, whose paths are already in the box.
       *
       * Pasting puts the path in immediately and uploads behind it, so this is the only thing
       * that still has to be waited for - and only at Send, and only if it has not finished by
       * then. Typing the rest of the message usually outlasts the upload.
       */
      uploads:     [],
    };
  },

  computed: {
    /** The pane's argv, and what it says about where the pane is. */
    argv() {
      return this.command?.length ? this.command : sessionCommand(this.session, this.mode);
    },

    shellAt() {
      return this.argv.indexOf('/seed/shell.sh');
    },

    paneId() {
      return this.shellAt >= 0 ? this.argv[this.shellAt + 1] : this.session;
    },

    workdir() {
      return (this.shellAt >= 0 && this.argv[this.shellAt + 2]) || '/workspace/conversations';
    },

    paneHome() {
      return (this.shellAt >= 0 && this.argv[this.shellAt + 3]) || this.home;
    },

    /**
     * Everything up to the `--` of a `kubectl exec`, without the TTY flags, when the pane is in
     * another pod. The kubectl may be wrapped (a shell that sets PATH first, say); what marks it
     * is `kubectl` followed by `exec` somewhere before the `--`.
     */
    prefix() {
      const dash = this.argv.indexOf('--');
      const k = this.argv.findIndex((arg, i) => arg === 'kubectl' && this.argv[i + 1] === 'exec');

      if (k < 0 || dash < k) {
        return [];
      }

      return this.argv.slice(0, dash + 1).filter((arg) => arg !== '-t' && arg !== '-i' && arg !== '-it' && arg !== '-ti');
    },

    /** The subagents this conversation launched, for the tabs. */
    agents() {
      return agentsFrom(this.messages);
    },

    shown() {
      if (this.view !== 'main') {
        return this.sub.messages;
      }

      // Only on the main conversation: a message typed here goes to claude, never to one of
      // the subagents whose transcript the tabs show.
      const queued = (this.state.queue || []).map((text, i) => ({
        key: `queue-${ i }-${ text.slice(0, 24) }`, role: 'user', text, tools: [], thinking: '', images: [], at: '', queued: true, inQueue: true,
      }));

      const extra = [...this.echoes, ...queued, ...this.pending];

      return extra.length ? [...this.messages, ...extra] : this.messages;
    },

    /** The subagents with what each last said, the ones still writing first. */
    agentRows() {
      const now = Date.now() / 1000;

      return this.agents.map((a) => {
        const tail = this.tails[a.id] || {};
        const working = !!tail.at && now - tail.at < 45;

        return {
          ...a, working, last: tail.last || '', when: tail.at ? this.when(new Date(tail.at * 1000).toISOString()) : '',
        };
      }).sort((x, y) => Number(y.working) - Number(x.working));
    },

    workingAgents() {
      return this.agentRows.filter((a) => a.working).length;
    },

    rendered() {
      return this.shown.map((m) => ({
        ...m,
        html:      m.role === 'user' ? renderPlain(m.text) : linkPaths(renderMarkdown(m.text)),
        queued:    !!m.queued,
        inQueue:   !!m.inQueue,
        failed:    !!m.failed,
        toolRows:  m.tools.map((t) => ({
          ...t, summary: toolSummary(t), summaryHtml: linkPaths(escapeText(toolSummary(t))),
        })),
      }));
    },

    /**
     * The Customize section of the command menu.
     *
     * The VS Code extension's `/` menu has one, and what is in it is "MCP servers, slash
     * commands, output styles, hooks, memory, permissions and plugins" - claude's own pickers,
     * reached from the command menu rather than from buttons on the prompt box. Only the ones
     * this pane can actually open are listed: each is a slash command typed into the pane, and
     * its dialog comes back through the path this view already draws options for.
     */
    customize() {
      return [
        { command: 'mcp', help: 'MCP servers' },
        { command: 'permissions', help: 'tool permissions' },
        { command: 'hooks', help: 'hooks' },
        { command: 'memory', help: 'the memory files' },
        { command: 'agents', help: 'subagent definitions' },
      ];
    },

    /** Every command that could be typed here: claude's own, then this pod's own. */
    commands() {
      return [...BUILTIN_COMMANDS, ...this.custom];
    },

    /**
     * The command being typed, if one is.
     *
     * Only when the slash opens the message, and only up to the first space: `/my-pr-review 42`
     * is a command with an argument, and the argument is not part of the name. Everything else
     * a message can contain - a path, a URL, a line of code - has a slash in it that is not in
     * the first column, which is what keeps this out of the way of ordinary typing.
     */
    slashTyped() {
      const match = /^\/([a-zA-Z0-9_:-]*)(\s?)/.exec(this.draft);

      return match ? { name: `/${ match[1] }`, complete: !!match[2] } : null;
    },

    slashMatches() {
      if (!this.slashTyped) {
        return [];
      }
      const typed = this.slashTyped.name.toLowerCase();

      return this.commands
        .filter((c) => c.name.toLowerCase().startsWith(typed))
        .slice(0, 8);
    },

    /** The menu is open while a name is still being typed and there is something to offer. */
    slashOpen() {
      return !!this.slashTyped && !this.slashTyped.complete && !this.slashDismissed && this.slashMatches.length > 0;
    },

    /**
     * What the composer says about the command that has been typed.
     *
     * Three states and not two. `unknown` is deliberately not called invalid: the built-in half
     * of the list is written down rather than read, so a command claude has and this does not
     * know about lands here, and the message still sends.
     */
    slashState() {
      if (!this.slashTyped || this.slashTyped.name === '/') {
        return '';
      }

      const found = this.commands.find((c) => c.name.toLowerCase() === this.slashTyped.name.toLowerCase());

      if (found) {
        return 'known';
      }

      return this.slashTyped.complete || !this.slashMatches.length ? 'unknown' : 'partial';
    },

    slashHint() {
      if (this.slashState === 'known') {
        const found = this.commands.find((c) => c.name.toLowerCase() === this.slashTyped.name.toLowerCase());

        return `${ found.name } — ${ found.help }`;
      }

      if (this.slashState === 'unknown') {
        return `${ this.slashTyped.name } is not a command this knows about. It will be sent as typed.`;
      }

      return '';
    },

    canSend() {
      return !!this.draft.trim() && !this.sending;
    },

    fileMatches() {
      const q = this.files.filter.trim().toLowerCase();
      const list = q ? this.files.list.filter((f) => f.toLowerCase().includes(q)) : this.files.list;

      return list.slice(0, 40);
    },

    lookToggles() {
      return [
        { key: 'bubbles', label: 'Your messages in a bubble' },
        { key: 'thoughts', label: 'Thinking open by default' },
        { key: 'toolIo', label: 'Tool input and output open by default' },
        { key: 'times', label: 'Show times' },
      ];
    },

    working() {
      return this.pane.busy;
    },

    /**
     * The pane is showing a full-screen picker this view cannot draw.
     *
     * Known positively, from what was sent, and NOT inferred from the pane's shape. The first
     * version of this asked "not busy, not idle, no dialog, not gone" - which sounds like a
     * description of a takeover and is really a description of everything readPane does not
     * classify. readPane recognises four shapes: a login, a numbered list, a yes/no, and a bare
     * prompt. A finished turn whose last line is claude's own status - `Cooked for 10m 11s ·
     * done` - is none of them: not busy, because it says done, and not idle, because the prompt
     * row is not empty. So the warning fired on ordinary completed work, repeatedly, and told
     * the person their conversation was broken when it was not.
     *
     * The commands below are claude's interactive managers; sending one is the only way this
     * view can put the pane into a state it cannot render, and we know when we have. That makes
     * this a fact rather than a guess, and it cannot fire on output.
     */
    takenOver() {
      return this.attached && !!this.manager && !this.pane.dialog && !this.pane.gone;
    },

    /** The last few lines of it, so what has taken the pane over is at least legible. */
    paneTail() {
      return this.paneText.split('\n').filter((l) => l.trim()).slice(-6).join('\n');
    },
  },

  watch: {
    // Written on every change rather than at the point of sending: a message is also removed
    // when the transcript catches up with it, and a store that only ever grew would resurrect
    // retired messages on the next visit.
    pending: {
      handler(list) {
        writePending(this.paneId, list);
      },
      deep: true,
    },

    // A new name being typed starts the menu at the top again, and un-dismisses it: Escape
    // hides the menu for the command being typed, not for the rest of the session.
    draft(now, before) {
      this.slashIndex = 0;
      if (!now.startsWith('/') || now.slice(0, 1) !== before.slice(0, 1)) {
        this.slashDismissed = false;
      }
    },
  },

  mounted() {
    // Anything typed into this pane and not yet recorded, from a previous visit.
    this.poll();
    this.readCommands();
    this.readOptions();
    this.readThinking();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  },

  updated() {
    this.hydrate();
  },

  beforeUnmount() {
    clearInterval(this.timer);
    clearTimeout(this.noticeTimer);
  },

  methods: {
    async locatePod() {
      try {
        return this.findPod ? await this.findPod() : await agentPod();
      } catch {
        return null;
      }
    },

    /**
     * Run a script where the pane runs, as the pane's user, with its home. The script travels
     * base64 in one argument, so nothing in it is ever quoted for a shell.
     */
    async run(script, timeoutMs = 20000) {
      const pod = await this.locatePod();

      if (!pod) {
        throw new Error('no running pod');
      }
      const file = `/tmp/.chat-${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 7) }.sh`;
      const wrapped = `export HOME=${ this.paneHome }; export PATH=$HOME/.local/bin:$PATH; ${ script }`;
      const inner = `echo ${ b64(wrapped) } | base64 -d > ${ file } && chmod 755 ${ file } && if [ "$(id -u)" = 0 ]; then su node -s /bin/bash -c "/bin/bash ${ file }" 2>&1; else /bin/bash ${ file } 2>&1; fi; rm -f ${ file }`;

      return podExecOnce(pod, [...this.prefix, '/bin/sh', '-c', inner], timeoutMs, this.container, this.namespace);
    },

    /** The transcript since last time, and the pane's last lines, in one round trip. */
    async poll() {
      if (this.polling || document.hidden) {
        return;
      }
      this.polling = true;
      try {
        const sub = this.view === 'main' ? '' : this.view;
        const out = await this.run([
          // CAP bounds the FIRST read of a transcript. A conversation that has run for hours has
          // a transcript of many megabytes, and shipping the whole of it through one exec (base64
          // over the WebSocket, inside the poll's timeout) does not arrive - so the @@DATA block
          // never lands whole, parseTranscript sees nothing, and the chat sits on "Nothing has
          // been said yet." even though the pane (read separately, below) is full. So on the
          // first read (OFF is 0) only the last CAP bytes are taken: the recent history, which is
          // what the view is for, small enough to arrive every time. A partial first line from
          // cutting mid-file is dropped by parseTranscript, and the browser sets its offset to
          // the true size, so every read after this one is just the delta.
          `ID=${ JSON.stringify(this.paneId) }; OFF=${ this.offset }; SUB=${ JSON.stringify(sub) }; SOFF=${ this.sub.offset }; CAP=1048576`,
          `PROJ="$HOME/.claude/projects/${ projectKey(this.workdir) }"`,
          'uuid=$(cat "$(dirname "$HOME")/sessions/$ID.id" 2>/dev/null)',
          'FILE=""',
          // Without an id file, fall back to the directory's transcript only when there is
          // exactly one. Conversations share a working directory - every conversation of a
          // workspace runs in its checkout - so "the newest transcript" was somebody else's
          // for the seconds before a new conversation's id file landed, and the chat opened on
          // eighteen messages that were not this conversation's.
          'if [ -n "$uuid" ] && [ -f "$PROJ/$uuid.jsonl" ]; then FILE="$PROJ/$uuid.jsonl"; elif [ "$(ls "$PROJ"/*.jsonl 2>/dev/null | wc -l)" -eq 1 ]; then FILE=$(ls "$PROJ"/*.jsonl 2>/dev/null | head -1); fi',
          'echo "@@FILE $FILE"',
          'if [ -n "$FILE" ] && [ -f "$FILE" ]; then size=$(wc -c < "$FILE"); echo "@@SIZE $size"; FROM=$OFF; if [ "$OFF" -eq 0 ] && [ "$size" -gt "$CAP" ]; then FROM=$((size - CAP)); fi; if [ "$size" -gt "$FROM" ]; then echo "@@DATA"; tail -c +$((FROM+1)) "$FILE"; echo; echo "@@ENDDATA"; fi; fi',
          // The subagent's transcript sits beside the session's, in a directory named for it. Capped the same way.
          'if [ -n "$SUB" ] && [ -n "$FILE" ]; then SF="${FILE%.jsonl}/subagents/agent-$SUB.jsonl"; if [ -f "$SF" ]; then ssize=$(wc -c < "$SF"); echo "@@SSIZE $ssize"; SFROM=$SOFF; if [ "$SOFF" -eq 0 ] && [ "$ssize" -gt "$CAP" ]; then SFROM=$((ssize - CAP)); fi; if [ "$ssize" -gt "$SFROM" ]; then echo "@@SDATA"; tail -c +$((SFROM+1)) "$SF"; echo; echo "@@SENDDATA"; fi; fi; fi',
          // Every subagent's last line and when it was written, for the list of them.
          'if [ -n "$FILE" ] && [ -d "${FILE%.jsonl}/subagents" ]; then for f in "${FILE%.jsonl}"/subagents/agent-*.jsonl; do [ -f "$f" ] || continue; id=$(basename "$f" .jsonl); id=${id#agent-}; echo "@@TAIL $id $(stat -c %Y "$f")"; tail -c 6000 "$f" | grep "\"type\":\"assistant\"" | tail -n 1 | cut -c1-3000; done; echo "@@ENDTAILS"; fi',
          // The hook state file (seed/chat-hook.mjs): the last thing claude said it was doing.
          'echo "@@HOOK"; cat "$(dirname "$HOME")/sessions/$ID.state.json" 2>/dev/null; echo; echo "@@ENDHOOK"',
          // Whether a claude process is running in the pane at all. The pane's own command is the
          // loop that runs claude (claude-session.sh), so claude is its child - and a pane with the
          // loop but no child is a shell, whatever the transcript's last line says.
          'if tmux has-session -t "mc-$ID" 2>/dev/null; then P=$(tmux display -p -t "mc-$ID" "#{pane_pid}" 2>/dev/null); [ -n "$P" ] && pgrep -P "$P" -x claude >/dev/null 2>&1 && echo "@@ALIVE"; fi',
          'echo "@@PANE"',
          'if tmux has-session -t "mc-$ID" 2>/dev/null; then tmux capture-pane -p -t "mc-$ID" | tail -n 40; else echo "@@NOPANE"; fi',
        ].join('\n'));

        const before = this.messages.length;

        this.absorb(out);
        // After absorb, which is what moves the transcript on: a queued message is retired by
        // the line claude has just written for it, and a picker is over once claude is writing
        // into the conversation again.
        this.prunePending();
        this.clearManager(this.messages.length > before);
        this.error = '';
        this.polledAt = new Date().toISOString();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.polling = false;
      }
    },

    absorb(out) {
      const fileMatch = /@@FILE (.*)/.exec(out);
      const file = fileMatch ? fileMatch[1].trim() : '';
      const size = Number(/@@SIZE (\d+)/.exec(out)?.[1] || 0);

      if (file !== this.file || size < this.offset) {
        // A different transcript (the id file appeared, or the conversation restarted): start over.
        this.file = file;
        this.offset = 0;
        this.lines = [];
        this.remainder = '';
        this.messages = [];
        if (size && out.includes('@@DATA') && this.offset === 0) {
          // The data in this answer is from OFF, which was for the old file; ask again from 0.
          return;
        }
      }

      const dataAt = out.indexOf('@@DATA\n');
      const dataEnd = out.indexOf('\n@@ENDDATA');

      if (dataAt >= 0 && dataEnd > dataAt) {
        const chunk = out.slice(dataAt + 7, dataEnd);
        const text = this.remainder + chunk;
        const parts = text.split('\n');

        this.remainder = parts.pop() || '';
        this.lines.push(...parts.filter((l) => l.trim()));
        const first = !this.messages.length;

        this.offset = size;
        const all = this.lines.concat(this.remainder.trim() ? [this.remainder] : []);

        this.messages = parseTranscript(all);
        this.entries = parseEntries(all);
        // The first load lands at the bottom, where the conversation is; after that, only
        // while the person is already there, so reading back is not interrupted.
        this.$nextTick(() => this.scrollToEnd(first));
      }

      const sdataAt = out.indexOf('@@SDATA\n');
      const sdataEnd = out.indexOf('\n@@SENDDATA');
      const ssize = Number(/@@SSIZE (\d+)/.exec(out)?.[1] || 0);

      if (this.view !== 'main' && ssize && ssize < this.sub.offset) {
        this.sub = {
          offset: 0, lines: [], remainder: '', messages: [],
        };
      } else if (this.view !== 'main' && sdataAt >= 0 && sdataEnd > sdataAt) {
        const text = this.sub.remainder + out.slice(sdataAt + 8, sdataEnd);
        const parts = text.split('\n');
        const remainder = parts.pop() || '';
        const lines = this.sub.lines.concat(parts.filter((l) => l.trim()));

        this.sub = {
          offset: ssize, lines, remainder, messages: parseTranscript(lines.concat(remainder.trim() ? [remainder] : [])),
        };
        this.$nextTick(() => this.scrollToEnd());
      }

      const tailsAt = out.indexOf('@@TAIL ');
      const tailsEnd = out.indexOf('@@ENDTAILS');

      if (tailsAt >= 0 && tailsEnd > tailsAt) {
        const tails = {};

        for (const chunk of out.slice(tailsAt, tailsEnd).split('@@TAIL ').slice(1)) {
          const [head, ...rest] = chunk.split('\n');
          const [id, at] = head.trim().split(/\s+/);
          let last = '';

          try {
            const entry = JSON.parse(rest.join('\n').trim());
            const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
            const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
            const tool = blocks.find((b) => b.type === 'tool_use');

            last = text || (tool ? `${ tool.name }: ${ toolSummary({ id: tool.id, name: tool.name, input: tool.input }) }` : '');
          } catch { /* a partial line; keep what we had */ }
          tails[id] = { at: Number(at) || 0, last: (last || this.tails[id]?.last || '').split('\n')[0].slice(0, 140) };
        }
        this.tails = tails;
      }

      const hookAt = out.indexOf('@@HOOK\n');
      const hookEnd = out.indexOf('\n@@ENDHOOK');

      if (hookAt >= 0 && hookEnd > hookAt) {
        try {
          const raw = out.slice(hookAt + 7, hookEnd).trim();

          this.hook = raw ? JSON.parse(raw) : null;
        } catch {
          // Half-written; the next poll reads a whole one.
        }
      }

      const paneAt = out.indexOf('@@PANE\n');
      const paneText = paneAt >= 0 ? out.slice(paneAt + 7) : '';

      this.attached = !paneText.includes('@@NOPANE');
      this.alive = this.attached && out.slice(0, paneAt >= 0 ? paneAt : undefined).includes('@@ALIVE');
      this.paneText = paneText;
      this.state = deriveState({
        entries: this.entries, hook: this.hook, attached: this.attached, alive: this.alive, paneText, now: Date.now(),
      });
      this.pane = paneFromState(this.state, paneText);
      this.$emit('state', this.attached ? 'open' : 'waiting');
    },

    scrollToEnd(force = false) {
      const el = this.$refs.log;

      if (el && (force || this.atBottom)) {
        el.scrollTop = el.scrollHeight;
        this.atBottom = true;
      }
    },

    onScroll() {
      const el = this.$refs.log;

      this.atBottom = !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    },

    /** Your own messages, one at a time, in either direction: to find the one you are after. */
    stepMine(direction) {
      const mine = [...(this.$refs.log?.querySelectorAll('.mc-chat__msg--user') || [])];

      if (!mine.length) {
        return;
      }
      const next = this.mineIndex < 0 ? (direction > 0 ? 0 : mine.length - 1) : Math.min(mine.length - 1, Math.max(0, this.mineIndex + direction));

      this.mineIndex = next;
      mine.forEach((el) => el.classList.remove('mc-chat__msg--found'));
      mine[next].classList.add('mc-chat__msg--found');
      mine[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
      this.atBottom = false;
    },

    /** Main, or one subagent: a different transcript, followed from the start. */
    show(view) {
      if (view === this.view) {
        return;
      }
      this.view = view;
      this.sub = {
        offset: 0, lines: [], remainder: '', messages: [],
      };
      this.mineIndex = -1;
      this.atBottom = true;
      this.poll();
    },

    toggleSummary(key) {
      this.openSummaries = { ...this.openSummaries, [key]: !this.openSummaries[key] };
    },

    firstLine(text) {
      return (text || '').split('\n').find((l) => l.trim()) || '';
    },

    /** Keys into the pane: a name tmux knows (Enter, Escape) or a literal string. */
    async keys(...args) {
      const quoted = args.map((a) => `'${ String(a).replace(/'/g, `'\\''`) }'`).join(' ');

      await this.run(`tmux send-keys -t "mc-${ this.paneId }" ${ quoted }`);
    },

    /** Text into the pane as one paste, then Enter: what the person typed, whatever is in it. */
    async say(text) {
      await this.run([
        `F=/tmp/.chat-say-${ Date.now().toString(36) }`,
        `echo ${ b64(text) } | base64 -d > $F`,
        `tmux load-buffer -b chat $F && tmux paste-buffer -b chat -t "mc-${ this.paneId }" -d -p && sleep 0.3 && tmux send-keys -t "mc-${ this.paneId }" Enter`,
        'rm -f $F',
      ].join('\n'));
    },

    async send() {
      if (!this.canSend) {
        return;
      }
      const text = this.draft.trim();

      this.sending = true;
      try {
        // The paths are in the message; the bytes may still be going. Waited for here rather
        // than at the paste, which is the whole point: an upload that finished while the
        // sentence was being typed costs nothing at all.
        if (this.uploads.length) {
          this.pasting = `Finishing ${ this.uploads.length === 1 ? 'an attachment' : `${ this.uploads.length } attachments` }`;
          await Promise.all(this.uploads);
        }
        if (!this.attached) {
          await this.start();
        }
        const before = this.paneText;

        await this.say(text);
        if (terminalOnly(text)) {
          this.echoTerminal(text, before);
        }
        // Typing `/mcp` by hand puts the pane into the same state the Customize menu does, so
        // it is recorded the same way rather than only when the menu was used.
        this.manager = managerIn(text) || this.manager;
        // Recorded before the poll rather than after it: the point of this is that there is
        // never a moment where the box is empty and the log does not have it.
        //
        // Not for a slash command. Those are the CLI's own: some write a local-command line to
        // the transcript (/model), some print to the terminal only (/cost) and some open a
        // picker (/mcp) - none of them is ever recorded as a prompt, so one tracked here would
        // read "not delivered" twenty seconds after doing exactly what it should.
        const isCommand = /^\//.test(text);

        this.pending = isCommand ? this.pending : [...this.pending, {
          key: `pending-${ Date.now().toString(36) }-${ this.pending.length }`,
          role: 'user',
          text,
          tools: [],
          thinking: '',
          images: [],
          at: new Date().toISOString(),
          queued: true,
          sentAt: Date.now(),
        }];
        this.draft = '';
        this.error = '';
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.sending = false;
        this.poll();
      }
    },

    /**
     * Drop the queued copies the transcript has now caught up with.
     *
     * Matched on the text, but only against user turns claude recorded at or after the moment
     * the message was sent: matching on text alone would retire a queued message the first
     * time the same words appeared anywhere in the conversation, and "yes" is said more than
     * once. Each transcript line is spent on at most one queued message, so saying the same
     * thing twice in a row retires one and leaves the other showing.
     */
    /**
     * What claude in this pod can be set to, asked of claude itself.
     *
     * One exec for all of it: the help, which carries every value the menus offer; the pane's
     * own argv, the environment and the two settings files, which between them decide which
     * model is actually in force and why (claude's own precedence, see currentModel).
     *
     * Read once at mount and again after a change is applied. Not polled: `claude --help`
     * shells out to the binary, and the poll that keeps the transcript current runs every
     * 1.5 seconds.
     */
    async readOptions() {
      const script = [
        'echo @@HELP',
        'claude --help 2>/dev/null',
        'echo @@ARGV',
        "ps -eo args= 2>/dev/null | grep -m1 '^claude' || true",
        'echo @@ENV',
        'printenv ANTHROPIC_MODEL 2>/dev/null || true',
        'echo @@FILES',
        // Three lines, always all three, so a blank first line still means "settings.json sets
        // no model" rather than shifting ~/.claude.json's answer into its place.
        `node -e 'const fs=require("fs");const g=(f,k)=>{try{return String(JSON.parse(fs.readFileSync(f,"utf8"))[k]||"")}catch(e){return ""}};const s=process.env.HOME+"/.claude/settings.json";const c=process.env.HOME+"/.claude.json";console.log(g(s,"model"));console.log(g(c,"model"));console.log(g(s,"effort")||g(s,"effortLevel"))' 2>/dev/null`,
        'echo @@END',
      ].join('\n');
      const out = await this.run(script, 30000).catch(() => '');

      if (!out.includes('@@HELP') || !out.includes('@@END')) {
        return;
      }

      const between = (from, to) => (out.split(from)[1] || '').split(to)[0] || '';
      const help = between('@@HELP', '@@ARGV');
      const argv = between('@@ARGV', '@@ENV').split('\n').map((l) => l.trim()).find((l) => l.startsWith('claude')) || '';
      const files = between('@@FILES', '@@END').split('\n');
      const found = currentModel({
        argv:     /--model[\s=]+(\S+)/.exec(argv)?.[1] || '',
        env:      between('@@ENV', '@@FILES').trim(),
        settings: files[1] || '',
        config:   files[2] || '',
      });

      this.options = {
        read:        true,
        models:      modelAliases(help),
        efforts:     flagChoices(help, '--effort'),
        model:       found.model,
        modelSource: found.source,
        // Only if something recorded it. There is no flag to read the running session's effort
        // back out of, so an unset one is shown as unset rather than guessed at, and the button
        // reads "model" rather than claiming a value.
        effort:      (files[3] || '').trim(),
      };
    },

    /** The MCP servers and whether each answered, read only when the menu is opened. */
    async readMcp() {
      this.mcp = { ...this.mcp, loading: true, error: '' };

      try {
        // `mcp list` health-checks every server, which is seconds rather than milliseconds.
        const out = await this.run('claude mcp list 2>&1', 60000);

        this.mcp = {
          read: true, loading: false, servers: parseMcpList(out), error: '',
        };
      } catch (e) {
        this.mcp = {
          read: true, loading: false, servers: [], error: e.message || String(e),
        };
      }
    },

    /**
     * Move the caret in the message box, which a thumb cannot do.
     *
     * `@mousedown.prevent` on the button is what makes it work at all: without it the box loses
     * focus on the press, the selection collapses, and the arrow moves a caret that is no
     * longer anywhere.
     */
    moveCaret(by) {
      const box = this.$refs.box;

      if (!box) {
        return;
      }
      const at = Math.max(0, Math.min(box.value.length, (box.selectionStart ?? 0) + by));

      box.focus();
      box.setSelectionRange(at, at);
    },

    /** The `/` button: the command menu, opened the way typing a slash opens it. */
    openCommandMenu() {
      this.menu = '';
      this.slashDismissed = false;
      if (!this.draft.startsWith('/')) {
        this.draft = `/${ this.draft }`;
      }
      this.slashIndex = 0;
      this.$nextTick(() => this.$refs.box?.focus());
      if (!this.mcp.read && !this.mcp.loading) {
        this.readMcp();
      }
    },

    toggleMenu(kind) {
      this.menu = this.menu === kind ? '' : kind;

    },

    /**
     * Change one of them, by typing claude's own command into the pane.
     *
     * Through claude rather than by writing its settings file, because claude is running: the
     * command changes the conversation that is open, and claude persists the choice itself
     * where it persists one. A settings file written underneath a live session would be read
     * by the next one and not by this one, which is the opposite of what the menu appears to
     * promise.
     *
     * A command claude does not understand answers in the pane, in view, which is why this can
     * offer what `--help` lists without also having to know which of them grew a slash command
     * in which version.
     */
    async applyOption(kind, value) {
      if (!isSafeOptionValue(value)) {
        this.error = `${ value } is not a value this can send`;

        return;
      }

      this.menu = '';
      this.optionBusy = kind;

      try {
        if (!this.attached) {
          await this.start();
        }
        await this.say(`/${ kind } ${ value }`);
        this.error = '';
        // Optimistic, then corrected by the re-read below: claude writes the model into its
        // settings, so the answer that comes back is the real one a moment later.
        this.options = { ...this.options, [kind]: value };
        setTimeout(() => this.readOptions().catch(() => {}), 2500);
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.optionBusy = '';
        this.poll();
      }
    },

    /**
     * Open one of claude's own managers, and go to the terminal, because that is where it is.
     *
     * `/permissions`, `/mcp`, `/memory` and the rest are full-screen pickers - keyboard-driven
     * terminal UIs, not prompts with options in them. The claim that "its prompt arrives
     * through the same pane-dialog path this view already draws options for" was simply wrong:
     * readPane recognises a login, a numbered list and a yes/no, and a manager is none of them.
     * So opening one from the chat drew nothing, and since Escape is only offered while claude
     * is working there was no way back either - every message typed afterwards went into the
     * picker instead of the conversation. That is the bug this replaces.
     *
     * The terminal can drive them perfectly well, and switching to it is what somebody wanted
     * when they pressed the button. The chat is one keypress away again afterwards.
     */
    async openManager(command) {
      this.menu = '';
      this.optionBusy = command;

      try {
        if (!this.attached) {
          await this.start();
        }
        await this.say(`/${ command }`);
        this.error = '';
        this.manager = command;
        // After the command, so the terminal opens on the manager rather than on the prompt.
        this.$emit('view', 'terminal');
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.optionBusy = '';
        this.poll();
      }
    },

    /** Escape, from a pane the chat cannot draw. The one way out that always exists. */
    async escapePane() {
      // Cleared optimistically: Escape is what closes a picker, and leaving the warning up until
      // the next poll agrees would be the same "says something untrue" problem in miniature.
      this.manager = '';
      try {
        await this.keys('Escape');
        await new Promise((resolve) => setTimeout(resolve, 300));
        await this.keys('Escape');
      } catch (e) {
        this.error = e.message || String(e);
      }
      setTimeout(() => this.poll(), 400);
    },

    /**
     * The picker is gone: the conversation moved on, or the pane is showing something readPane
     * understands again.
     *
     * A manager writes nothing to the transcript, so a transcript that has grown is proof that
     * claude is answering in the conversation again. `idle` and `busy` are the same evidence
     * from the pane's side. Any of them is enough, and being too eager to clear this is the safe
     * direction to be wrong in: the cost is a warning that vanishes early, against a warning
     * that lies.
     */
    clearManager(grew) {
      if (this.manager && (grew || this.pane.idle || this.pane.busy || this.pane.gone)) {
        this.manager = '';
      }
    },

    /**
     * The commands that are files in this pod: the project's, the user's, and the skills.
     *
     * `.claude/commands/<name>.md` is a command called `/<name>`; a directory under it is a
     * namespace, which claude spells `/<dir>:<name>`. A skill is invoked the same way by its
     * directory name. Read once, at mount, because these change when somebody edits the tree
     * and not while a message is being typed.
     */
    async readCommands() {
      const script = [
        'cd "$(dirname "$HOME")" 2>/dev/null || cd /',
        'for root in "$HOME/.claude" ".claude" "$PWD/.claude"; do',
        '  [ -d "$root/commands" ] && find "$root/commands" -name "*.md" -maxdepth 2 2>/dev/null | sed "s|^|CMD |"',
        '  [ -d "$root/skills" ] && find "$root/skills" -maxdepth 2 -name SKILL.md 2>/dev/null | sed "s|^|SKILL |"',
        'done',
      ].join('\n');
      const out = await this.run(script, 15000).catch(() => '');
      const seen = new Set();
      const found = [];

      for (const line of String(out).split('\n')) {
        const cmd = /^CMD (.*\/commands\/(.*)\.md)\s*$/.exec(line);
        const skill = /^SKILL .*\/skills\/([^/]+)\/SKILL\.md\s*$/.exec(line);
        const name = cmd ? `/${ cmd[2].replace(/\//g, ':') }` : (skill ? `/${ skill[1] }` : '');

        if (!name || seen.has(name)) {
          continue;
        }
        seen.add(name);
        found.push({ name, help: cmd ? 'this pod\u2019s own command' : 'skill', source: cmd ? 'command' : 'skill' });
      }

      this.custom = found.sort((a, b) => a.name.localeCompare(b.name));
    },

    /** Put a command in the box, ready for its argument. */
    pickCommand(command) {
      const rest = this.draft.slice(this.slashTyped ? this.slashTyped.name.length : 0);

      this.draft = `${ command.name }${ rest.startsWith(' ') ? rest : ` ${ rest }` }`.trimEnd();
      this.draft = `${ this.draft } `.replace(/\s+$/, ' ');
      this.slashIndex = 0;
      this.$nextTick(() => this.$refs.box?.focus());
    },

    moveSlash(direction) {
      const n = this.slashMatches.length;

      this.slashIndex = n ? (this.slashIndex + direction + n) % n : 0;
    },

    /**
     * Retire what this box sent once claude has recorded it anywhere - as a queued item, as a
     * prompt, or as the hook's UserPromptSubmit - and say so when it has not.
     *
     * The old version matched sent text against the user turns in the transcript, which retired
     * a message only once claude *started* on it: everything typed while it was busy sat marked
     * "queued" until then, and anything the paste did not land at all sat there for ever. Now
     * the CLI's own queue is drawn from its record (state.queue) and this list is only the gap
     * between Enter and that record - seconds, or a delivery failure, which is shown as one.
     */
    prunePending() {
      if (!this.pending.length) {
        return;
      }
      if (this.pane.gone) {
        // No claude to have taken it: the message is not going anywhere from here.
        this.pending = this.pending.map((p) => ({ ...p, failed: true }));

        return;
      }
      const now = Date.now();
      const left = this.pending
        .filter((p) => !sentSeen(p.text, p.sentAt, this.entries, this.hook, this.state.queue))
        .map((p) => (now - p.sentAt > 20000 && !p.failed ? { ...p, failed: true } : p));

      if (left.length !== this.pending.length || left.some((p, i) => p.failed !== this.pending[i]?.failed)) {
        this.pending = left;
      }
    },

    /**
     * Read back what the terminal printed for a command that prints only there.
     *
     * A little after the send, the pane's new lines - the ones not in the capture taken before
     * it - minus the prompt row and the status bar. Shown as a note under the log, dated now,
     * and kept for this visit only: it is the terminal's answer, not the conversation's.
     */
    async echoTerminal(command, before) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      let after = '';

      try {
        after = await this.run(`tmux capture-pane -p -t "mc-${ this.paneId }" | tail -n 60`);
      } catch {
        return;
      }
      const seen = new Set(before.split('\n').map((l) => l.trim()));
      const fresh = after.split('\n')
        .map((l) => l.replace(/[│┃]/g, ' ').trimEnd())
        .filter((l) => l.trim() && !seen.has(l.trim()) && !/^\s*❯/.test(l) && !/shift\+tab|esc to interrupt|for shortcuts|bypass permissions/i.test(l) && !/^[\s─╌═┌┐└┘╭╮╰╯▔▁]+$/.test(l));

      // These commands open a panel in the terminal (Settings · Status · Usage · Stats) and it
      // stays open until Esc. The chat has what it came for; the terminal should not be left
      // inside a panel that whoever opens it next did not open.
      this.keys('Escape').catch(() => {});
      if (!fresh.length) {
        return;
      }
      this.echoes = [...this.echoes, {
        key: `echo-${ Date.now().toString(36) }`, role: 'note', text: `${ command }\n${ fresh.join('\n') }`, tools: [], thinking: '', images: [], at: new Date().toISOString(),
      }];
      this.$nextTick(() => this.scrollToEnd());
    },

    /** A menu action that is a slash command: sent as typed, with the terminal's answer echoed. */
    async command(text) {
      this.menu = '';
      this.draft = text;
      await this.send();
    },

    async clearConversation() {
      this.menu = '';
      // eslint-disable-next-line no-alert
      if (!window.confirm('Clear this conversation? claude forgets everything said so far.')) {
        return;
      }
      await this.command('/clear');
    },

    /** Files chosen with the Attach button: images shrink as pasted ones do, anything else goes as it is. */
    attachPicked(event) {
      for (const file of [...(event.target.files || [])]) {
        this.attachImage(file);
      }
      event.target.value = '';
      this.$nextTick(() => this.$refs.box?.focus());
    },

    /** The checkout's files, for the mention picker: what git tracks plus what it has not been told to ignore. */
    async openFiles() {
      this.menu = '';
      this.files = {
        ...this.files, open: true, loading: true, filter: '',
      };
      this.$nextTick(() => this.$refs.fileFilter?.focus());
      try {
        const out = await this.run(`cd ${ JSON.stringify(this.workdir) } && (git ls-files --cached --others --exclude-standard 2>/dev/null || find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | sed 's|^./||') | head -n 4000`, 30000);

        this.files = { ...this.files, list: out.split('\n').map((l) => l.trim()).filter(Boolean), loading: false };
      } catch (e) {
        this.files = { ...this.files, loading: false };
        this.error = e.message || String(e);
      }
    },

    mention(path) {
      const at = `@${ path }`;

      this.draft = `${ this.draft }${ this.draft && !this.draft.endsWith(' ') ? ' ' : '' }${ at } `;
      this.files = { ...this.files, open: false };
      this.$nextTick(() => this.$refs.box?.focus());
    },

    /**
     * Whether claude thinks before answering, read from and written to the pane's own
     * settings.json - the same key /config's "Thinking mode" flips. claude reads it at the
     * start of each turn, so the change applies to the next message.
     */
    async readThinking() {
      try {
        const out = await this.run(`node -e "const s=require(process.env.HOME+'/.claude/settings.json');console.log(s.alwaysThinkingEnabled===false?'off':'on')" 2>/dev/null || echo on`);

        this.thinking = !/off/.test(out);
      } catch {
        this.thinking = null;
      }
    },

    async toggleThinking() {
      const next = !this.thinking;

      this.optionBusy = 'thinking';
      try {
        await this.run(`node -e "const f=process.env.HOME+'/.claude/settings.json';const fs=require('fs');const s=JSON.parse(fs.readFileSync(f,'utf8'));s.alwaysThinkingEnabled=${ next ? 'true' : 'false' };fs.writeFileSync(f,JSON.stringify(s,null,2)+'\\n')"`);
        this.thinking = next;
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.optionBusy = '';
      }
    },

    setLook(key, value) {
      this.look = { ...this.look, [key]: value };
      try {
        localStorage.setItem(LOOK_KEY, JSON.stringify(this.look));
      } catch { /* a browser without storage keeps it for this visit */ }
    },

    /** Send a message the pane never recorded, again. */
    async resend(p) {
      this.pending = this.pending.filter((x) => x.key !== p.key);
      this.draft = p.text;
      await this.send();
    },

    onKeydown(event) {
      // While the typeahead is open it owns the keys that move and choose. Enter picks the
      // highlighted command rather than sending, which is the one place this changes what a
      // key already did - and only while a menu is visibly open under the box.
      if (this.slashOpen) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          this.moveSlash(event.key === 'ArrowDown' ? 1 : -1);

          return;
        }
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing)) {
          event.preventDefault();
          this.pickCommand(this.slashMatches[this.slashIndex] || this.slashMatches[0]);

          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          this.slashDismissed = true;

          return;
        }
      }

      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      }
    },

    /** Start the pane detached, so a conversation opened here first has somewhere to go. */
    async start() {
      const argv = this.shellAt >= 0 ? [...this.argv.slice(this.shellAt, this.shellAt + 4), 'start'] : null;

      if (!argv) {
        throw new Error('this pane cannot be started from here; open the terminal view');
      }
      const pod = await this.locatePod();

      if (!pod) {
        throw new Error('no running pod');
      }
      await podExecOnce(pod, [...this.prefix, ...argv], 30000, this.container, this.namespace);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    },

    async choose(option) {
      try {
        await this.keys(option.key);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await this.keys('Enter');
      } catch (e) {
        this.error = e.message || String(e);
      }
      setTimeout(() => this.poll(), 400);
    },

    async submitCode() {
      const code = this.code.trim();

      if (!code) {
        return;
      }
      try {
        await this.say(code);
        this.code = '';
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    async stop() {
      try {
        await this.keys('Escape');
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    async login() {
      try {
        await this.say('/login');
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    toggleTool(id) {
      this.openTools = { ...this.openTools, [id]: !this.toolOpen(id) };
    },

    /**
     * Where the files a message names live: the pod the pane runs in. For a pane in another
     * pod (kubectl prefix) that pod is looked up by the label its Deployment gives it; the
     * viewer and the thumbnails then read it directly, with the same session that reads this one.
     */
    async mediaTarget() {
      if (this.media) {
        return this.media;
      }
      const pod = await this.locatePod();

      if (!pod) {
        return null;
      }
      if (this.prefix.length) {
        // The last `-n` and `-c`: kubectl's own. The wrapper before it is a `sh -c` of its own.
        const ns = this.prefix[this.prefix.lastIndexOf('-n') + 1];
        const container = this.prefix[this.prefix.lastIndexOf('-c') + 1] || 'workspace';
        const k = this.prefix.findIndex((a) => a === 'kubectl');
        const argv = [...this.prefix.slice(0, k + 1), 'get', 'pods', '-n', ns, '-l', `app=${ ns }`, '--field-selector=status.phase=Running', '-o', 'jsonpath={.items[0].metadata.name}'];
        const name = (await podExecOnce(pod, argv, 15000, this.container, this.namespace)).trim();

        if (!name) {
          return null;
        }
        this.media = {
          pod: name, container, namespace: ns, home: this.paneHome,
        };
      } else {
        this.media = {
          pod, container: this.container, namespace: this.namespace, home: this.paneHome,
        };
      }

      return this.media;
    },

    /** Thumbnails for every media placeholder the log has not filled in yet, one after another. */
    async hydrate() {
      if (this.hydrating || !this.$refs.log) {
        return;
      }
      const pending = [...this.$refs.log.querySelectorAll('.mc-chat__media:not([data-done])')];

      if (!pending.length) {
        return;
      }
      this.hydrating = true;
      try {
        for (const el of pending) {
          const path = el.dataset.path;
          const kind = el.dataset.kind;

          el.dataset.done = '1';
          if (kind === 'video') {
            el.innerHTML = '<span class="mc-chat__chip" title="Open the recording">&#9654;</span>';
            continue;
          }
          const cached = this.thumbs[path];

          if (cached) {
            this.fill(el, path, cached);
            continue;
          }
          let data = 'missing';

          try {
            const target = await this.mediaTarget();
            const stat = target ? await statPodPath(target, path) : { kind: 'none', size: 0 };

            if (stat.kind === 'file' && stat.size > 0 && stat.size <= THUMB_MAX) {
              const ext = path.split('.').pop().toLowerCase();

              data = `data:${ MIME[ext] || 'image/png' };base64,${ await readPodFileBase64(target, path) }`;
            } else if (stat.kind === 'file') {
              data = 'large';
            }
          } catch { /* missing it is */ }
          this.thumbs = { ...this.thumbs, [path]: data };
          this.fill(el, path, data);
        }
      } finally {
        this.hydrating = false;
      }
      // Thumbnails change the height; stay at the bottom if that is where the person was.
      this.scrollToEnd();
      if (this.$refs.log?.querySelector('.mc-chat__media:not([data-done])')) {
        this.hydrate();
      }
    },

    fill(el, path, data) {
      if (data === 'missing') {
        el.innerHTML = '<span class="mc-chat__chip mc-chat__chip--missing" title="Not in the workspace">&#10005;</span>';
      } else if (data === 'large') {
        el.innerHTML = '<span class="mc-chat__chip" title="Open the image">&#128444;</span>';
      } else {
        el.innerHTML = `<img class="mc-chat__thumb" src="${ data }" alt="" title="Open ${ escapeText(path) }">`;
      }
    },

    /** A click on a path or a thumbnail: the viewer, or a word about a file that is not there. */
    async onLogClick(event) {
      const hit = event.target.closest('[data-path]');

      if (!hit) {
        return;
      }
      event.preventDefault();
      const path = hit.dataset.path;

      try {
        const target = await this.mediaTarget();
        const stat = target ? await statPodPath(target, path) : { kind: 'none' };

        if (stat.kind === 'none') {
          this.flash(`${ path } is not in the workspace (any more).`);

          return;
        }
        this.viewerPath = path;
      } catch (e) {
        this.flash(e.message || String(e));
      }
    },

    flash(text) {
      this.notice = text;
      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => {
        this.notice = '';
      }, 5000);
    },

    toggleThought(key) {
      this.openThoughts = { ...this.openThoughts, [key]: !this.thoughtOpen(key) };
    },

    thoughtOpen(key) {
      return key in this.openThoughts ? this.openThoughts[key] : this.look.thoughts;
    },

    toolOpen(id) {
      return id in this.openTools ? this.openTools[id] : this.look.toolIo;
    },

    when(iso) {
      if (!iso) {
        return '';
      }
      const d = new Date(iso);

      return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    /** An image pasted or dropped: into the pod beside the pane, its path into the draft. */
    onPaste(event) {
      const items = [...(event.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/'));

      if (!items.length) {
        return;
      }
      event.preventDefault();
      items.forEach((item) => this.attachImage(item.getAsFile()));
    },

    onDrop(event) {
      const files = [...(event.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));

      if (!files.length) {
        return;
      }
      event.preventDefault();
      files.forEach((file) => this.attachImage(file));
    },

    /**
     * Attach an image: the path goes in the box now, the bytes go to the pod behind it.
     *
     * The path is decided here rather than after the upload, which is what makes this
     * possible - it is a timestamp and an extension, both known the moment the file arrives.
     * So pasting a screenshot puts `/workspace/.images/2026-…png ` in the box immediately and
     * you carry on typing the sentence around it; a 2MB screenshot is two hundred execs and
     * there is no reason to watch them.
     *
     * The upload is registered in `uploads`, and `send()` waits on those and only those - so
     * the wait happens once, at the point it actually matters, and only if the upload has not
     * finished by then. It usually has, because typing the rest of the message takes longer.
     */
    attachImage(file) {
      if (!file) {
        return Promise.resolve();
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const original = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '');
      // Naming the file before the bytes have been read means predicting what shrink will do
      // with them, so the decision moves here and shrink is told rather than asked. Only the
      // rare failure below can make this wrong, and it repairs itself.
      const converting = file.size >= 150_000 && typeof createImageBitmap === 'function';
      let path = `${ this.imageDir }/${ stamp }.${ converting ? 'jpg' : original }`;

      // In the box before a byte has moved.
      this.draft = `${ this.draft }${ this.draft && !this.draft.endsWith(' ') ? ' ' : '' }${ path } `;

      const upload = (async() => {
        try {
          const { bytes, extension } = await this.shrink(file, converting);

          // The conversion was meant to happen and could not - a decoder that threw, or a JPEG
          // that came out bigger than the PNG. The name is already in somebody's message, so
          // the name is what moves: the file is written under its true extension and the text
          // is corrected in place.
          if (extension !== path.split('.').pop()) {
            const corrected = path.replace(/\.[^.]+$/, `.${ extension }`);

            this.draft = this.draft.split(path).join(corrected);
            path = corrected;
          }
          let binary = '';

          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          }
          const encoded = btoa(binary);

          await this.run(`mkdir -p "$(dirname '${ path }')" && : > '${ path }.b64'`);
          for (let i = 0; i < encoded.length; i += CHUNK) {
            this.pasting = `Attaching the image (${ Math.round((i / encoded.length) * 100) }%)`;
            await this.run(`printf %s '${ encoded.slice(i, i + CHUNK) }' >> '${ path }.b64'`);
          }
          const out = await this.run(`base64 -d '${ path }.b64' > '${ path }' && rm -f '${ path }.b64' && wc -c < '${ path }'`);

          if (!parseInt(out.trim(), 10)) {
            throw new Error(`the image did not land in ${ this.label }`);
          }
        } catch (e) {
          // Said, and not silently: the path is already in the message, so a failure here is a
          // message about to be sent that names a file which is not there.
          this.error = `${ path } could not be attached: ${ e.message || e }`;
        } finally {
          this.uploads = this.uploads.filter((u) => u !== upload);
          if (!this.uploads.length) {
            this.pasting = '';
          }
        }
      })();

      this.uploads = [...this.uploads, upload];

      return upload;
    },

    /**
     * A screenshot as a JPEG when it is big: every chunk of it is an exec, and a 2 MB PNG of a
     * dashboard is two hundred of them. The model reads a JPEG just as well.
     */
    async shrink(file, converting) {
      const original = new Uint8Array(await file.arrayBuffer());
      const extension = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '');

      // Whether to convert is the caller's decision now, not this one's: the caller has already
      // named the file, and a function that decided the format after the name was chosen is a
      // function that could rename it underneath somebody's message.
      if (!converting) {
        return { bytes: original, extension };
      }
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');

        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));

        if (blob && blob.size < original.length) {
          return { bytes: new Uint8Array(await blob.arrayBuffer()), extension: 'jpg' };
        }
      } catch { /* keep the original */ }

      return { bytes: original, extension };
    },
  },
};
</script>

<template>
  <div
    class="mc-chat"
    :data-phase="state.phase"
    :data-hook="hook ? hook.event + (hook.notification ? ':' + hook.notification : '') : ''"
    :data-polled="polledAt"
    :data-entries="entries.length"
    :data-file="file"
    :class="[`mc-chat--${ look.size }`, `mc-chat--${ look.density }`, { 'mc-chat--flat': !look.bubbles, 'mc-chat--no-times': !look.times }]"
    @drop="onDrop"
    @dragover.prevent
  >
    <!--
      The subagents this conversation launched, behind one button: the ones still writing
      first, each with the first line of the last thing it said. Picking one shows its whole
      transcript here in place of the main conversation.
    -->
    <div
      v-if="agents.length"
      class="mc-chat__pick"
    >
      <button
        type="button"
        class="mc-chat__pick-btn"
        :class="{ 'mc-chat__pick-btn--open': showAgents }"
        @click="showAgents = !showAgents"
      >
        {{ showAgents ? '▾' : '▸' }} {{ agents.length }} subagent{{ agents.length === 1 ? '' : 's' }}<template v-if="workingAgents"> · {{ workingAgents }} working</template>
      </button>
      <span
        v-if="view !== 'main'"
        class="mc-chat__pick-current"
      >showing: {{ (agents.find((a) => a.id === view) || {}).description || view }}</span>
      <button
        v-if="view !== 'main'"
        type="button"
        class="mc-chat__link"
        @click="show('main')"
      >
        back to main
      </button>
    </div>
    <div
      v-if="agents.length && showAgents"
      class="mc-chat__agents"
    >
      <button
        v-for="a in agentRows"
        :key="a.id"
        type="button"
        class="mc-chat__agent"
        :class="{ 'mc-chat__agent--on': view === a.id, 'mc-chat__agent--working': a.working }"
        @click="show(a.id); showAgents = false"
      >
        <span class="mc-chat__agent-dot" />
        <span class="mc-chat__agent-name">{{ a.description }}</span>
        <span class="mc-chat__agent-last">{{ a.last || (a.working ? 'working' : 'nothing said yet') }}</span>
        <span class="mc-chat__agent-when">{{ a.when }}</span>
      </button>
    </div>
    <div
      ref="log"
      class="mc-chat__log"
      @click="onLogClick"
      @scroll.passive="onScroll"
    >
      <p
        v-if="!messages.length && !error"
        class="mc-chat__empty"
      >
        <template v-if="!attached">Nothing is running in this conversation yet. Say something to start it.</template>
        <template v-else-if="!file">Waiting for the conversation to begin.</template>
        <template v-else>Nothing has been said yet.</template>
      </p>
      <div
        v-for="m in rendered"
        :key="m.key"
        class="mc-chat__msg"
        :class="[`mc-chat__msg--${ m.role }`, { 'mc-chat__msg--queued': m.queued }]"
      >
        <div class="mc-chat__meta">
          <span class="mc-chat__who">{{ m.role === 'user' ? 'You' : m.role === 'summary' ? 'Summary' : m.role === 'note' ? 'Claude Code' : 'Claude' }}</span>
          <span class="mc-chat__when">{{ m.failed ? 'not delivered' : m.queued ? 'queued' : when(m.at) }}</span>
          <!--
            Said, rather than shown as an ordinary message, because it is not in the
            conversation yet: claude is mid-turn and has this waiting in its input queue. It
            turns into a normal message the moment the transcript records it.
          -->
          <span
            v-if="m.failed"
            class="mc-chat__queued-note mc-chat__queued-note--failed"
            title="Claude never recorded this message - the paste into the pane did not land"
          >claude did not receive this ·
            <button
              type="button"
              class="mc-chat__link"
              @click="resend(m)"
            >send again</button></span>
          <span
            v-else-if="m.inQueue"
            class="mc-chat__queued-note"
            title="In claude's input queue: it starts on this when the current turn ends"
          >in claude's queue</span>
          <span
            v-else-if="m.queued"
            class="mc-chat__queued-note"
            title="Sent; waiting for claude to record it"
          >sending</span>
          <button
            v-if="m.role === 'summary'"
            type="button"
            class="mc-chat__link"
            @click="toggleSummary(m.key)"
          >
            {{ openSummaries[m.key] ? 'Hide' : 'Show' }}
          </button>
        </div>
        <!-- A compact's summary: the conversation so far, folded. Shown on request. -->
        <div
          v-if="m.role === 'summary' && !openSummaries[m.key]"
          class="mc-chat__body mc-chat__summary-line"
        >
          {{ firstLine(m.text) }}
        </div>
        <div
          v-if="m.thinking"
          class="mc-chat__thought"
        >
          <button
            type="button"
            class="mc-chat__disclose"
            @click="toggleThought(m.key)"
          >
            {{ thoughtOpen(m.key) ? '▾' : '▸' }} Thinking
          </button>
          <pre
            v-if="thoughtOpen(m.key)"
            class="mc-chat__pre"
          >{{ m.thinking }}</pre>
        </div>
        <div
          v-if="(m.role === 'assistant' || (m.role === 'summary' && openSummaries[m.key])) && m.html"
          class="mc-chat__body mc-chat__md"
          v-html="m.html"
        />
        <div
          v-else-if="m.role === 'user'"
          class="mc-chat__body mc-chat__user-text"
          v-html="m.html"
        />
        <ul
          v-if="m.images.length"
          class="mc-chat__images"
        >
          <li
            v-for="(image, i) in m.images"
            :key="`${ i }-${ image.slice(0, 40) }`"
          >
            <img
              v-if="image.startsWith('data:')"
              :src="image"
              class="mc-chat__shot"
              alt="attached image"
              @click="viewerData = image"
            >
            <template v-else>🖼 {{ image }}</template>
          </li>
        </ul>
        <div
          v-for="t in m.toolRows"
          :key="t.id"
          class="mc-chat__tool"
          :class="{ 'mc-chat__tool--error': t.resultIsError, 'mc-chat__tool--pending': t.result === undefined }"
        >
          <button
            type="button"
            class="mc-chat__disclose"
            :aria-expanded="toolOpen(t.id) ? 'true' : 'false'"
            @click="toggleTool(t.id)"
          >
            <span class="mc-chat__tool-name">{{ t.name }}</span>
            <span
              class="mc-chat__tool-summary"
              v-html="t.summaryHtml"
            />
            <span
              v-if="t.result === undefined"
              class="mc-chat__tool-state"
            >…</span>
          </button>
          <div
            v-if="toolOpen(t.id)"
            class="mc-chat__tool-detail"
          >
            <span class="mc-chat__io">IN</span>
            <pre class="mc-chat__pre">{{ JSON.stringify(t.input, null, 2) }}</pre>
            <span
              v-if="t.result !== undefined"
              class="mc-chat__io"
            >OUT</span>
            <pre
              v-if="t.result !== undefined"
              class="mc-chat__pre mc-chat__pre--result"
            >{{ t.result.slice(0, 6000) }}{{ t.result.length > 6000 ? '\n…' : '' }}</pre>
          </div>
          <!-- An image the tool returned is worth seeing without opening the row. -->
          <div
            v-if="t.images && t.images.length"
            class="mc-chat__shots"
          >
            <img
              v-for="(image, i) in t.images"
              :key="i"
              :src="image"
              class="mc-chat__shot"
              alt="image the tool returned"
              @click="viewerData = image"
            >
          </div>
        </div>
      </div>
      <!-- Working: said where the next message will appear, moving, so it reads as happening. -->
      <div
        v-if="working"
        class="mc-chat__msg mc-chat__msg--assistant mc-chat__working"
      >
        <span class="mc-chat__dots"><i /><i /><i /></span>
        <span class="mc-chat__shimmer">{{ pane.status || 'Working' }}</span>
        <button
          type="button"
          class="mc-chat__link"
          @click="stop"
        >
          Stop
        </button>
      </div>
    </div>

    <div
      v-if="notice"
      class="mc-chat__notice"
    >
      {{ notice }}
    </div>

    <!--
      Getting around: the caret, your messages one by one, and the bottom.

      The caret keys are here rather than on the composer's own row because this is the row of
      things that move you around, and they are two more of those. The terminal's key bar -
      Esc, Tab, Ctrl, home, end, word-delete - is for driving a TUI and is hidden in this view
      (see PodTerminal); what a text box actually wants on a phone is a way to put the caret
      back one character to fix a typo, which is these two and nothing else.

      `@mousedown.prevent` is what makes them work at all: without it the box loses focus on
      the press, the selection collapses, and the arrow moves a caret that is no longer there.
    -->
    <div class="mc-chat__nav">
      <template v-if="coarse">
        <button
          type="button"
          class="mc-chat__navbtn mc-chat__navbtn--caret"
          title="Move the cursor left"
          @mousedown.prevent
          @click="moveCaret(-1)"
        >
          &#8592;
        </button>
        <button
          type="button"
          class="mc-chat__navbtn mc-chat__navbtn--caret"
          title="Move the cursor right"
          @mousedown.prevent
          @click="moveCaret(1)"
        >
          &#8594;
        </button>
      </template>
      <button
        type="button"
        class="mc-chat__navbtn"
        title="Your previous message"
        @click="stepMine(-1)"
      >
        &#8593; mine
      </button>
      <button
        type="button"
        class="mc-chat__navbtn"
        title="Your next message"
        @click="stepMine(1)"
      >
        &#8595; mine
      </button>
      <button
        v-if="!atBottom"
        type="button"
        class="mc-chat__navbtn mc-chat__navbtn--bottom"
        title="Jump to the bottom"
        @click="scrollToEnd(true)"
      >
        &#8681; bottom
      </button>
    </div>

    <Teleport to="body">
      <PodFileViewer
        v-if="viewerPath && media"
        :pod="media.pod"
        :path="viewerPath"
        :container="media.container"
        :namespace="media.namespace"
        :home="media.home"
        @close="viewerPath = ''"
      />
      <div
        v-if="viewerData"
        class="mc-chat__lightbox"
        role="dialog"
        aria-label="Image"
        @click="viewerData = ''"
      >
        <img
          :src="viewerData"
          alt="image"
        >
      </div>
    </Teleport>

    <!-- What the pane is asking, when it is asking something a text box cannot answer. -->
    <div
      v-if="pane.dialog"
      class="mc-chat__dialog"
    >
      <div
        v-if="pane.dialog.header"
        class="mc-chat__dialog-header"
      >{{ pane.dialog.header }}</div>
      <pre
        v-if="pane.dialog.prompt"
        class="mc-chat__dialog-prompt"
      >{{ pane.dialog.prompt }}</pre>
      <div
        v-if="pane.dialog.kind === 'options' || pane.dialog.kind === 'yes-no'"
        class="mc-chat__options"
      >
        <button
          v-for="o in pane.dialog.options"
          :key="o.key"
          type="button"
          class="mc-chat__option"
          :class="{ 'mc-chat__option--selected': o.selected }"
          :title="o.description || ''"
          @click="choose(o)"
        >
          <span class="mc-chat__option-key">{{ o.key }}</span> {{ o.label }}
          <span
            v-if="o.description"
            class="mc-chat__option-desc"
          >{{ o.description }}</span>
        </button>
      </div>
      <div
        v-else
        class="mc-chat__login"
      >
        <a
          v-if="pane.dialog.url"
          :href="pane.dialog.url"
          target="_blank"
          rel="noopener noreferrer"
          class="mc-chat__option"
        >Open the sign-in page</a>
        <div class="mc-chat__code">
          <input
            v-model="code"
            type="text"
            placeholder="Paste the code here"
            @keydown.enter.prevent="submitCode"
          >
          <button
            type="button"
            class="mc-chat__option"
            @click="submitCode"
          >
            Send
          </button>
        </div>
      </div>
    </div>

    <div class="mc-chat__status">
      <span v-if="error" class="mc-chat__error">{{ error }}</span>
      <template v-else-if="pasting">{{ pasting }}</template>
      <template v-else-if="working" />
      <template v-else-if="!attached">Not running</template>
      <template v-else-if="pane.gone">
        Claude is not running in this pane.
        <button
          type="button"
          class="mc-chat__link"
          @click="login"
        >
          /login
        </button>
      </template>
      <template v-else-if="state.phase === 'waiting'">
        {{ pane.status || 'Claude is waiting for you' }}
        <button
          type="button"
          class="mc-chat__link"
          title="Answer it in the terminal"
          @click="$emit('view', 'terminal')"
        >
          open the terminal
        </button>
      </template>
      <template v-else>{{ pane.status || 'Ready' }}<template v-if="state.cost && state.cost.totalCostUSD"> · ${{ state.cost.totalCostUSD.toFixed(2) }} this session</template></template>
    </div>

    <!--
      The model picker, with Effort as a row inside it rather than as a control of its own -
      "when the current model supports effort levels, the picker also shows an Effort row". It
      is a property of the model, and a second button on the bar for it said otherwise.
    -->
    <div
      v-if="menu === 'actions'"
      class="mc-chat__menu mc-chat__menu--actions"
    >
      <p class="mc-chat__menu-head">
        Context
      </p>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="$refs.filePick.click(); menu = ''"
      >
        <span class="mc-chat__menu-name">Attach file…</span>
        <span class="mc-chat__menu-note">uploaded to the pod, path put in the message</span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="openFiles"
      >
        <span class="mc-chat__menu-name">Mention file from this project…</span>
        <span class="mc-chat__menu-note">@path</span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="command('/compact')"
      >
        <span class="mc-chat__menu-name">Compact conversation</span>
        <span class="mc-chat__menu-note">/compact</span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="clearConversation"
      >
        <span class="mc-chat__menu-name">Clear conversation</span>
        <span class="mc-chat__menu-note">/clear</span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="openManager('rewind')"
      >
        <span class="mc-chat__menu-name">Rewind…</span>
        <span class="mc-chat__menu-note">in the terminal</span>
      </button>
      <p class="mc-chat__menu-head">
        Model
      </p>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="menu = 'model'"
      >
        <span class="mc-chat__menu-name">Switch model…</span>
        <span class="mc-chat__menu-note">{{ options.model || state.model }}<template v-if="options.effort"> · {{ options.effort }}</template></span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        :disabled="thinking === null || optionBusy === 'thinking'"
        @click="toggleThinking"
      >
        <span class="mc-chat__menu-name">Thinking</span>
        <span class="mc-chat__menu-note">{{ thinking === null ? '…' : thinking ? 'on' : 'off' }}</span>
      </button>
      <p class="mc-chat__menu-head">
        Account
      </p>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="command('/usage')"
      >
        <span class="mc-chat__menu-name">Account &amp; usage</span>
        <span class="mc-chat__menu-note">/usage<template v-if="state.cost && state.cost.totalCostUSD"> · ${{ state.cost.totalCostUSD.toFixed(2) }} this session</template></span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="command('/status')"
      >
        <span class="mc-chat__menu-name">Status</span>
        <span class="mc-chat__menu-note">/status</span>
      </button>
      <p class="mc-chat__menu-head">
        Appearance
      </p>
      <div class="mc-chat__look">
        <span class="mc-chat__look-label">Text</span>
        <button
          v-for="v in ['small', 'medium', 'large']"
          :key="v"
          type="button"
          class="mc-chat__effort"
          :class="{ 'mc-chat__effort--on': look.size === v }"
          @click="setLook('size', v)"
        >
          {{ v }}
        </button>
      </div>
      <div class="mc-chat__look">
        <span class="mc-chat__look-label">Spacing</span>
        <button
          v-for="v in ['compact', 'comfortable']"
          :key="v"
          type="button"
          class="mc-chat__effort"
          :class="{ 'mc-chat__effort--on': look.density === v }"
          @click="setLook('density', v)"
        >
          {{ v }}
        </button>
      </div>
      <button
        v-for="t in lookToggles"
        :key="t.key"
        type="button"
        class="mc-chat__menu-item"
        @click="setLook(t.key, !look[t.key])"
      >
        <span class="mc-chat__menu-tick">{{ look[t.key] ? '✓' : '' }}</span>
        <span class="mc-chat__menu-name">{{ t.label }}</span>
      </button>
    </div>
    <div
      v-if="files.open"
      class="mc-chat__menu mc-chat__menu--files"
    >
      <p class="mc-chat__menu-head">
        Mention a file<span class="mc-chat__menu-note">{{ files.loading ? 'reading the checkout…' : `${ files.list.length } files` }}</span>
      </p>
      <input
        ref="fileFilter"
        v-model="files.filter"
        type="text"
        class="mc-chat__file-filter"
        placeholder="Filter by path"
        @keydown.escape.prevent="files.open = false"
        @keydown.enter.prevent="fileMatches[0] && mention(fileMatches[0])"
      >
      <button
        v-for="f in fileMatches"
        :key="f"
        type="button"
        class="mc-chat__menu-item mc-chat__menu-item--file"
        @click="mention(f)"
      >
        <span class="mc-chat__menu-name">{{ f }}</span>
      </button>
      <p
        v-if="!files.loading && !fileMatches.length"
        class="mc-chat__menu-note mc-chat__menu-empty"
      >
        Nothing matches.
      </p>
    </div>
    <div
      v-if="menu === 'model'"
      class="mc-chat__menu"
    >
      <p class="mc-chat__menu-head">
        Model<span
          v-if="options.modelSource"
          class="mc-chat__menu-note"
        >set by {{ options.modelSource }}</span>
      </p>
      <button
        v-for="value in options.models"
        :key="value"
        type="button"
        class="mc-chat__menu-item"
        :class="{ 'mc-chat__menu-item--on': value === options.model }"
        @click="applyOption('model', value)"
      >
        <span class="mc-chat__menu-tick">{{ value === options.model ? '✓' : '' }}</span>
        <span class="mc-chat__menu-name">{{ value }}</span>
      </button>

      <template v-if="options.efforts.length">
        <p class="mc-chat__menu-head">
          Effort
        </p>
        <div class="mc-chat__efforts">
          <button
            v-for="value in options.efforts"
            :key="value"
            type="button"
            class="mc-chat__effort"
            :class="{ 'mc-chat__effort--on': value === options.effort }"
            @click="applyOption('effort', value)"
          >
            {{ value }}
          </button>
        </div>
      </template>
    </div>

    <!--
      The commands, while one is being typed. Above the box rather than below it, because the
      box is already at the bottom of the panel and a menu under it would be off-screen.

      Customize is the extension's own section of this menu - "MCP servers, slash commands,
      output styles, hooks, memory, permissions and plugins" - so MCP is reached from here
      rather than from a button of its own on the bar.
    -->
    <ul
      v-if="slashOpen"
      class="mc-chat__slash"
    >
      <li v-if="customize.length && !slashTyped.name.slice(1)">
        <p class="mc-chat__menu-head">
          Customize
        </p>
      </li>
      <li
        v-for="c in customize"
        v-show="!slashTyped.name.slice(1)"
        :key="`customize-${ c.command }`"
      >
        <button
          type="button"
          class="mc-chat__slash-item"
          @click="openManager(c.command)"
        >
          <span class="mc-chat__slash-name">/{{ c.command }}</span>
          <span class="mc-chat__slash-help">{{ c.help }}</span>
          <span
            v-if="c.command === 'mcp'"
            class="mc-chat__slash-source"
          >{{ mcp.read ? `${ mcp.servers.filter((x) => x.ok).length }/${ mcp.servers.length }` : '' }}</span>
        </button>
      </li>
      <li
        v-for="(c, i) in slashMatches"
        :key="c.name"
      >
        <button
          type="button"
          class="mc-chat__slash-item"
          :class="{ 'mc-chat__slash-item--on': i === slashIndex }"
          @mouseenter="slashIndex = i"
          @click="pickCommand(c)"
        >
          <span class="mc-chat__slash-name">{{ c.name }}</span>
          <span class="mc-chat__slash-help">{{ c.help }}</span>
          <span class="mc-chat__slash-source">{{ c.source }}</span>
        </button>
      </li>
    </ul>

    <!--
      A pane the chat cannot draw, said out loud with the two ways out of it.

      Without this, a full-screen picker in the pane looked exactly like a chat that had
      stopped working: nothing drawn, no error, and every message typed going somewhere the
      conversation never saw.
    -->
    <div
      v-if="takenOver"
      class="mc-chat__takeover"
    >
      <div class="mc-chat__takeover-head">
        <span>Claude Code is showing something here that the chat cannot draw.</span>
        <button
          type="button"
          class="mc-chat__navbtn"
          title="Send Escape to close it"
          @click="escapePane"
        >
          Escape
        </button>
        <button
          type="button"
          class="mc-chat__navbtn"
          title="Open the terminal, where it can be used"
          @click="$emit('view', 'terminal')"
        >
          Open the terminal
        </button>
      </div>
      <pre class="mc-chat__takeover-tail">{{ paneTail }}</pre>
    </div>

    <div
      v-if="slashHint"
      class="mc-chat__slash-hint"
      :class="`mc-chat__slash-hint--${ slashState }`"
    >
      {{ slashHint }}
    </div>

    <!--
      The prompt box: one bordered box with the text area and the controls inside it, which is
      where Claude Code's VS Code extension puts them - "click the model name at the bottom of
      the prompt box", "click the mode indicator at the bottom of the prompt box". They were a
      row of outlined pills above the box, which read as four buttons competing with the thing
      somebody is actually doing. Here they are quiet text until they are wanted.
    -->
    <div
      class="mc-chat__box"
      :class="[slashState ? `mc-chat__box--${ slashState }` : '', { 'mc-chat__box--focus': focused }]"
    >
      <textarea
        ref="box"
        v-model="draft"
        class="mc-chat__textarea"
        rows="3"
        :placeholder="working ? 'Queue the next message…' : 'Message Claude — / for commands'"
        :title="'Enter to send, Shift+Enter for a new line, / for commands, paste an image to attach it'"
        @keydown="onKeydown"
        @paste="onPaste"
        @focus="focused = true"
        @blur="focused = false"
      />
      <div class="mc-chat__bar">
        <!-- The actions menu: what the desktop chat keeps under its "+", backed by the CLI. -->
        <button
          type="button"
          class="mc-chat__pill mc-chat__pill--icon"
          :class="{ 'mc-chat__pill--on': menu === 'actions' }"
          title="Attach, mention a file, clear, model, usage, appearance"
          @click="toggleMenu('actions')"
        >
          +
        </button>
        <input
          ref="filePick"
          type="file"
          multiple
          class="mc-chat__hidden"
          @change="attachPicked"
        >
        <!-- The model, and the effort level, which the picker carries as a row of its own. -->
        <button
          v-if="options.read"
          type="button"
          class="mc-chat__pill"
          :class="{ 'mc-chat__pill--on': menu === 'model' }"
          :title="options.modelSource ? `Model — set by ${ options.modelSource }` : 'Model'"
          :disabled="optionBusy === 'model' || optionBusy === 'effort'"
          @click="toggleMenu('model')"
        >
          {{ optionBusy === 'model' || optionBusy === 'effort' ? '…' : (options.model || 'model') }}<template v-if="options.effort"> · {{ options.effort }}</template>
          <svg
            class="mc-chat__chev"
            width="8"
            height="8"
            viewBox="0 0 8 8"
            aria-hidden="true"
          ><path
            d="M1 2.5 L4 5.5 L7 2.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          /></svg>
        </button>

        <!--
          There is no permissions control here, deliberately.

          Every pane starts claude with `--dangerously-skip-permissions` (see
          seed/claude-session.sh), so the mode is not a thing that changes and a button showing
          it was a button that only ever opened a picker. That picker is a full-screen terminal
          UI: the chat could not draw it and, before the warning below existed, could not leave
          it either - which is how a button that looked like a label ended a conversation.

          If a permission prompt does appear, the warning below says so and the terminal is one
          press away, which is where it can be answered.
        -->

        <span class="mc-chat__bar-gap" />

        <!--
          `/` opens the same menu typing one does, which is what the extension's command menu
          button does, and is where MCP servers and the rest of Customize live.
        -->
        <button
          type="button"
          class="mc-chat__pill mc-chat__pill--icon"
          title="Commands, MCP servers and settings"
          @click="openCommandMenu"
        >
          /
        </button>
        <button
          type="button"
          class="mc-chat__send"
          :disabled="!canSend"
          :title="canSend ? 'Send' : 'Nothing to send'"
          @click="send"
        >
          {{ sending ? '…' : '↑' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.mc-chat {
  /*
   * The one inset every element that lines up with the prompt box is measured from.
   *
   * It was written out at each of them - the log, the menus, the action row, the box - and
   * they drifted: the action row sat a gutter further in than the box it belongs to. One
   * value, and they cannot.
   */
  --mc-chat-gutter: 18px;

  position:       relative;
  display:        flex;
  flex-direction: column;
  height:         100%;
  min-height:     0;
  min-width:      0;
  background:     var(--terminal-bg, var(--body-bg));
  color:          var(--body-text);
  /*
   * A real prose font, not the terminal's.
   *
   * The chat is drawn where the terminal is, so with no family of its own it inherited the
   * harness-terminal monospace - which has no em-dash glyph, so every "—" in an agent's reply
   * came out as "_". Prose belongs in a proportional font anyway; code and the option pills
   * still ask for monospace explicitly where they need it.
   */
  font-family:    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size:      13px;
  line-height:    1.5;

  &__log {
    flex:       1 1 auto;
    overflow:   auto;
    // The top inset clears the view toggle that floats over this corner (PodTerminal's
    // __tools): on a touch screen there is no hover to hide it, so without this the first
    // line of the conversation is read through a pair of buttons.
    padding:    32px var(--mc-chat-gutter) 8px;
    min-height: 0;
  }

  &__empty { color: var(--muted); }

  &__msg {
    position:      relative;
    // A turn is separated from the next by more than the lines inside it are from each other,
    // which is what makes a conversation readable as turns rather than as one column of boxes.
    // It was 10px between messages and 10px of padding inside them, so the gap between two
    // people talking measured the same as the gap between a heading and its own text.
    margin:        0 0 14px;
    padding:       10px 14px 10px 16px;
    border-radius: 10px;
    max-width:     100%;
    border:        1px solid transparent;

    &--user {
      background:   color-mix(in srgb, var(--link) 12%, transparent);
      border-color: color-mix(in srgb, var(--link) 22%, transparent);
      margin-left:  36px;
    }

    &--assistant {
      background:   color-mix(in srgb, var(--body-text) 4%, transparent);
      border-color: color-mix(in srgb, var(--body-text) 9%, transparent);
    }

    // Sent, but not in the transcript yet. A dashed edge rather than a faded message: it has
    // to be legible - it is what the person just wrote - while still not claiming to be part
    // of the conversation.
    &--queued {
      border-style: dashed;
      border-color: color-mix(in srgb, var(--link) 45%, transparent);
      background:   color-mix(in srgb, var(--link) 6%, transparent);
    }
  }

  &__queued-note {
    color:          var(--muted);
    font-size:      10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;

    &--failed { color: var(--error, #d9534f); text-transform: none; letter-spacing: 0; }
  }

  &__msg--note {
    opacity: 0.8;

    .mc-chat__body { font-family: monospace; font-size: 11px; white-space: pre-wrap; color: var(--muted); }
  }

  &__shots {
    display:   flex;
    flex-wrap: wrap;
    gap:       6px;
    margin:    6px 0 2px;
  }

  &__shot {
    max-width:     240px;
    max-height:    160px;
    border:        1px solid var(--border);
    border-radius: 4px;
    cursor:        zoom-in;
    object-fit:    contain;
    background:    var(--body-bg);
  }

  &__lightbox {
    position:        fixed;
    inset:           0;
    z-index:         1000;
    background:      rgba(0, 0, 0, 0.8);
    display:         flex;
    align-items:     center;
    justify-content: center;
    cursor:          zoom-out;

    img { max-width: 96vw; max-height: 96vh; object-fit: contain; }
  }

  &__dialog-header {
    font-weight: 600;
    margin:      0 0 4px;
  }

  &__hidden { display: none; }

  &__menu--actions, &__menu--files {
    max-height: min(60vh, 520px);
    overflow-y: auto;

    .mc-chat__menu-item { justify-content: space-between; }
    .mc-chat__menu-note { margin-left: auto; padding-left: 12px; white-space: nowrap; }
  }

  &__menu-item--file .mc-chat__menu-name { font-family: monospace; font-size: 11px; }

  &__file-filter {
    width:         100%;
    box-sizing:    border-box;
    margin:        2px 0 6px;
    padding:       5px 8px;
    border:        1px solid var(--border);
    border-radius: 6px;
    background:    var(--body-bg);
    color:         var(--body-text);
    font-size:     12px;
  }

  &__menu-empty { padding: 6px 8px; }

  &__look {
    display:     flex;
    align-items: center;
    gap:         4px;
    padding:     2px 8px 6px;
  }

  &__look-label {
    color:     var(--muted);
    font-size: 11px;
    min-width: 56px;
  }

  &__io {
    display:        inline-block;
    margin:         4px 0 2px;
    color:          var(--muted);
    font-size:      9px;
    letter-spacing: 0.08em;
    font-family:    monospace;
  }

  /* Appearance: each preference is one class on the root. */
  &--small { font-size: 11px; .mc-chat__body { font-size: 11px; } }
  &--large { font-size: 14px; .mc-chat__body { font-size: 14px; } }
  &--compact { .mc-chat__msg { margin: 4px 0; } .mc-chat__meta { margin-bottom: 1px; } }
  &--flat { .mc-chat__msg--user .mc-chat__body { background: transparent; border: 0; padding-left: 0; } }
  &--no-times { .mc-chat__when { display: none; } }

  &__option-desc {
    display:   block;
    color:     var(--muted);
    font-size: 11px;
    margin:    2px 0 0 18px;
  }

  &__meta {
    display:     flex;
    flex-wrap:   wrap;
    gap:         8px;
    align-items: baseline;
    margin:      0 0 6px;
  }

  &__who {
    font-weight:    600;
    font-size:      11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color:          var(--muted);
  }
  &__msg--user &__who { color: var(--link); }
  &__when { color: var(--muted); font-size: 11px; }

  &__user-text { word-break: break-word; }

  &__md {
    word-break: break-word;

    :deep(p) { margin: 0 0 8px; }
    :deep(p:last-child) { margin-bottom: 0; }
    :deep(pre) {
      background:    var(--body-bg);
      border:        1px solid var(--border);
      border-radius: 6px;
      padding:       8px 10px;
      overflow:      auto;
      font-size:     12px;
      margin:        6px 0;
    }
    :deep(code) { font-family: monospace; font-size: 12px; }
    :deep(p code), :deep(li code) { background: color-mix(in srgb, var(--body-text) 8%, transparent); padding: 0 4px; border-radius: 3px; }
    :deep(ul), :deep(ol) { margin: 4px 0 8px; padding-left: 22px; }
    :deep(h3), :deep(h4), :deep(h5), :deep(h6) { margin: 8px 0 4px; font-size: 13px; }
    :deep(blockquote) { border-left: 3px solid var(--border); margin: 6px 0; padding-left: 10px; color: var(--muted); }
    :deep(a) { color: var(--link); }

    // A table scrolls sideways in its own box: the chat is narrow and often docked, and a wide
    // table must not widen the panel.
    :deep(.mc-chat__table-wrap) {
      max-width:   100%;
      overflow-x:  auto;
      margin:      6px 0;
    }
    :deep(table) {
      border-collapse: collapse;
      font-size:       12px;
    }
    :deep(th), :deep(td) {
      border:      1px solid var(--border);
      padding:     4px 8px;
      text-align:  left;
      white-space: nowrap;
    }
    :deep(th) {
      background:   color-mix(in srgb, var(--body-text) 6%, transparent);
      font-weight:  600;
    }
  }

  // A path, wherever it is said: the thing a click opens.
  :deep(.mc-chat__path) {
    color:           var(--link);
    text-decoration: none;
    font-family:     monospace;
    font-size:       12px;
    word-break:      break-all;
    cursor:          pointer;
  }

  :deep(.mc-chat__path:hover) { text-decoration: underline; }

  :deep(.mc-chat__media) {
    display:        inline-flex;
    align-items:    center;
    vertical-align: middle;
    margin:         0 4px 0 0;
    cursor:         pointer;
  }

  // The thumbnail is one line tall, so it sits in the sentence rather than breaking it.
  :deep(.mc-chat__thumb) {
    height:         1.4em;
    width:          auto;
    max-width:      6em;
    object-fit:     cover;
    border-radius:  3px;
    border:         1px solid var(--border);
    vertical-align: middle;
    background:     var(--body-bg);
    transition:     transform 0.12s ease;
  }

  :deep(.mc-chat__thumb:hover) { transform: scale(1.6); position: relative; z-index: 2; }

  :deep(.mc-chat__chip) {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    height:          1.4em;
    min-width:       1.6em;
    padding:         0 4px;
    border-radius:   3px;
    border:          1px solid var(--border);
    background:      var(--body-bg);
    font-size:       10px;
    color:           var(--link);
  }

  :deep(.mc-chat__chip--missing) { color: var(--muted); text-decoration: line-through; }

  &__images {
    list-style:  none;
    padding:     0;
    margin:      6px 0 0;
    font-family: monospace;
    font-size:   12px;
    color:       var(--muted);
  }

  // Tool calls: one line each, an accordion. The badge is the tool, the rest is what it did.
  &__tool {
    margin:       2px 0 0;
    font-size:    12px;
    line-height:  1.35;

    &--error .mc-chat__tool-name { background: color-mix(in srgb, var(--error) 22%, transparent); color: var(--error); }
    &--pending .mc-chat__tool-name { background: color-mix(in srgb, var(--link) 18%, transparent); color: var(--link); }
  }

  &__disclose {
    background:  none;
    border:      0;
    padding:     1px 0;
    min-height:  0;
    color:       var(--muted);
    cursor:      pointer;
    text-align:  left;
    font-size:   12px;
    display:     flex;
    gap:         6px;
    align-items: baseline;
    max-width:   100%;
    width:       100%;

    &::before {
      content:   '▸';
      flex:      0 0 auto;
      font-size: 9px;
      color:     var(--muted);
    }

    &:hover { color: var(--body-text); }
  }

  &__tool-detail + &__disclose::before, &__disclose[aria-expanded='true']::before { content: '▾'; }

  &__tool-name {
    flex:          0 0 auto;
    font-weight:   600;
    font-size:     10px;
    line-height:   16px;
    padding:       0 5px;
    border-radius: 3px;
    background:    color-mix(in srgb, var(--body-text) 8%, transparent);
    color:         var(--body-text);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  &__tool-summary {
    color:         var(--muted);
    font-family:   monospace;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    min-width:     0;
  }
  &__tool-state { color: var(--link); }

  &__pre {
    margin:        4px 0 0;
    padding:       6px 8px;
    font-size:     11px;
    background:    var(--body-bg);
    border:        1px solid var(--border);
    border-radius: 4px;
    white-space:   pre-wrap;
    word-break:    break-word;
    max-height:    320px;
    overflow:      auto;

    &--result { border-color: color-mix(in srgb, var(--link) 40%, var(--border)); }
  }

  &__thought { margin: 0 0 6px; color: var(--muted); }

  // Working: three dots that breathe, and a status that shimmers, like a reply being typed.
  &__working {
    display:     flex;
    align-items: center;
    gap:         10px;
    color:       var(--muted);
  }

  &__dots {
    display: inline-flex;
    gap:     4px;

    i {
      width:         7px;
      height:        7px;
      border-radius: 50%;
      background:    var(--link);
      opacity:       0.35;
      animation:     mc-chat-bounce 1.2s infinite ease-in-out;

      &:nth-child(2) { animation-delay: 0.15s; }
      &:nth-child(3) { animation-delay: 0.3s; }
    }
  }

  &__shimmer {
    background:              linear-gradient(90deg, var(--muted) 0%, var(--body-text) 45%, var(--muted) 90%);
    background-size:         200% 100%;
    -webkit-background-clip: text;
    background-clip:         text;
    color:                   transparent;
    animation:               mc-chat-shimmer 2.2s linear infinite;
  }

  &__notice {
    position:      absolute;
    left:          18px;
    right:         18px;
    bottom:        118px;
    z-index:       4;
    padding:       8px 12px;
    border-radius: 8px;
    background:    color-mix(in srgb, var(--warning) 18%, var(--body-bg));
    border:        1px solid color-mix(in srgb, var(--warning) 50%, transparent);
    font-size:     12px;
    box-shadow:    0 4px 14px rgba(0, 0, 0, 0.25);
  }

  &__dialog {
    flex:          0 0 auto;
    margin:        0 18px 8px;
    padding:       10px 12px;
    border:        1px solid var(--link);
    border-radius: 10px;
    background:    color-mix(in srgb, var(--link) 8%, transparent);
  }

  &__dialog-prompt {
    margin:      0 0 8px;
    white-space: pre-wrap;
    font-family: inherit;
    font-size:   12px;
  }

  &__options {
    display:   flex;
    flex-wrap: wrap;
    gap:       6px;
  }

  &__option {
    border:          1px solid var(--border);
    background:      var(--body-bg);
    color:           var(--body-text);
    border-radius:   6px;
    padding:         4px 10px;
    min-height:      0;
    font-size:       12px;
    cursor:          pointer;
    text-decoration: none;

    &:hover { border-color: var(--link); color: var(--link); }
    &--selected { border-color: var(--link); }
  }

  &__option-key {
    display:     inline-block;
    min-width:   14px;
    color:       var(--muted);
    font-family: monospace;
  }

  &__login { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  &__code { display: flex; gap: 6px; }
  &__code input { height: 28px; font-size: 12px; padding: 0 8px; }

  // Nothing in it is no line at all. It was holding a row's height open between the action
  // row and the box whether or not it had anything to say, which is most of the gap that was
  // there.
  &__status:empty { display: none; padding: 0; }

  &__status {
    flex:        0 0 auto;
    padding:     4px 18px;
    font-size:   11px;
    color:       var(--muted);
    display:     flex;
    gap:         8px;
    align-items: center;
    min-height:  22px;
  }

  &__error { color: var(--error); }

  &__link {
    background: none;
    border:     0;
    padding:    0;
    min-height: 0;
    color:      var(--link);
    cursor:     pointer;
    font-size:  11px;
  }

  // ── The prompt box ──
  // One bordered box with the text area and the controls inside it. The border used to be on
  // the textarea, with the send button beside it and four outlined pills on a row above; that
  // is four competing rectangles around the one thing somebody is doing. The box owns the
  // border, everything inside it is borderless, and the controls are quiet text until hovered.
  &__box {
    flex:          0 0 auto;
    display:       flex;
    flex-direction: column;
    margin:        0 var(--mc-chat-gutter) 12px;
    border:        1px solid var(--border);
    border-radius: 8px;
    background:    var(--body-bg);
    transition:    border-color 0.12s ease;

    &--focus { border-color: var(--link); }
    &--known { border-color: var(--success); }
    &--unknown { border-color: var(--warning); }
  }

  &__textarea {
    flex:       1 1 auto;
    resize:     vertical;
    min-height: 52px;
    padding:    9px 11px 4px;
    border:     0;
    background: transparent;
    color:      var(--body-text);
    font-size:  13px;
    font-family: inherit;

    &:focus { outline: none; }
    &::placeholder { color: var(--muted); }
  }

  // The row along the bottom of the box: model, permissions, then the command menu and send.
  &__bar {
    display:     flex;
    align-items: center;
    gap:         2px;
    padding:     3px 5px 5px;
  }

  &__bar-gap { flex: 1 1 auto; }

  // Quiet text, not a chip. It reads as a label until it is wanted, which is what keeps four
  // controls from competing with the message being written.
  &__pill {
    display:       flex;
    align-items:   center;
    gap:           4px;
    max-width:     40%;
    padding:       3px 7px;
    border:        0;
    border-radius: 6px;
    background:    transparent;
    color:         var(--muted);
    font-size:     11px;
    font-family:   inherit;
    white-space:   nowrap;
    overflow:      hidden;
    text-overflow: ellipsis;
    cursor:        pointer;

    &:hover:not(:disabled), &--on {
      background: color-mix(in srgb, var(--body-text) 8%, transparent);
      color:      var(--body-text);
    }

    &:disabled { opacity: 0.5; cursor: default; }

    // The command menu. A bare "/" is punctuation until it has an edge, and it belongs beside
    // send rather than adrift between the gap and it. Its geometry is shared with send above.
    &--icon {
      margin-right: 5px;
      border-color: var(--border);
      font-family:  var(--mc-terminal-font, monospace);
      font-size:    13px;

      &:hover { border-color: var(--link); }
    }
  }

  &__chev { flex: 0 0 auto; opacity: 0.8; }

  // The pair at the right of the bar. One variable, one radius, one border width.
  &__pill--icon,
  &__send {
    flex:            0 0 auto;
    display:         flex;
    align-items:     center;
    justify-content: center;
    width:           var(--mc-chat-btn, 30px);
    height:          var(--mc-chat-btn, 30px);
    min-height:      0;
    padding:         0;
    border-width:    1px;
    border-style:    solid;
    border-radius:   6px;
    line-height:     1;
  }

  /*
   * Rancher's stylesheet sizes every `button` on the page, and these are on its page.
   *
   * That is why the model rows and the effort pills came out two and three times their
   * intended height: the shell sets a min-height and a line-height for a form control, this
   * component's buttons are list rows and 11px chips, and nothing here was saying otherwise.
   * Setting the padding and the font size is not enough - the properties that were winning are
   * the ones this never mentioned. So they are named, once, for every button in the pane.
   */
  button {
    min-height:  0;
    margin:      0;
    line-height: 1.35;
    box-shadow:  none;
  }

  // ── The command menu ──
  // A list rather than a floating popup: the panel is narrow and often docked, and an
  // absolutely-positioned menu in here escapes the drawer on a phone. Same metrics as the
  // picker below, because they are the same kind of list opened from the same box.
  &__slash {
    flex:          0 0 auto;
    // Sits on the box: same gutter, no daylight, square where the two meet.
    margin:        0 var(--mc-chat-gutter) -1px;
    padding:       3px;
    list-style:    none;
    max-height:    40vh;
    overflow:      auto;
    border:        1px solid var(--border);
    border-bottom: 0;
    border-radius: 8px 8px 0 0;
    background:    var(--body-bg);

    li { list-style: none; }
  }

  &__slash-item {
    display:       flex;
    gap:           6px;
    align-items:   baseline;
    width:         100%;
    padding:       4px 8px;
    border:        0;
    border-radius: 6px;
    background:    transparent;
    color:         var(--body-text);
    font-size:     12px;
    font-family:   inherit;
    text-align:    left;
    cursor:        pointer;

    &:hover, &--on { background: color-mix(in srgb, var(--link) 14%, transparent); }
  }

  &__slash-name {
    flex:        0 0 auto;
    font-family: var(--mc-terminal-font, monospace);
    font-weight: 600;
  }

  &__slash-help {
    flex:          1 1 auto;
    min-width:     0;
    color:         var(--muted);
    font-size:     11px;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__slash-source {
    flex:           0 0 auto;
    color:          var(--muted);
    font-size:      10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  // Square, at the row's own height: an arrow is a glyph, not a word, and giving it a word's
  // padding is what made it an oval.
  &__navbtn--caret {
    width:      var(--mc-chat-nav, 26px);
    padding:    0;
    font-size:  13px;
  }

  &__takeover {
    flex:          0 0 auto;
    margin:        0 18px 6px;
    padding:       8px 10px;
    border:        1px solid var(--warning);
    border-radius: 8px;
    background:    color-mix(in srgb, var(--warning) 10%, transparent);
    font-size:     12px;
  }

  &__takeover-head {
    display:     flex;
    flex-wrap:   wrap;
    gap:         6px;
    align-items: center;
  }

  &__takeover-head > span { flex: 1 1 auto; min-width: 0; }

  &__takeover-tail {
    margin:      6px 0 0;
    max-height:  84px;
    overflow:    auto;
    color:       var(--muted);
    font-family: var(--mc-terminal-font, monospace);
    font-size:   11px;
    white-space: pre-wrap;
  }

  &__slash-hint {
    flex:      0 0 auto;
    padding:   4px 18px 0;
    font-size: 11px;
    color:     var(--muted);

    &--known { color: var(--success); }
    &--unknown { color: var(--warning); }
  }

  // Whichever menu is open, the box below it loses its top corners so the two read as one.
  &__slash + &__box,
  &__slash-hint + &__box {
    margin-top:              0;
    border-top-left-radius:  0;
    border-top-right-radius: 0;
  }

  // ── The pickers ──
  &__menu {
    flex:          0 0 auto;
    // Zero bottom margin and the box's own top margin removed below: the picker is opened
    // from the box and belongs to it, and 6px of daylight between them read as two panels.
    margin:        0 var(--mc-chat-gutter) -1px;
    padding:       3px;
    border:        1px solid var(--border);
    border-bottom: 0;
    border-radius: 8px 8px 0 0;
    background:    var(--body-bg);
    max-height:    46vh;
    overflow:      auto;
  }

  // The box loses its top corners while a menu is sitting on it.
  &__menu + &__box {
    margin-top:                 0;
    border-top-left-radius:     0;
    border-top-right-radius:    0;
  }

  &__menu-head {
    display:        flex;
    align-items:    baseline;
    gap:            6px;
    margin:         5px 0 1px;
    padding:        0 8px;
    color:          var(--muted);
    font-size:      10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  &__menu-note { text-transform: none; letter-spacing: 0; font-size: 10px; }

  &__menu-item {
    display:       flex;
    align-items:   baseline;
    gap:           6px;
    width:         100%;
    padding:       4px 8px;
    border:        0;
    border-radius: 6px;
    background:    transparent;
    color:         var(--body-text);
    font-size:     12px;
    font-family:   inherit;
    text-align:    left;
    cursor:        pointer;

    &:hover { background: color-mix(in srgb, var(--link) 14%, transparent); }
    &--on { color: var(--link); }
  }

  &__menu-tick {
    flex:      0 0 12px;
    color:     var(--link);
    font-size: 11px;
  }

  &__menu-name { flex: 0 0 auto; }

  &__menu-help {
    flex:          1 1 auto;
    min-width:     0;
    color:         var(--muted);
    font-size:     11px;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  // Effort is a row of its own inside the model picker, because it is a property of the model
  // rather than a second thing to choose - which is how claude's own picker has it.
  &__efforts {
    display:   flex;
    flex-wrap: wrap;
    gap:       4px;
    padding:   2px 8px 6px;
  }

  &__effort {
    padding:       2px 9px;
    line-height:   1.5;
    border:        1px solid var(--border);
    border-radius: 999px;
    background:    transparent;
    color:         var(--muted);
    font-size:     11px;
    font-family:   inherit;
    cursor:        pointer;

    &:hover { border-color: var(--link); color: var(--body-text); }

    &--on {
      border-color: var(--link);
      background:   color-mix(in srgb, var(--link) 16%, transparent);
      color:        var(--body-text);
    }
  }

  &__send {
    // A transparent border rather than none, so the two are the same box: a filled button
    // beside an outlined one is a pixel narrower and shorter otherwise, and side by side that
    // is the difference you can see without being able to name it.
    border-color: transparent;
    background:   var(--link);
    color:        var(--link-text, #fff);
    font-size:    15px;
    cursor:       pointer;

    // Legible rather than ghostly: it is the control somebody is looking for.
    &:disabled {
      background: color-mix(in srgb, var(--link) 30%, transparent);
      color:      color-mix(in srgb, var(--link-text, #fff) 70%, transparent);
      cursor:     default;
    }
  }

  &__mcp {
    display:     flex;
    gap:         8px;
    align-items: baseline;
    padding:     5px 8px;
    font-size:   12px;
  }

  &__mcp-dot {
    flex:          0 0 auto;
    width:         7px;
    height:        7px;
    border-radius: 50%;
    align-self:    center;
    background:    var(--muted);

    &--ok  { background: var(--success); }
    &--bad { background: var(--error); }
  }

  &__mcp-name {
    flex:          1 1 auto;
    min-width:     0;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }


}

.mc-chat {
  &__pick {
    flex:          0 0 auto;
    display:       flex;
    align-items:   center;
    gap:           8px;
    padding:       6px 18px;
    border-bottom: 1px solid var(--border);
    font-size:     11px;
    color:         var(--muted);
  }

  &__pick-btn {
    min-height:    0;
    height:        24px;
    padding:       0 10px;
    font-size:     11px;
    border-radius: 12px;
    border:        1px solid var(--border);
    background:    transparent;
    color:         var(--body-text);
    cursor:        pointer;

    &:hover, &--open { border-color: var(--link); color: var(--link); }
  }

  &__pick-current { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

  &__agents {
    flex:           0 0 auto;
    max-height:     40%;
    overflow:       auto;
    border-bottom:  1px solid var(--border);
    padding:        4px 10px;
    display:        flex;
    flex-direction: column;
    gap:            2px;
  }

  &__agent {
    display:       grid;
    grid-template-columns: 10px minmax(120px, 220px) 1fr auto;
    gap:           8px;
    align-items:   center;
    min-height:    0;
    padding:       4px 8px;
    border:        1px solid transparent;
    border-radius: 6px;
    background:    transparent;
    color:         var(--body-text);
    text-align:    left;
    font-size:     12px;
    cursor:        pointer;

    &:hover { background: color-mix(in srgb, var(--body-text) 5%, transparent); }
    &--on { border-color: var(--link); }
  }

  &__agent-dot {
    width:         8px;
    height:        8px;
    border-radius: 50%;
    background:    var(--muted);
    opacity:       0.5;
  }
  &__agent--working &__agent-dot { background: var(--link); opacity: 1; animation: mc-chat-pulse 1.4s infinite ease-in-out; }

  &__agent-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  &__agent-last { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  &__agent-when { color: var(--muted); font-size: 11px; }

  /*
   * The row that floats over the bottom of the log.
   *
   * It spans the pane rather than hugging the right edge, so the caret keys sit on the left -
   * under the thumb that is about to reach into the message box below them - and the ones that
   * move the log stay on the right where they were. Bunched together on the right they read as
   * one group of four, which they are not: two act on the box and two act on the log.
   */
  /*
   * A row of its own, between the log and the prompt box.
   *
   * It used to float over the log at a fixed offset from the bottom, which meant it sat on
   * whatever line of the conversation happened to be there - a message with buttons through
   * it, and text under a control that could not be read or clicked. Being absolute also meant
   * that offset was a guess about the height of everything below it, and every change to the
   * composer made the guess wrong again.
   *
   * In the column it takes the room it needs and nothing is underneath it.
   */
  &__nav {
    flex:            0 0 auto;
    display:         flex;
    justify-content: flex-end;
    align-items:     center;
    // Enough to read as two pairs rather than four buttons, and the same step the prompt box's
    // own controls use.
    gap:             5px;
    // Flush with the box below: the arrows sit over its left edge and the log controls over
    // its right, so the row reads as belonging to it rather than hovering near it. The bottom
    // padding is the gap between the two, which there was none of.
    // The gap under the row is the gutter beside it: the buttons sit the same distance from
    // the box as they do from the edges of the page, which is the only spacing here that does
    // not need a reason.
    padding:         2px var(--mc-chat-gutter) var(--mc-chat-gutter);
  }

  // Everything after the caret keys goes to the right; they stay at the left.
  &__navbtn--caret + :not(&__navbtn--caret) { margin-left: auto; }

  /*
   * The controls that float over the log.
   *
   * They were 24px pills with a 12px radius - fully round ends - which made the two arrows
   * into wide ovals beside two word-shaped ones, four different silhouettes in a row of four.
   * Now they are one height, one radius and one padding, the arrows are square at that height,
   * and the two groups are separated by the gap between them rather than by being different
   * shapes.
   *
   * 26px matches the prompt box's own buttons below, so a glance down the right-hand edge sees
   * one size rather than three.
   */
  &__navbtn {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    min-height:      0;
    height:          var(--mc-chat-nav, 26px);
    padding:         0 10px;
    font-size:       11px;
    line-height:     1;
    border-radius:   6px;
    border:          1px solid var(--border);
    background:      var(--body-bg);
    color:           var(--muted);
    cursor:          pointer;
    opacity:         0.85;

    &:hover { opacity: 1; color: var(--link); border-color: var(--link); }
    &--bottom { color: var(--link); opacity: 1; }
  }

  &__msg--summary {
    background:   color-mix(in srgb, var(--warning) 8%, transparent);
    border-color: color-mix(in srgb, var(--warning) 30%, transparent);
  }

  &__summary-line {
    color:         var(--muted);
    white-space:   nowrap;
    overflow:      hidden;
    text-overflow: ellipsis;
  }

  &__msg--found { box-shadow: 0 0 0 2px var(--link); }
}

/* ── Phones ──
   760px, the breakpoint the rest of this extension already uses (PodTerminal's font switch,
   and the Dev extension's whole mobile sheet).

   What is wrong at this width is not the layout, which is a column and stays one. It is that
   every horizontal measurement in here was chosen for a docked panel on a desktop: 18px of
   padding either side of the log plus 16px inside each message plus a 36px indent on your own
   messages spends 88px of a 390px screen on nothing, and the text that is left wraps every
   four or five words. So the gutters come in, the indent becomes a hint rather than a margin,
   and the vertical rhythm is kept - the room saved goes to the words. ── */
@media (max-width: 760px) {
  .mc-chat {
    &__log { padding: 30px var(--mc-chat-gutter) 6px; }

    &__msg {
      margin:        0 0 12px;
      padding:       9px 11px 9px 12px;
      border-radius: 8px;
    }

    /* Enough to tell the two apart at a glance, which is all the indent was ever doing; the
       colour and the "You" label do the rest. */
    &__msg--user { margin-left: 14px; }

    /* Three items on one line - who, when, and whether it is queued - do not fit beside a
       timestamp at this width, and __meta already wraps. This keeps the wrap tidy. */
    &__meta { gap: 6px; }

    /* The menus and the box share the page's gutter, which is 10px here rather than 18. */
    --mc-chat-gutter: 10px;

    &__slash-help { display: none; }
    &__slash-hint { padding: 4px 10px 0; }

    &__box { margin: 0 var(--mc-chat-gutter) 10px; }

    /* The controls stay on one row: two names, then the command menu and send. The model name
       is the one that can be long, so it is the one that gets the room and the ellipsis. */
    &__bar { padding: 2px 4px 4px; }
    &__pill { max-width: 34%; }

    /* Thumb-sized. 26px is right beside a 13px control on a desktop and too small to hit on
       glass, and these two are the controls somebody uses on every message. */
    // Thumb-sized, and all of them from the same two variables so they cannot drift apart.
    --mc-chat-btn: 36px;
    --mc-chat-nav: 32px;

    &__send { font-size: 17px; }
    &__pill--icon { font-size: 15px; }
    &__navbtn { padding: 0 12px; }

    &__textarea { min-height: 44px; padding: 8px 10px 2px; }

    &__status { padding: 4px 10px; }

    /* The subagent list: name, last words and time on one row is three columns in 370px. */
    &__agents { padding: 0 10px; }

    &__agent {
      flex-wrap: wrap;
      gap:       4px 8px;
    }

    &__agent-last {
      flex-basis: 100%;
      order:      3;
    }

    &__pick { padding: 6px 10px; }

    /* A wide tool result or a code block scrolls in its own box rather than widening the
       message, which on a phone widens the page. */
    &__pre,
    &__md pre {
      max-width: 100%;
      overflow-x: auto;
    }
  }
}

@keyframes mc-chat-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(0.6); opacity: 0.5; }
}

@keyframes mc-chat-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.35; }
  40% { transform: translateY(-4px); opacity: 1; }
}

@keyframes mc-chat-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
