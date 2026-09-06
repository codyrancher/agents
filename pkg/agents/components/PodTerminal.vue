<script>
// A terminal onto a pod - the agent pod, unless told otherwise - modelled on the Claude Harness's.
//
// The harness runs a node-pty per browser socket, and that pty's command is
// `tmux new-session -A` running claude in a loop. There is no server to run one
// here, so the pty comes from Kubernetes instead: the exec subresource gives a
// real TTY in the pod, through Rancher's cluster proxy, authenticated by the
// session cookie the page already has. Everything on the far side of it is the
// same idea, and lives in seed/pod/: tmux for a session that outlives
// the browser tab, and claude looping inside it.
//
// The protocol is `base64.channel.k8s.io`, which is what the dashboard's own
// container shell speaks: each frame is a channel digit followed by base64.
// Channel 0 is stdin, 1 stdout, 2 stderr, 3 error, and 4 carries a JSON
// {Width, Height} on resize.
import { allHash } from '@shell/utils/promise';
import { base64Decode, base64Encode } from '@shell/utils/crypto';
import Socket, {
  EVENT_CONNECTED,
  EVENT_CONNECTING,
  EVENT_DISCONNECTED,
  EVENT_MESSAGE,
  EVENT_CONNECT_ERROR,
} from '@shell/utils/socket';
import { execUrl, writeImageToPod, EXT_NS, AGENT_CONTAINER } from '../pod';
import { agentPod, sessionCommand } from '../agent';
import PodFileViewer from './PodFileViewer';

// The dashboard's own build pulls this in globally; an extension's does not, so
// without it a built extension renders the terminal unstyled.
import '@xterm/xterm/css/xterm.css';

// Channel prefixes, as above.
const STDIN = '0';
const STDOUT = '1';
const STDERR = '2';
const ERROR = '3';
const RESIZE = '4';

// How often to look for a running pod while there isn't one. A cold pod is
// pulling an image and installing, so this is a wait of a minute or two.
const POD_POLL_MS = 3000;

// Where a pasted image lands in the agent pod: its writable tree, and the one its own shell
// starts in, is /workspace, owned by the same uid the exec drops to. Dotted, so it stays out of
// the file browser that lists it. Another pod says where its own goes (the `imageDir` prop).
const AGENT_IMAGE_DIR = '/workspace/.images';
const AGENT_HOME = '/workspace/.home';

const URL_RE = /\bhttps?:\/\/[^\s"'`<>()[\]]+/g;
// A path has to contain a separator, so a bare word, a flag, or a sentence is never a link. The
// optional :line:col suffix is stripped off the opened path but kept in the underlined text,
// because that is how an agent prints a location and how a person expects to click it.
// The character before a path only has to be one a path cannot contain. The narrower class this
// used to be - whitespace and a few brackets - missed every path a TUI draws hard against its own
// frame: `__/workspace/.images/shot.png` at a composer's left edge matched nothing at all. Letters
// and digits still block a match, so `and/or` in a sentence stays prose.
const PATH_RE = /(?:^|[^A-Za-z0-9.@+\-])((?:~|\.{1,2})?\/[\w.@+\-]+(?:\/[\w.@+\-]+)*\/?|[A-Za-z0-9][\w.@+\-]*(?:\/[\w.@+\-]+)+\/?)(?::\d+(?::\d+)?)?/g;
// What a slash between words is not: a date, a fraction, and the few English constructions
// that use one. Without this every "and/or" in a sentence lights up as a file.
const NOT_A_PATH = /^(?:\d+\/\d+(?:\/\d+)?|(?:and|or|either|his|her|its|s?he|yes|no|on|off|true|false|w|n|km|mi)\/[a-z]{1,3})$/i;
// Trailing punctuation belongs to the sentence the path sits in, not to the name.
const TRAILING = /[.,;:!?)\]}'"`]+$/;


// A box border in the last column belongs to the TUI's frame, not to the sentence: collapsing it
// inward would visibly bend the composer's box, so it is left where the terminal drew it.
// A grid smaller than this is a measurement taken before the box was laid out, not a real size.
const MIN_COLS = 20;
const MIN_ROWS = 5;

// A phone at 13px gets about twenty columns - far too narrow for a TUI that assumes eighty. Nine
// gets it to a usable width without becoming unreadable. Matched live rather than measured once,
// so rotating the phone or resizing a window re-fits.
const MOBILE_TERMINAL = '(max-width: 760px)';
const mobileQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(MOBILE_TERMINAL) : null;

function terminalFontSize() {
  return mobileQuery?.matches ? 9 : 13;
}

// How far one wheel notch scrolls tmux's scrollback on a touch drag.
const TOUCH_LINE_PX = 24;















