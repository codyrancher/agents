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
  parseTranscript, renderMarkdown, readPane, toolSummary, projectKey
} from '../chat';
import { podExecOnce } from '../pod';
import { agentPod, sessionCommand } from '../agent';

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

    rendered() {
      return this.messages.map((m) => ({
        ...m,
        html:      m.role === 'assistant' ? renderMarkdown(m.text) : '',
        toolRows:  m.tools.map((t) => ({ ...t, summary: toolSummary(t) })),
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

  beforeUnmount() {
    clearInterval(this.timer);
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
        const out = await this.run([
          `ID=${ JSON.stringify(this.paneId) }; OFF=${ this.offset }`,
          `PROJ="$HOME/.claude/projects/${ projectKey(this.workdir) }"`,
          'uuid=$(cat "$(dirname "$HOME")/sessions/$ID.id" 2>/dev/null)',
          'FILE=""',
          'if [ -n "$uuid" ] && [ -f "$PROJ/$uuid.jsonl" ]; then FILE="$PROJ/$uuid.jsonl"; else FILE=$(ls -t "$PROJ"/*.jsonl 2>/dev/null | head -1); fi',
          'echo "@@FILE $FILE"',
          'if [ -n "$FILE" ] && [ -f "$FILE" ]; then size=$(wc -c < "$FILE"); echo "@@SIZE $size"; if [ "$size" -gt "$OFF" ]; then echo "@@DATA"; tail -c +$((OFF+1)) "$FILE"; echo; echo "@@ENDDATA"; fi; fi',
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
        this.offset = size;
        this.messages = parseTranscript(this.lines.concat(this.remainder.trim() ? [this.remainder] : []));
        this.$nextTick(() => this.scrollToEnd());
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

    scrollToEnd() {
      const el = this.$refs.log;

      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
        el.scrollTop = el.scrollHeight;
      }
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
    <div
      ref="log"
      class="mc-chat__log"
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
          <span class="mc-chat__who">{{ m.role === 'user' ? 'You' : 'Claude' }}</span>
          <span class="mc-chat__when">{{ when(m.at) }}</span>
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
          v-if="m.role === 'assistant' && m.html"
          class="mc-chat__body mc-chat__md"
          v-html="m.html"
        />
        <div
          v-else-if="m.role === 'user'"
          class="mc-chat__body mc-chat__user-text"
        >{{ m.text }}</div>
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
            @click="toggleTool(t.id)"
          >
            <span class="mc-chat__tool-name">{{ t.name }}</span>
            <span class="mc-chat__tool-summary">{{ t.summary }}</span>
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
    </div>

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
      <template v-else-if="working">
        <i class="icon icon-spinner icon-spin" /> {{ pane.status || 'Working' }}
        <button
          type="button"
          class="mc-chat__link"
          @click="stop"
        >
          Stop
        </button>
      </template>
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
  display:        flex;
  flex-direction: column;
  height:         100%;
  min-height:     0;
  min-width:      0;
  background:     var(--terminal-bg, var(--body-bg));
  color:          var(--body-text);
  font-size:      13px;

  &__log {
    flex:       1 1 auto;
    overflow:   auto;
    padding:    10px 14px;
    min-height: 0;
  }

  &__empty { color: var(--muted); }

  &__msg {
    margin:        0 0 12px;
    padding:       8px 12px;
    border-radius: 8px;
    max-width:     100%;

    &--user {
      background:  color-mix(in srgb, var(--link) 14%, transparent);
      margin-left: 40px;
    }

    &--assistant {
      background: color-mix(in srgb, var(--body-text) 5%, transparent);
    }
  }

  &__meta {
    display:     flex;
    gap:         8px;
    align-items: baseline;
    margin:      0 0 4px;
  }

  &__who { font-weight: 600; font-size: 12px; }
  &__when { color: var(--muted); font-size: 11px; }

  &__user-text { white-space: pre-wrap; word-break: break-word; }

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

  &__images {
    list-style: none;
    padding:    0;
    margin:     6px 0 0;
    font-family: monospace;
    font-size:  12px;
    color:      var(--muted);
  }

  &__tool {
    margin:        6px 0 0;
    border-left:   2px solid var(--border);
    padding-left:  8px;
    font-size:     12px;

    &--error { border-left-color: var(--error); }
    &--pending { border-left-color: var(--link); }
  }

  &__disclose {
    background:  none;
    border:      0;
    padding:     2px 0;
    min-height:  0;
    color:       var(--body-text);
    cursor:      pointer;
    text-align:  left;
    font-size:   12px;
    display:     flex;
    gap:         8px;
    align-items: baseline;
    max-width:   100%;

    &:hover { color: var(--link); }
  }

  &__tool-name { font-weight: 600; flex: 0 0 auto; }
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
    margin:      4px 0 0;
    padding:     6px 8px;
    font-size:   11px;
    background:  var(--body-bg);
    border:      1px solid var(--border);
    border-radius: 4px;
    white-space: pre-wrap;
    word-break:  break-word;
    max-height:  320px;
    overflow:    auto;

    &--result { border-color: color-mix(in srgb, var(--link) 40%, var(--border)); }
  }

  &__thought { margin: 0 0 6px; color: var(--muted); }

  &__dialog {
    flex:        0 0 auto;
    margin:      0 14px 8px;
    padding:     10px 12px;
    border:      1px solid var(--link);
    border-radius: 8px;
    background:  color-mix(in srgb, var(--link) 8%, transparent);
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
    border:        1px solid var(--border);
    background:    var(--body-bg);
    color:         var(--body-text);
    border-radius: 6px;
    padding:       4px 10px;
    min-height:    0;
    font-size:     12px;
    cursor:        pointer;
    text-decoration: none;

    &:hover { border-color: var(--link); color: var(--link); }
    &--selected { border-color: var(--link); }
  }

  &__option-key {
    display:       inline-block;
    min-width:     14px;
    color:         var(--muted);
    font-family:   monospace;
  }

  &__login { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  &__code { display: flex; gap: 6px; }
  &__code input { height: 28px; font-size: 12px; padding: 0 8px; }

  &__status {
    flex:        0 0 auto;
    padding:     4px 14px;
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
    padding:     6px 14px 10px;
    border-top:  1px solid var(--border);
    align-items: flex-end;
  }

  &__textarea {
    flex:       1 1 auto;
    resize:     vertical;
    min-height: 44px;
    font-size:  13px;
    padding:    6px 8px;
    background: var(--body-bg);
    color:      var(--body-text);
    border:     1px solid var(--border);
    border-radius: 6px;
  }

  &__send {
    flex:          0 0 auto;
    min-height:    0;
    height:        32px;
    padding:       0 14px;
    border-radius: 6px;
    border:        1px solid var(--link);
    background:    var(--link);
    color:         var(--body-bg);
    cursor:        pointer;

    &:disabled { opacity: 0.5; cursor: default; }
  }
}
</style>
