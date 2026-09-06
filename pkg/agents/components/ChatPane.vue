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

const POLL_MS = 1500;
const CHUNK = 3000;

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

  emits: ['state'],

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
      return this.view === 'main' ? this.messages : this.sub.messages;
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
        toolRows:  m.tools.map((t) => ({
          ...t, summary: toolSummary(t), summaryHtml: linkPaths(escapeText(toolSummary(t))),
        })),
      }));
    },

    canSend() {
      return !!this.draft.trim() && !this.sending;
    },

    working() {
      return this.pane.busy;
    },
  },

  mounted() {
    this.poll();
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
          `ID=${ JSON.stringify(this.paneId) }; OFF=${ this.offset }; SUB=${ JSON.stringify(sub) }; SOFF=${ this.sub.offset }`,
          `PROJ="$HOME/.claude/projects/${ projectKey(this.workdir) }"`,
          'uuid=$(cat "$(dirname "$HOME")/sessions/$ID.id" 2>/dev/null)',
          'FILE=""',
          'if [ -n "$uuid" ] && [ -f "$PROJ/$uuid.jsonl" ]; then FILE="$PROJ/$uuid.jsonl"; else FILE=$(ls -t "$PROJ"/*.jsonl 2>/dev/null | head -1); fi',
          'echo "@@FILE $FILE"',
          'if [ -n "$FILE" ] && [ -f "$FILE" ]; then size=$(wc -c < "$FILE"); echo "@@SIZE $size"; if [ "$size" -gt "$OFF" ]; then echo "@@DATA"; tail -c +$((OFF+1)) "$FILE"; echo; echo "@@ENDDATA"; fi; fi',
          // The subagent's transcript sits beside the session's, in a directory named for it.
          'if [ -n "$SUB" ] && [ -n "$FILE" ]; then SF="${FILE%.jsonl}/subagents/agent-$SUB.jsonl"; if [ -f "$SF" ]; then ssize=$(wc -c < "$SF"); echo "@@SSIZE $ssize"; if [ "$ssize" -gt "$SOFF" ]; then echo "@@SDATA"; tail -c +$((SOFF+1)) "$SF"; echo; echo "@@SENDDATA"; fi; fi; fi',
          // Every subagent's last line and when it was written, for the list of them.
          'if [ -n "$FILE" ] && [ -d "${FILE%.jsonl}/subagents" ]; then for f in "${FILE%.jsonl}"/subagents/agent-*.jsonl; do [ -f "$f" ] || continue; id=$(basename "$f" .jsonl); id=${id#agent-}; echo "@@TAIL $id $(stat -c %Y "$f")"; tail -c 6000 "$f" | grep "\"type\":\"assistant\"" | tail -n 1 | cut -c1-3000; done; echo "@@ENDTAILS"; fi',
          'echo "@@PANE"',
          'if tmux has-session -t "mc-$ID" 2>/dev/null; then tmux capture-pane -p -t "mc-$ID" | tail -n 40; else echo "@@NOPANE"; fi',
        ].join('\n'));

        this.absorb(out);
        this.error = '';
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
        this.messages = parseTranscript(this.lines.concat(this.remainder.trim() ? [this.remainder] : []));
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

      const paneAt = out.indexOf('@@PANE\n');
      const paneText = paneAt >= 0 ? out.slice(paneAt + 7) : '';

      this.attached = !paneText.includes('@@NOPANE');
      this.paneText = paneText;
      this.pane = this.attached ? readPane(paneText) : {
        busy: false, idle: false, dialog: null, gone: true, status: '',
      };
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
        if (!this.attached) {
          await this.start();
        }
        await this.say(text);
        this.draft = '';
        this.error = '';
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.sending = false;
        this.poll();
      }
    },

    onKeydown(event) {
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
      this.openTools = { ...this.openTools, [id]: !this.openTools[id] };
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
      this.openThoughts = { ...this.openThoughts, [key]: !this.openThoughts[key] };
    },

    when(iso) {
      if (!iso) {
        return '';
      }
      const d = new Date(iso);

      return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    /** An image pasted or dropped: into the pod beside the pane, its path into the draft. */
    async onPaste(event) {
      const items = [...(event.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/'));

      if (!items.length) {
        return;
      }
      event.preventDefault();
      for (const item of items) {
        await this.attachImage(item.getAsFile());
      }
    },

    async onDrop(event) {
      const files = [...(event.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));

      if (!files.length) {
        return;
      }
      event.preventDefault();
      for (const file of files) {
        await this.attachImage(file);
      }
    },

    async attachImage(file) {
      if (!file) {
        return;
      }
      this.pasting = 'Putting the image in the pod';
      try {
        const { bytes, extension } = await this.shrink(file);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const path = `${ this.imageDir }/${ stamp }.${ extension }`;
        let binary = '';

        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const encoded = btoa(binary);

        await this.run(`mkdir -p "$(dirname '${ path }')" && : > '${ path }.b64'`);
        for (let i = 0; i < encoded.length; i += CHUNK) {
          this.pasting = `Putting the image in the pod (${ Math.round((i / encoded.length) * 100) }%)`;
          await this.run(`printf %s '${ encoded.slice(i, i + CHUNK) }' >> '${ path }.b64'`);
        }
        const out = await this.run(`base64 -d '${ path }.b64' > '${ path }' && rm -f '${ path }.b64' && wc -c < '${ path }'`);

        if (!parseInt(out.trim(), 10)) {
          throw new Error(`the image did not land in ${ this.label }`);
        }
        this.draft = `${ this.draft }${ this.draft && !this.draft.endsWith(' ') ? ' ' : '' }${ path } `;
        this.pasting = '';
      } catch (e) {
        this.pasting = '';
        this.error = e.message || String(e);
      }
    },

    /**
     * A screenshot as a JPEG when it is big: every chunk of it is an exec, and a 2 MB PNG of a
     * dashboard is two hundred of them. The model reads a JPEG just as well.
     */
    async shrink(file) {
      const original = new Uint8Array(await file.arrayBuffer());
      const extension = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '');

      if (original.length < 150_000 || typeof createImageBitmap !== 'function') {
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
        :class="`mc-chat__msg--${ m.role }`"
      >
        <div class="mc-chat__meta">
          <span class="mc-chat__who">{{ m.role === 'user' ? 'You' : m.role === 'summary' ? 'Summary' : 'Claude' }}</span>
          <span class="mc-chat__when">{{ when(m.at) }}</span>
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
            {{ openThoughts[m.key] ? '▾' : '▸' }} Thinking
          </button>
          <pre
            v-if="openThoughts[m.key]"
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
            v-for="image in m.images"
            :key="image"
          >
            🖼 {{ image }}
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
            :aria-expanded="openTools[t.id] ? 'true' : 'false'"
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
            v-if="openTools[t.id]"
            class="mc-chat__tool-detail"
          >
            <pre class="mc-chat__pre">{{ JSON.stringify(t.input, null, 2) }}</pre>
            <pre
              v-if="t.result !== undefined"
              class="mc-chat__pre mc-chat__pre--result"
            >{{ t.result.slice(0, 6000) }}{{ t.result.length > 6000 ? '\n…' : '' }}</pre>
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

    <!-- Getting around: your messages one by one, and the bottom. -->
    <div class="mc-chat__nav">
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
    </Teleport>

    <!-- What the pane is asking, when it is asking something a text box cannot answer. -->
    <div
      v-if="pane.dialog"
      class="mc-chat__dialog"
    >
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
          @click="choose(o)"
        >
          <span class="mc-chat__option-key">{{ o.key }}</span> {{ o.label }}
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
      <template v-else>{{ pane.status || 'Ready' }}</template>
    </div>

    <div class="mc-chat__input">
      <textarea
        v-model="draft"
        class="mc-chat__textarea"
        rows="3"
        :placeholder="working ? 'Queue the next message (Enter to send, Shift+Enter for a new line, paste an image to attach it)' : 'Message (Enter to send, Shift+Enter for a new line, paste an image to attach it)'"
        @keydown="onKeydown"
        @paste="onPaste"
      />
      <button
        type="button"
        class="mc-chat__send"
        :disabled="!canSend"
        @click="send"
      >
        {{ sending ? '…' : 'Send' }}
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.mc-chat {
  position:       relative;
  display:        flex;
  flex-direction: column;
  height:         100%;
  min-height:     0;
  min-width:      0;
  background:     var(--terminal-bg, var(--body-bg));
  color:          var(--body-text);
  font-size:      13px;
  line-height:    1.5;

  &__log {
    flex:       1 1 auto;
    overflow:   auto;
    padding:    14px 18px 8px;
    min-height: 0;
  }

  &__empty { color: var(--muted); }

  &__msg {
    position:      relative;
    margin:        0 0 10px;
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
  }

  &__meta {
    display:     flex;
    gap:         8px;
    align-items: baseline;
    margin:      0 0 4px;
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

  &__input {
    flex:        0 0 auto;
    display:     flex;
    gap:         8px;
    padding:     6px 18px 12px;
    border-top:  1px solid var(--border);
    align-items: flex-end;
  }

  &__textarea {
    flex:          1 1 auto;
    resize:        vertical;
    min-height:    44px;
    font-size:     13px;
    padding:       8px 10px;
    background:    var(--body-bg);
    color:         var(--body-text);
    border:        1px solid var(--border);
    border-radius: 8px;

    &:focus { border-color: var(--link); outline: none; }
  }

  &__send {
    flex:          0 0 auto;
    min-height:    0;
    height:        34px;
    padding:       0 16px;
    border-radius: 8px;
    border:        1px solid var(--link);
    background:    var(--link);
    color:         var(--body-bg);
    font-weight:   600;
    cursor:        pointer;

    &:disabled { opacity: 0.5; cursor: default; }
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

  &__nav {
    position:  absolute;
    right:     26px;
    bottom:    118px;
    display:   flex;
    gap:       4px;
    z-index:   3;
  }

  &__navbtn {
    min-height:    0;
    height:        24px;
    padding:       0 8px;
    font-size:     11px;
    border-radius: 12px;
    border:        1px solid var(--border);
    background:    var(--body-bg);
    color:         var(--muted);
    cursor:        pointer;
    opacity:       0.75;

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