// The row a phone keyboard is missing. Termux, Blink and iSH all ship one for
// the same reason: without arrows there is no way to go back and fix a typo,
// and without Esc there is no way out of a menu.
const KEY_BAR = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  {
    label: '\u2190', seq: '\x1b[D', title: 'Left'
  },
  {
    label: '\u2192', seq: '\x1b[C', title: 'Right'
  },
  {
    label: '\u2191', seq: '\x1b[A', title: 'Up / previous'
  },
  {
    label: '\u2193', seq: '\x1b[B', title: 'Down / next'
  },
  {
    label: '\u21e4', seq: '\x01', title: 'Start of line (Ctrl+A)'
  },
  {
    label: '\u21e5', seq: '\x05', title: 'End of line (Ctrl+E)'
  },
  {
    label: '\u232b', seq: '\x17', title: 'Delete the word before the cursor (Ctrl+W)'
  },
  {
    label: '\u21b5', seq: '\r', title: 'Enter'
  },
];

/**
 * The control code for a letter, so an armed Ctrl can be applied to it.
 */
function ctrlByteFor(key) {
  if (key.length !== 1) {
    return null;
  }

  const code = key.toUpperCase().charCodeAt(0);

  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
}

export default {
  name: 'PodTerminal',

  components: { PodFileViewer },

  props: {
    // Which conversation to attach to, when it is one of the agent pod's. One pane, one
    // session; it is a prop so a second pane would be a second conversation rather than a fight
    // over one.
    session: {
      type:    String,
      default: 'agent-1',
    },

    // What the pane runs: the assistant's claude session, or a plain login shell.
    mode: {
      type:      String,
      default:   'claude',
      validator: (value) => ['claude', 'shell'].includes(value),
    },

    // What to exec, spelled out, instead of the session/mode pair above. Another extension
    // placing this pane somewhere of its own - a workspace's conversation list, a pull request's
    // review, Extension Studio's editor over one of its dev-server pods - says exactly what it
    // wants run and where. Every pane is the same xterm, the same protocol, the same reconnect,
    // the same image paste and clickable paths; only what runs and in which pod differ, and
    // those are these four props.
    command: {
      type:    Array,
      default: null,
    },

    // Which pod, found rather than named: a pod's name changes across a restart and the pane
    // is expected to survive that by finding the new one. Async, answers the pod's name or null
    // while there is none. The agent pod unless told otherwise.
    findPod: {
      type:    Function,
      default: null,
    },

    namespace: {
      type:    String,
      default: EXT_NS,
    },

    container: {
      type:    String,
      default: AGENT_CONTAINER,
    },

    // Where a pasted image is written in that pod, and the pane's home there (the user the
    // exec drops to reads it).
    imageDir: {
      type:    String,
      default: AGENT_IMAGE_DIR,
    },

    home: {
      type:    String,
      default: AGENT_HOME,
    },

    // What the overlay says while there is no pod, and what the pod is called in messages.
    waitingText: {
      type:    String,
      default: 'Waiting for the agent pod',
    },

    label: {
      type:    String,
      default: 'the agent',
    },
  },

  // The connection's state, for whatever is drawing a dot for it - the Studio's session row.
  emits: ['state'],

  watch: {
    state: {
      immediate: true,
      handler(v) {
        this.$emit('state', v);
      },
    },
  },

  data() {
    return {
      KEY_BAR,
      // 'waiting' (no pod yet) | 'connecting' | 'open' | 'closed'
      state:        'waiting',
      // The path a clicked link opened, and the pod to read it from.
      viewerPath:   '',
      viewerPod:    '',
      fitFrame:     0,
      settleTimer:  null,
      kbInset:      0,
      touchY:       0,
      touchAcc:     0,
      // Set while an image is on its way into the pod, and if it failed to get there.
      pasting:      false,
      imageError:   '',
      error:        '',
      terminal:     null,
      fitAddon:     null,
      socket:       null,
      // Input typed before the socket opened, replayed on connect.
      backlog:      [],
      resizeObserver: null,
      podPollTimer: null,
      unmounted:    false,
      // Touch only: the keys a phone keyboard does not have, which are most of
      // what a TUI is driven with.
      showKeyBar:   false,
      ctrlArmed:    false,
      dprTimer:     null,
    };
  },

  computed: {
    /** Which pod this pane is for, as the file viewer and the image writer address it. */
    podTarget() {
      return {
        pod: this.viewerPod, container: this.container, namespace: this.namespace, home: this.home,
      };
    },

    statusText() {
      return {
        waiting:    this.waitingText,
        connecting: 'Connecting',
        closed:     'Disconnected',
      }[this.state] || '';
    },
  },

  async mounted() {
    // A handle for looking at what this pane believes: which images it has read, which it gave
    // up on, what the grid is. Cheap, and the alternative is guessing from the outside.
    if (this.$el) {
      this.$el.__mcTerm = this;
    }

    await this.setupTerminal();
    this.connectWhenPodIsUp();

    // A socket that dropped while nobody was looking is the common case: a laptop sleeps, a tab
    // sits in the background for an hour, the pod restarts. Coming back to the tab is exactly
    // when somebody wants the session, so that is when it is reattached - rather than leaving
    // them to notice the dead pane and press a button.
    this.onRefocus = () => {
      this.reconnectIfDropped();
      // Coming back to the tab is also when a stale grid shows itself, so re-measure.
      this.settleFits();
    };
    this.onViewport = () => this.onViewportResize();
    this.onFontQuery = () => this.onFontSizeQuery();
    window.visualViewport?.addEventListener('resize', this.onViewport);
    window.visualViewport?.addEventListener('scroll', this.onViewport);
    mobileQuery?.addEventListener?.('change', this.onFontQuery);
    this.$refs.xterm?.addEventListener('touchstart', this.onTouchStartBound = (e) => this.onTouchStart(e), { passive: true });
    this.$refs.xterm?.addEventListener('touchmove', this.onTouchMoveBound = (e) => this.onTouchMove(e), { passive: false });
    // The layout is not settled the moment this mounts: measure again once it is.
    this.settleFits();
    window.addEventListener('focus', this.onRefocus);
    document.addEventListener('visibilitychange', this.onRefocus);
    this.$refs.xterm?.addEventListener('focusin', this.onRefocus);
  },

  beforeUnmount() {
    this.unmounted = true;
    clearTimeout(this.settleTimer);
    cancelAnimationFrame(this.fitFrame);
    window.visualViewport?.removeEventListener('resize', this.onViewport);
    window.visualViewport?.removeEventListener('scroll', this.onViewport);
    mobileQuery?.removeEventListener?.('change', this.onFontQuery);
    this.$refs.xterm?.removeEventListener('touchstart', this.onTouchStartBound);
    this.$refs.xterm?.removeEventListener('touchmove', this.onTouchMoveBound);
    window.removeEventListener('focus', this.onRefocus);
    document.removeEventListener('visibilitychange', this.onRefocus);
    this.$refs.xterm?.removeEventListener('focusin', this.onRefocus);
    clearTimeout(this.podPollTimer);
    clearInterval(this.dprTimer);
    this.resizeObserver?.disconnect();
    // Only this end goes away. The tmux session in the pod keeps running, which
    // is the whole point of it: reopening the editor reattaches to it.
    this.socket?.disconnect();
    this.terminal?.dispose();
  },

  methods: {
    /**
     * Type something at the prompt on the user's behalf, then put them back
     * where they were: focused, and at the bottom of the scrollback.
     */
    sendKeys(data) {
      this.send(STDIN + base64Encode(data));
      this.terminal?.scrollToBottom();
      this.terminal?.focus();
    },

    tapKey(seq) {
      this.sendKeys(seq);
      this.ctrlArmed = false;
    },

    // Sticky rather than held: a touch screen has no chords, so Ctrl applies to
    // whatever is typed next.
    armCtrl() {
      this.ctrlArmed = !this.ctrlArmed;
      this.terminal?.focus();
    },

    /**
     * Is the canvas drawing at the display's resolution? Its backing store has
     * to be its CSS size times the device pixel ratio; anything else is the
     * browser rescaling a bitmap, which is what soft glyphs actually are.
     */
    canvasScaleWrong() {
      const canvas = this.$refs.xterm?.querySelector('canvas.xterm-text-layer');

      if (!canvas) {
        return false;
      }

      const rect = canvas.getBoundingClientRect();

      if (rect.width < 20 || rect.height < 20) {
        return false;
      }

      const dpr = window.devicePixelRatio || 1;

      return Math.abs((canvas.width / rect.width) - dpr) > 0.05
        || Math.abs((canvas.height / rect.height) - dpr) > 0.05;
    },

    async setupTerminal() {
      const style = getComputedStyle(document.body);
      const color = (name) => style.getPropertyValue(name).trim() || undefined;

      const xterm = await import(/* webpackChunkName: "xterm" */ '@xterm/xterm');
      const addons = await allHash({
        fit:    import(/* webpackChunkName: "xterm" */ '@xterm/addon-fit'),
        canvas: import(/* webpackChunkName: "xterm" */ '@xterm/addon-canvas'),
      });

      const terminal = new xterm.Terminal({
        allowProposedApi: true,
        cursorBlink:      true,
        fontSize:         terminalFontSize(),
        // Harness Terminal is bundled with the extension (assets/fonts). The
        // rest of the list is what a browser has anyway, for the moment before
        // the webfont loads and for the case where it failed to.
        fontFamily:       '"Harness Terminal", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        // Rancher's own terminal colours, so this matches the dashboard's theme
        // and follows it between light and dark.
        theme:            {
          background:          color('--terminal-bg'),
          foreground:          color('--terminal-text'),
          cursor:              color('--terminal-cursor'),
          selectionBackground: color('--terminal-selection'),
        },
      });

      this.fitAddon = new addons.fit.FitAddon();
      terminal.loadAddon(this.fitAddon);
      // Canvas rather than webgl: this pane sits next to an iframe running a
      // whole second dashboard, and webgl contexts are a limited resource.
      terminal.loadAddon(new addons.canvas.CanvasAddon());

      // tmux emits the selection as OSC 52 when a drag ends (see pod/tmux.conf),
      // which is what makes drag-select copy to the browser clipboard. Without
      // a handler the sequence is silently dropped.
      terminal.parser.registerOscHandler(52, (payload) => {
        const encoded = payload.split(';')[1];

        try {
          navigator.clipboard?.writeText(base64Decode(encoded));
        } catch { /* clipboard permission, or a payload that isn't base64 */ }

        return true;
      });

      terminal.open(this.$refs.xterm);
      terminal.onData((input) => this.send(STDIN + base64Encode(input)));

      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') {
          return true;
        }

        // Ctrl/Cmd+V is read off the clipboard directly. xterm handles the keystroke itself and
        // no `paste` event follows it, so the DOM listener below never sees a screenshot pasted
        // the ordinary way - which is the way everybody pastes one. Text is left alone: this
        // only claims the keystroke when the clipboard actually holds an image.
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'v') {
          this.pasteFromClipboard();
        }

        // Ctrl armed from the key bar applies to the next character typed:
        // there is no chord on a touch screen.
        if (this.ctrlArmed) {
          const byte = ctrlByteFor(event.key);

          if (byte) {
            event.preventDefault();
            this.ctrlArmed = false;
            this.sendKeys(byte);

            return false;
          }
        }

        // Shift+Enter inserts a newline instead of submitting, so a list can be
        // typed into the assistant's composer.
        if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault();
          this.sendKeys('\x1b\r');

          return false;
        }

        return true;
      });

      // A phone has no arrows, Esc, Tab or Ctrl, and those are how a TUI is
      // driven. Every mobile terminal grows this row for the same reason.
      this.showKeyBar = window.matchMedia?.('(pointer: coarse)').matches || false;

      // The canvas renderer sizes its backing store by devicePixelRatio when it
      // lays out. Change the ratio afterwards - browser zoom, or a window moved
      // to a display with a different scale - and it keeps drawing at the old
      // resolution, which the browser then rescales: the terminal goes soft
      // while everything around it stays sharp. Some of those changes arrive
      // with no event to hang this off, so it is a slow check rather than a
      // listener.
      this.dprTimer = setInterval(() => {
        if (document.hidden || !this.canvasScaleWrong()) {
          return;
        }

        this.terminal?.clearTextureAtlas?.();
        this.fit();
      }, 2000);

      // An image pasted or dropped on the pane becomes a file in the pod, and its path is
      // typed at the prompt. That is the whole trick: claude reads an image from a path, so
      // handing it one is the same thing as attaching it. xterm's own paste handling only ever
      // sees text, which is why this listens on the element rather than through the terminal.
      const pane = this.$refs.xterm;

      // Capture, not bubble. xterm's paste handler lives on the textarea inside this element and
      // calls stopPropagation, so a listener here never sees a real Ctrl+V - only the synthetic
      // events a test dispatches at this element directly, which is exactly how this looked
      // tested and was not. Capture runs on the way down, ahead of xterm.
      pane.addEventListener('paste', (event) => this.onImages(event, event.clipboardData), true);
      pane.addEventListener('dragover', (event) => event.preventDefault());
      pane.addEventListener('drop', (event) => this.onImages(event, event.dataTransfer));

      this.terminal = terminal;

      // Paths and URLs the session prints become links. xterm's own provider is what the
      // harness terminal uses and it activates fine with tmux mouse reporting on - an overlay
      // of anchors over the screen does not, because it takes the clicks that focus the
      // terminal and typing stops working.
      terminal.registerLinkProvider({ provideLinks: (row, callback) => callback(this.linksFor(row, terminal)) });


      // The pane is resizable (the editor's divider) and the window is too, so
      // the size is watched rather than taken once.
      this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
      this.resizeObserver.observe(this.$refs.xterm);
      this.fit();
    },

    // Wait for a pod, then connect. It is a wait rather than an error because the pod is made
    // for us: the editor will not mount this pane until the install has reported the Deployment
    // exists. This used to call ensureExtension itself, which made the object the checklist was
    // about to report on and so kept the install invisible - the same mistake in three places.
    async connectWhenPodIsUp() {

      // Whatever went wrong last time is over: this is a fresh wait, and the
      // error belongs to the connection that ended. Left in place, the exec
      // subresource's parting shot when a pod is killed ("exit code 137") would
      // sit there as the status forever, because the overlay shows the error in
      // preference to the state and nothing else clears it until a socket
      // opens, which cannot happen while there is no pod.
      this.error = '';

      while (!this.unmounted) {
        const pod = await this.locatePod();

        if (pod) {
          this.connect(pod);

          return;
        }

        this.state = 'waiting';
        await new Promise((resolve) => {
          this.podPollTimer = setTimeout(resolve, POD_POLL_MS);
        });
      }
    },

    /** The pod, from whoever knows how to find it; the agent pod by default. */
    async locatePod() {
      try {
        return this.findPod ? await this.findPod() : await agentPod();
      } catch {
        return null;
      }
    },

    connect(pod) {
      const argv = this.command?.length ? this.command : sessionCommand(this.session, this.mode);
      const url = execUrl(pod, argv, true, this.container, this.namespace);
      const socket = new Socket(url, false, 0, 'base64.channel.k8s.io');

      socket.addEventListener(EVENT_CONNECTING, () => {
        this.state = 'connecting';
        this.error = '';
      });

      socket.addEventListener(EVENT_CONNECTED, () => {
        this.state = 'open';
        this.fit();
        this.flush();
        this.terminal?.focus();
      });

      socket.addEventListener(EVENT_CONNECT_ERROR, () => {
        this.state = 'closed';
        this.error = 'Could not open a shell in the pod';
      });

      socket.addEventListener(EVENT_DISCONNECTED, () => {
        this.state = 'closed';
      });

      socket.addEventListener(EVENT_MESSAGE, (event) => {
        const data = event.detail.data;
        const channel = data.substr(0, 1);
        const message = base64Decode(data.substr(1));

        // stdout and stderr are both the pane; there is one TTY behind them.
        if (channel === STDOUT || channel === STDERR) {
          this.terminal?.write(message);

          return;
        }

        if (channel === ERROR && message) {
          // Not output: a Status object saying how the exec ended. Printing it
          // would put `{"status":"Success"}` on screen every time a shell exits
          // normally, so only a failure is worth surfacing, and as a status
          // rather than as terminal output.
          try {
            const status = JSON.parse(message);

            if (status.status !== 'Success') {
              this.error = status.message || 'The shell exited with an error';
            }
          } catch {
            this.error = message;
          }
        }
      });

      this.socket = socket;
      socket.connect();
    },

    // Reconnecting is reattaching: tmux still has the session, so this picks up
    // where it left off rather than starting anything.
    /**
     * Reattach, but only if this end is actually dead.
     *
     * Focus fires for every click into the pane and every tab switch, and tearing down a healthy
     * socket on each of those would drop the session it is meant to protect. `waiting` is a pod
     * that has not come up yet and `connecting` is already on its way, so neither is ours to
     * restart either.
     */
    reconnectIfDropped() {
      if (this.unmounted || document.hidden || this.state !== 'closed') {
        return;
      }

      this.reconnect();
    },

    async reconnect() {
      await this.socket?.disconnect();
      this.socket = null;
      this.terminal?.reset();
      this.connectWhenPodIsUp();
    },

    /**
     * The whole logical line a row belongs to, and how to get back from it to the screen.
     *
     * A path or a URL longer than the pane wraps, and xterm keeps the continuation in the next
     * row with `isWrapped` set. Reading one row at a time therefore sees two halves of a name
     * and matches neither - or worse, matches each half as a link to something that does not
     * exist. Rows in a wrapped run are exactly `cols` wide, so an index into the joined text maps
     * straight back to a row and a column.
     */
    logicalLine(terminal, row) {
      const buf = terminal.buffer.active;
      let first = row;

      while (first > 1 && buf.getLine(buf.viewportY + first - 1)?.isWrapped) {
        first -= 1;
      }

      let text = '';
      let last = first;

      for (let r = first; r <= terminal.rows; r++) {
        const line = buf.getLine(buf.viewportY + r - 1);

        if (!line || (r > first && !line.isWrapped)) {
          break;
        }

        const next = buf.getLine(buf.viewportY + r);
        const continues = !!next?.isWrapped;

        // Every row but the last in the run is full width, so it is taken untrimmed - trimming
        // would lose the columns that make the index arithmetic work.
        text += continues ? line.translateToString(false) : line.translateToString(true);
        last = r;

        if (!continues) {
          break;
        }
      }

      return {
        text,
        first,
        last,
        at: (index) => ({ row: first + Math.floor(index / terminal.cols), col: index % terminal.cols }),
      };
    },

    /**
     * The links on a row: every URL, and every path that looks like one on purpose.
     *
     * Matched against the whole logical line, so a name that wrapped is one link rather than two
     * broken halves. The range can span rows, which is what makes the underline continue onto
     * the next one and either half open the same thing.
     */
    linksFor(row, terminal) {
      const line = terminal.buffer.active.getLine(row - 1);

      if (!line) {
        return undefined;
      }

      const logical = this.logicalLine(terminal, row);
      const { text } = logical;
      const links = [];
      const taken = [];
      const add = (raw, index, activate) => {
        if (taken.some(([s2, e2]) => index < e2 && s2 < index + raw.length)) {
          return;
        }

        taken.push([index, index + raw.length]);

        const from = logical.at(index);
        const to = logical.at(index + raw.length - 1);

        // Only offer it on the rows it actually covers: xterm asks per row, and a link claiming
        // rows it does not touch would underline text it has nothing to do with.
        if (row < from.row || row > to.row) {
          return;
        }

        links.push({
          range: {
            start: { x: from.col + 1, y: from.row }, end: { x: to.col + 1, y: to.row },
          },
          text:        raw,
          decorations: { pointerCursor: true, underline: true },
          activate,
        });
      };

      URL_RE.lastIndex = 0;
      for (let hit = URL_RE.exec(text); hit; hit = URL_RE.exec(text)) {
        const raw = hit[0].replace(TRAILING, '');

        add(raw, hit.index, (_event, t) => window.open(t, '_blank', 'noopener'));
      }

      PATH_RE.lastIndex = 0;
      for (let hit = PATH_RE.exec(text); hit; hit = PATH_RE.exec(text)) {
        const raw = (hit[1] || '').replace(TRAILING, '');
        const index = hit.index + hit[0].indexOf(hit[1] || '');

        if (raw.length < 3 || NOT_A_PATH.test(raw)) {
          continue;
        }

        // A relative path has to look like one: a file with an extension, or deep enough that it
        // cannot be a sentence with a slash in it.
        const rooted = /^[~/.]/.test(raw);
        const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(raw);
        const depth = (raw.match(/\//g) || []).length;

        if (!rooted && !hasExt && depth < 2) {
          continue;
        }

        // The line reference an agent appends (file.ts:253) is not part of the name.
        add(raw, index, (_event, t) => this.openPath(t.replace(/:\d+(?::\d+)?$/, '')));
      }

      return links.length ? links : undefined;
    },










    /**
     * The clipboard, for when the keystroke never becomes a paste event this can see.
     *
     * Reading it needs permission the browser may refuse; saying so beats the silence that made
     * a refused read look like nothing had happened at all.
     */
    async pasteFromClipboard() {
      try {
        const items = await navigator.clipboard.read();

        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));

          if (!type) {
            continue;
          }

          const blob = await item.getType(type);

          await this.onImages({ preventDefault: () => {} }, { files: [new File([blob], 'clipboard', { type })] });

          return;
        }
      } catch (e) {
        this.imageError = `could not read the clipboard: ${ e.message || e }`;
        setTimeout(() => {
          this.imageError = '';
        }, 6000);
      }
    },

    /** Open a path from this session's own pod. */
    async openPath(path) {
      const pod = await this.locatePod();

      if (!pod) {
        return;
      }

      this.viewerPod = pod;
      this.viewerPath = path;
    },

    async onImages(event, source) {
      const files = [...(source?.files || [])].filter((file) => file.type.startsWith('image/'));

      if (!files.length) {
        return;
      }

      event.preventDefault();
      this.imageError = '';

      // The same pod the session is attached to, resolved the same way the socket resolves it,
      // so an image lands in the filesystem the shell on screen is actually looking at.
      const pod = await this.locatePod();

      if (!pod) {
        this.imageError = 'no running pod to write the image to';

        return;
      }

      for (const file of files) {
        // Named for when it arrived rather than what the clipboard called it: a pasted
        // screenshot is usually called `image.png` every single time.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const extension = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '');
        const path = `${ this.imageDir }/${ stamp }.${ extension }`;

        try {
          this.pasting = true;
          await writeImageToPod(
            {
              pod, container: this.container, namespace: this.namespace, home: this.home,
            },
            path, await file.arrayBuffer(), this.label,
          );
          // A trailing space, so a second image or a sentence after it does not run together
          // with the path.
          this.send(STDIN + base64Encode(`${ path } `));
        } catch (e) {
          this.imageError = e.message || String(e);
        } finally {
          this.pasting = false;
        }
      }
    },

    send(frame) {
      if (this.state === 'open') {
        this.socket.send(frame);
      } else {
        this.backlog.push(frame);
      }
    },

    /**
     * Type a line into the session from outside it, as the Studio composer does.
     *
     * This is exactly what a person typing the same words would produce - stdin, then a
     * carriage return - so claude cannot tell the two apart, and neither can the terminal:
     * the text appears in the scrollback the way anything else typed does.
     *
     * `\r` rather than `\n`, matching what xterm sends for Enter. A newline reaches most
     * readline implementations as a literal rather than as a submit.
     */
    sendText(text) {
      if (!text) {
        return;
      }

      this.send(STDIN + base64Encode(`${ text }\r`));
    },

    flush() {
      const backlog = this.backlog;

      this.backlog = [];
      backlog.forEach((frame) => this.socket.send(frame));
    },

    fit() {
      // Measuring a box that is not laid out yet is how the grid ends up a sliver and stays
      // there: fit() commits an 11x5 grid quite happily, and nothing measures again until
      // something forces a resize. Skip until there is a real box.
      const box = this.$refs.xterm?.getBoundingClientRect();

      if (!this.fitAddon || !box || box.width < 40 || box.height < 20) {
        return;
      }

      try {
        this.fitAddon.fit();
        this.sendResize();
      } catch { /* a fit against a box mid-layout */ }
    },

    sendResize() {
      if (this.state !== 'open' || !this.terminal) {
        return;
      }

      const { cols, rows } = this.terminal;

      // A grid this small is a bad measurement, and telling tmux about it makes it repaint the
      // pane at that size - which is the state somebody then has to resize the window to escape.
      if (!cols || !rows || cols < MIN_COLS || rows < MIN_ROWS) {
        return;
      }

      this.send(RESIZE + base64Encode(JSON.stringify({ Width: Math.floor(cols), Height: Math.floor(rows) })));
    },

    /**
     * Re-fitting alone does not repair a bad paint.
     *
     * FitAddon.fit() only resizes when the computed grid DIFFERS from what the terminal already
     * has, so a terminal that measured its box while the font or the canvas was not ready keeps
     * its wrong-looking output for ever: every later fit is a no-op. That is why the fix has
     * always been to resize the window by hand.
     *
     * So this does three things a fit cannot: re-measure the character cell, drop the glyph
     * cache, and repaint every row.
     */
    revive() {
      if (!this.terminal) {
        return;
      }

      try {
        this.terminal.clearTextureAtlas?.();
      } catch { /* older xterm */ }
      try {
        this.terminal._core?._charSizeService?.measure?.();
      } catch { /* private, and allowed to move */ }

      const box = this.$refs.xterm?.getBoundingClientRect();
      const dims = box && box.width >= 40 && box.height >= 20 ? this.fitAddon?.proposeDimensions() : null;

      if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows) && dims.cols >= MIN_COLS && dims.rows >= MIN_ROWS) {
        try {
          if (dims.cols !== this.terminal.cols || dims.rows !== this.terminal.rows) {
            this.terminal.resize(dims.cols, dims.rows);
          } else {
            // The numbers already match, so resize() would decline. Bounce by a column and back:
            // that is a real relayout, which re-sizes the renderer's canvas as well as the grid,
            // and is exactly what dragging the window edge did by hand.
            this.terminal.resize(Math.max(MIN_COLS, dims.cols - 1), dims.rows);
            this.terminal.resize(dims.cols, dims.rows);
          }

          this.sendResize();
        } catch { /* ignore */ }
      }

      try {
        this.terminal.refresh(0, this.terminal.rows - 1);
      } catch { /* ignore */ }
    },

    /** Coalesce the several triggers into one pass per frame. */
    scheduleFit(hard = false) {
      if (this.fitFrame) {
        return;
      }

      this.fitFrame = requestAnimationFrame(() => {
        this.fitFrame = 0;

        if (hard) {
          this.revive();
        } else {
          this.fit();
        }
      });
    },

    /**
     * Becoming visible is not one moment: the element is inserted, the flex layout settles, the
     * font resolves, and the first frame paints - each a chance to measure too early. One revive
     * once the layout has had a frame or two, rather than a burst of them, which is four chances
     * to be right and four visible flashes.
     */
    settleFits() {
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.scheduleFit(true), 150);
    },

    /** The phone keyboard must never bury the line being typed. */
    onViewportResize() {
      const vv = window.visualViewport;
      const el = this.$refs.xterm;

      if (!vv || !el) {
        return;
      }

      const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));

      // Ignore the small continuous changes a scroll produces; only a keyboard opening or
      // closing is worth a refit.
      if (Math.abs(covered - this.kbInset) < 24) {
        return;
      }

      this.kbInset = covered;
      el.style.setProperty('--kb-inset', `${ covered }px`);
      this.scheduleFit();
      requestAnimationFrame(() => this.terminal?.scrollToBottom());
    },

    onFontSizeQuery() {
      if (!this.terminal) {
        return;
      }

      this.terminal.options.fontSize = terminalFontSize();
      this.scheduleFit(true);
    },

    // tmux owns the scrollback - the xterm viewport only holds the current screen - so a touch
    // drag is turned into wheel notches for tmux rather than a scroll of an empty viewport.
    onTouchStart(event) {
      this.touchY = event.touches[0]?.clientY ?? 0;
      this.touchAcc = 0;
    },

    onTouchMove(event) {
      const y = event.touches[0]?.clientY ?? 0;
      const dy = y - this.touchY;

      this.touchY = y;
      this.touchAcc += dy;

      const lines = Math.trunc(this.touchAcc / TOUCH_LINE_PX);

      if (!lines) {
        return;
      }
      this.touchAcc -= lines * TOUCH_LINE_PX;
      event.preventDefault();
      this.wheel(Math.abs(lines), lines > 0);
    },

    /** Wheel notches, as tmux expects them. */
    wheel(lines, up) {
      const seq = up ? '\x1b[A' : '\x1b[B';

      this.sendKeys(seq.repeat(Math.min(lines, 10)));
    },
  },
};
</script>

