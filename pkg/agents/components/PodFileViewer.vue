<script>
import { statPodPath, listPodDir, readPodFileBase64 } from '../pod';

// What a browser can show inline. Anything else is named and sized rather than guessed at.
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const VIDEO = ['mp4', 'webm', 'mov', 'mkv'];
const AUDIO = ['mp3', 'wav', 'ogg', 'm4a', 'flac'];
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  pdf: 'application/pdf',
};

/**
 * A file, or a directory, from inside the pod the terminal is attached to.
 *
 * Opened by clicking a path the session printed. A directory lists and can be walked, which is
 * what makes a printed output directory worth clicking at all.
 */
export default {
  name: 'PodFileViewer',

  props: {
    pod:  { type: String, required: true },
    path: { type: String, required: true },
    /** Which container and namespace to read from; the agent pod's unless told otherwise. */
    container: { type: String, default: undefined },
    namespace: { type: String, default: undefined },
    /** The pane's home in that pod, which the read runs with. */
    home: { type: String, default: undefined },
  },

  emits: ['close'],

  data() {
    return {
      current: this.path, kind: '', size: 0, entries: [], text: '', dataUrl: '',
      loading: true, error: '',
      // Zoom is a scale about a point, not a two-state toggle: the whole reason to open a
      // screenshot from a terminal is to read the small print in one corner of it.
      scale: 1, panX: 0, panY: 0, dragging: false, dragX: 0, dragY: 0,
    };
  },

  computed: {
    target() {
      return {
        pod: this.pod, container: this.container, namespace: this.namespace, home: this.home,
      };
    },

    extension() {
      return (this.current.split('/').pop() || '').split('.').slice(1).pop()?.toLowerCase() || '';
    },
    isImage() {
      return IMAGE.includes(this.extension);
    },
    isVideo() {
      return VIDEO.includes(this.extension);
    },
    isAudio() {
      return AUDIO.includes(this.extension);
    },
    isPdf() {
      return this.extension === 'pdf';
    },
    parent() {
      const trimmed = this.current.replace(/\/+$/, '');
      const at = trimmed.lastIndexOf('/');

      return at > 0 ? trimmed.slice(0, at) : at === 0 ? '/' : '';
    },
    sizeDisplay() {
      if (this.size < 1024) {
        return `${ this.size } B`;
      }

      return this.size < 1024 * 1024 ? `${ Math.round(this.size / 1024) } KB` : `${ (this.size / 1024 / 1024).toFixed(1) } MB`;
    },
  },

  watch: {
    current: {
      immediate: true,
      handler() {
        this.load();
      },
    },
  },

  methods: {
    async load() {
      this.loading = true;
      this.error = '';
      this.entries = [];
      this.text = '';
      this.dataUrl = '';

      try {
        this.scale = 1;
        this.panX = 0;
        this.panY = 0;

        const stat = await statPodPath(this.target, this.current);

        this.kind = stat.kind;
        this.size = stat.size;

        if (stat.kind === 'none') {
          this.error = 'not readable from this pod';
        } else if (stat.kind === 'dir') {
          this.entries = await listPodDir(this.target, this.current);
        } else {
          const base64 = await readPodFileBase64(this.target, this.current);

          if (this.isImage || this.isVideo || this.isAudio || this.isPdf) {
            this.dataUrl = `data:${ MIME[this.extension] || 'application/octet-stream' };base64,${ base64 }`;
          } else {
            // Text is the fallback for anything without a media extension, because a file a
            // session printed the path of is far more often readable than not.
            this.text = decodeURIComponent(escape(atob(base64)));
          }
        }
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    /** Wheel zooms about the pointer, so the thing under the cursor stays under it. */
    onWheel(event) {
      event.preventDefault();

      const rect = event.currentTarget.getBoundingClientRect();
      const px = event.clientX - rect.left - (rect.width / 2) - this.panX;
      const py = event.clientY - rect.top - (rect.height / 2) - this.panY;
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.min(12, Math.max(0.2, this.scale * factor));
      const ratio = next / this.scale;

      // Keep the point under the cursor fixed: shift the pan by how far that point moved.
      this.panX -= px * (ratio - 1);
      this.panY -= py * (ratio - 1);
      this.scale = next;
    },

    onDragStart(event) {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      this.dragging = true;
      this.dragX = event.clientX;
      this.dragY = event.clientY;
    },

    onDragMove(event) {
      if (!this.dragging) {
        return;
      }

      this.panX += event.clientX - this.dragX;
      this.panY += event.clientY - this.dragY;
      this.dragX = event.clientX;
      this.dragY = event.clientY;
    },

    onDragEnd() {
      this.dragging = false;
    },

    resetView() {
      this.scale = 1;
      this.panX = 0;
      this.panY = 0;
    },

    open(entry) {
      this.current = `${ this.current.replace(/\/+$/, '') }/${ entry.name }`;
    },
  },
};
</script>

<template>
  <div
    class="pfv"
    @click.self="$emit('close')"
  >
    <div class="pfv__panel">
      <div class="pfv__head">
        <button
          v-if="parent"
          class="btn role-tertiary btn-sm"
          @click="current = parent"
        >
          <i class="icon icon-chevron-left" /> Up
        </button>
        <code class="pfv__path">{{ current }}</code>
        <span
          v-if="kind === 'file'"
          class="text-muted"
        >{{ sizeDisplay }}</span>
        <!--
          The mouse instructions and the zoom, split, because only one of them survives a
          phone: "scroll to zoom, drag to pan, double-click to reset" is advice for a pointer
          nobody holding a phone has, and at 390px it was pushing the close button off the
          header and the path down to a single "/".
        -->
        <span
          v-if="isImage"
          class="text-muted pfv__hint"
        >scroll to zoom &middot; drag to pan &middot; double-click to reset</span>
        <span
          v-if="isImage"
          class="text-muted pfv__zoom"
        >{{ Math.round(scale * 100) }}%</span>
        <button
          class="btn role-tertiary btn-sm pfv__close"
          @click="$emit('close')"
        >
          <i class="icon icon-close" />
        </button>
      </div>

      <div class="pfv__body">
        <div v-if="loading">
          Loading&hellip;
        </div>
        <div
          v-else-if="error"
          class="text-error"
        >
          {{ error }}
        </div>

        <ul
          v-else-if="kind === 'dir'"
          class="pfv__list"
        >
          <li
            v-for="entry in entries"
            :key="entry.name"
          >
            <button
              class="pfv__entry"
              @click="open(entry)"
            >
              <i :class="entry.dir ? 'icon icon-folder' : 'icon icon-file'" />
              {{ entry.name }}
            </button>
          </li>
          <li v-if="!entries.length">
            <span class="text-muted">empty</span>
          </li>
        </ul>

        <div
          v-else-if="isImage"
          class="pfv__stage"
          :class="{ 'pfv__stage--dragging': dragging }"
          @wheel="onWheel"
          @mousedown="onDragStart"
          @mousemove="onDragMove"
          @mouseup="onDragEnd"
          @mouseleave="onDragEnd"
          @dblclick="resetView"
        >
          <img
            :src="dataUrl"
            class="pfv__img"
            :style="{ transform: `translate(${ panX }px, ${ panY }px) scale(${ scale })` }"
            draggable="false"
          >
        </div>
        <video
          v-else-if="isVideo"
          :src="dataUrl"
          controls
          class="pfv__media"
        />
        <audio
          v-else-if="isAudio"
          :src="dataUrl"
          controls
          class="pfv__media"
        />
        <iframe
          v-else-if="isPdf"
          :src="dataUrl"
          class="pfv__pdf"
        />
        <pre
          v-else
          class="pfv__text"
        >{{ text }}</pre>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.pfv {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
}

.pfv__panel {
  background: var(--body-bg);
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  width: min(1100px, 92vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}

.pfv__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  // Nothing in this row may push the close button out of the panel, which is what a header
  // with one flexible child and three rigid ones will do as soon as one of them is a sentence.
  min-width: 0;
}

.pfv__path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pfv__hint,
.pfv__zoom {
  flex: 0 0 auto;
  white-space: nowrap;
}

.pfv__close {
  flex: none;
  margin-left: auto;
}

@media (max-width: 760px) {
  .pfv__head {
    gap: 6px;
    padding: 8px;
  }

  // Advice for a pointer, on a device that has none.
  .pfv__hint { display: none; }

  // The path is the only thing here that can give up room, and on a phone it is the tail of it
  // that identifies the file, so it is the front that goes.
  .pfv__path {
    direction: rtl;
    text-align: left;
  }
}

.pfv__body {
  padding: 12px;
  overflow: auto;
}

.pfv__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.pfv__entry {
  background: none;
  border: none;
  color: var(--link);
  cursor: pointer;
  padding: 4px 0;
  font-family: var(--font-family-mono);
}

// The stage clips; the image inside it is what moves and scales, so panning never grows the
// modal or scrolls the page behind it.
.pfv__stage {
  position: relative;
  overflow: hidden;
  height: 72vh;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  user-select: none;
}

.pfv__stage--dragging {
  cursor: grabbing;
}

.pfv__img {
  max-width: 100%;
  max-height: 72vh;
  transform-origin: center center;
  will-change: transform;
  // No transition: a wheel zoom that animates lags behind the pointer it is meant to track.
  pointer-events: none;
}

.pfv__hint {
  font-size: 11px;
  white-space: nowrap;
}

.pfv__media {
  width: 100%;
}

.pfv__pdf {
  width: 100%;
  height: 72vh;
  border: none;
}

.pfv__text {
  margin: 0;
  white-space: pre;
  font-family: var(--font-family-mono);
  font-size: 12px;
}
</style>