<template>
  <div class="mc-terminal">
    <div
      ref="xterm"
      class="mc-terminal__xterm"
    />
    <!-- Touch only: the keys a phone keyboard does not have. -->
    <div
      v-if="showKeyBar"
      class="mc-terminal__keys"
    >
      <button
        class="mc-terminal__key"
        :class="{ 'mc-terminal__key--armed': ctrlArmed }"
        title="Ctrl - applies to the next key you type"
        @click="armCtrl"
      >
        Ctrl
      </button>
      <button
        v-for="key in KEY_BAR"
        :key="key.label"
        class="mc-terminal__key"
        :title="key.title || key.label"
        @click="tapKey(key.seq)"
      >
        {{ key.label }}
      </button>
    </div>
    <!--
      A pasted image takes a second or two to get into the pod, and until the path appears at
      the prompt nothing else says anything happened.
    -->
    <div
      v-if="pasting || imageError"
      class="mc-terminal__paste"
      :class="{ 'mc-terminal__paste--error': imageError }"
    >
      {{ imageError || 'Putting the image in the pod' }}
    </div>
    <!-- Teleported, because the viewer is position: fixed and the panel this terminal sits in
         is animated with a transform - which makes a fixed child position against that panel
         instead of the viewport, so the modal opens somewhere nobody can see. -->
    <Teleport to="body">
      <PodFileViewer
        v-if="viewerPath"
        :pod="viewerPod"
        :path="viewerPath"
        :container="container"
        :namespace="namespace"
        :home="home"
        @close="viewerPath = ''"
      />
    </Teleport>
    <div
      v-if="state !== 'open'"
      class="mc-terminal__status"
    >
      <span>{{ error || statusText }}</span>
      <button
        v-if="state === 'closed'"
        type="button"
        class="mc-terminal__retry"
        @click="reconnect"
      >
        Reconnect
      </button>
    </div>
  </div>
</template>

<style lang="scss">
.mc-terminal__keys::-webkit-scrollbar {
  display: none;
}

.mc-terminal__key {
  flex: none;
  min-width: 40px;
  height: 36px;
  padding: 0 8px;
  background: var(--body-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--body-text);
  font-family: monospace;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
}

/* An armed Ctrl reads as held: the next key typed is the one it applies to. */
.mc-terminal__key--armed {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-text);
}
// Not scoped: @font-face is document-level, and the font has to be declared
// before xterm measures a character or it measures the fallback.
//
// Inlined into the bundle rather than emitted as a file - see the fonts rule in
// pkg/barn/vue.config.js for why that matters for an extension.
@font-face {
  font-family: "Harness Terminal";
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url("../assets/fonts/harness-terminal-400.woff2") format("woff2");
}

@font-face {
  font-family: "Harness Terminal";
  font-style: normal;
  font-weight: 700;
  font-display: block;
  src: url("../assets/fonts/harness-terminal-700.woff2") format("woff2");
}
</style>

<style lang="scss" scoped>
.mc-terminal {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  padding: 4px 0 0 6px;
  background: var(--terminal-bg, var(--body-bg));

  &__paste {
    position:      absolute;
    right:         10px;
    bottom:        10px;
    z-index:       2;
    padding:       4px 8px;
    border-radius: var(--border-radius);
    background:    var(--default);
    color:         var(--body-text);
    font-size:     11px;

    &--error {
      background: var(--error);
      color:      var(--error-text, #fff);
    }
  }

  &__xterm {
    flex: 1 1 auto;
    min-height: 0;
    // A stacking context of its own, so xterm's canvas layers are ordered
    // inside it rather than against their neighbours. They carry z-index up to
    // 3, and nothing between them and this pane used to establish a context, so
    // they beat the status overlay below on the only comparison that decides a
    // click. Containing them here means the two siblings are ordered by their
    // own z-index and xterm's internal count stops being this component's
    // business.
    position: relative;
    z-index: 0;
  }

  &__status {
    position: absolute;
    // Above xterm's canvas layers, which are positioned too. Without this the
    // overlay draws on top but the canvas still wins the hit test, so the
    // Reconnect button below cannot be clicked and a disconnected pane is dead
    // until the page is reloaded.
    z-index: 1;
    right: 10px;
    bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--body-bg);
    color: var(--muted);
    font-size: 12px;
  }

  &__retry {
    padding: 0;
    border: none;
    background: none;
    color: var(--link);
    cursor: pointer;
  }
}
</style>
