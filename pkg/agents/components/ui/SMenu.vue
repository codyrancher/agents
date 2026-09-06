<script>
// A dropdown menu, for the overflow controls the design draws as an icon and a list.
//
// Not Rancher's RcDropdown, for the reason PublishSplit documents: its props come through a
// TypeScript type that `@vue/compiler-sfc` has to resolve against a tsconfig beside the file,
// which for a component inside node_modules is the shell's own, so the alias is unknown and
// the build stops. This is the same shape assembled from primitives.
//
// Closes on Escape, on a click outside, and on choosing something. Positions itself against
// the trigger rather than inside it, so a menu on a row does not get clipped by the row.
import SIcon from './SIcon.vue';

export default {
  name: 'SMenu',

  components: { SIcon },

  props: {
    /**
     * `{ id, label, icon?, danger?, disabled?, divider? }` per line.
     *
     * An item may also be a row of choices instead of a line of text:
     * `{ id, label?, choices: [{ id, icon, label }], value }` renders them as icon buttons
     * side by side, with `value` marked as the one in force. That shape is here rather than in
     * the one caller because it is how a browser presents a small, mutually exclusive pick -
     * where a panel is docked, which is the first use - and a menu that could not express it
     * would have had that row rendered beside it in a second, differently styled popup.
     */
    items: {
      type:    Array,
      default: () => [],
    },

    /** The trigger's icon when the default slot is not used. */
    icon: {
      type:    String,
      default: 'more',
    },

    /**
     * How big that icon is drawn.
     *
     * A prop because a menu is not always on a toolbar: the agent panel puts one at the end of a
     * tab row beside 12px controls, and a 16px glyph there is the one thing on the bar that is a
     * different size from everything else.
     */
    iconSize: {
      type:    [Number, String],
      default: 16,
    },

    label: {
      type:    String,
      default: '',
    },

    /** left | right - which edge of the trigger the panel lines up with. */
    align: {
      type:    String,
      default: 'right',
    },

    ariaLabel: {
      type:    String,
      default: 'More actions',
    },
  },

  emits: ['select', 'open', 'close'],

  data() {
    return {
      open: false, top: 0, left: 0,
    };
  },

  beforeUnmount() {
    this.unbind();
  },

  methods: {
    toggle() {
      return this.open ? this.close() : this.show();
    },

    show() {
      const r = this.$refs.trigger?.getBoundingClientRect();

      if (!r) {
        return;
      }

      // Fixed to the viewport, measured off the trigger: a menu inside a scrolling panel or a
      // table row would otherwise be clipped by whichever ancestor has overflow set.
      this.top = r.bottom + 4;
      this.left = this.align === 'right' ? r.right : r.left;
      this.open = true;
      this.$emit('open');
      this.$nextTick(() => {
        // Flip up if the panel would fall off the bottom of the window.
        const p = this.$refs.panel;

        if (p && this.top + p.offsetHeight > window.innerHeight - 8) {
          this.top = Math.max(8, r.top - p.offsetHeight - 4);
        }
      });
      document.addEventListener('keydown', this.onKey, true);
      document.addEventListener('mousedown', this.onOutside, true);
    },

    close() {
      if (!this.open) {
        return;
      }

      this.open = false;
      this.unbind();
      this.$emit('close');
    },

    unbind() {
      document.removeEventListener('keydown', this.onKey, true);
      document.removeEventListener('mousedown', this.onOutside, true);
    },

    onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
        this.$refs.trigger?.focus();
      }
    },

    onOutside(e) {
      if (!this.$refs.panel?.contains(e.target) && !this.$refs.trigger?.contains(e.target)) {
        this.close();
      }
    },

    choose(item) {
      if (item.disabled || item.divider || item.choices) {
        return;
      }

      this.close();
      this.$emit('select', item.id);
    },

    /**
     * One of a row of choices.
     *
     * Emits the choice's own id rather than a pair, so a caller handles every selection from
     * this menu in one place and the ids stay the vocabulary - `dock-left` says what it is
     * without needing to know which item it came from.
     */
    chooseOption(item, choice) {
      if (choice.disabled) {
        return;
      }

      this.close();
      this.$emit('select', choice.id);
    },
  },
};
</script>

<template>
  <div class="s-menu">
    <button
      ref="trigger"
      type="button"
      class="s-menu__trigger"
      :class="{ 's-menu__trigger--open': open }"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click.stop="toggle"
    >
      <slot name="trigger">
        <SIcon :name="icon" :size="iconSize" />
        <span v-if="label" class="s-menu__label">{{ label }}</span>
      </slot>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panel"
        class="s-menu__panel"
        :class="`s-menu__panel--${ align }`"
        role="menu"
        :style="{ top: `${ top }px`, left: `${ left }px` }"
      >
        <template v-for="(item, i) in items" :key="item.id || `d${ i }`">
          <div v-if="item.divider" class="s-menu__divider" />
          <div
            v-else-if="item.choices"
            class="s-menu__choices"
            role="group"
            :aria-label="item.label || ''"
          >
            <span
              v-if="item.label"
              class="s-menu__choices-label"
            >{{ item.label }}</span>
            <div class="s-menu__choices-row">
              <button
                v-for="choice in item.choices"
                :key="choice.id"
                type="button"
                role="menuitemradio"
                class="s-menu__choice"
                :class="{ 's-menu__choice--on': choice.id === item.value }"
                :aria-checked="choice.id === item.value"
                :title="choice.label"
                :aria-label="choice.label"
                @click="chooseOption(item, choice)"
              >
                <SIcon
                  :name="choice.icon"
                  :size="16"
                />
              </button>
            </div>
          </div>
          <button
            v-else
            type="button"
            role="menuitem"
            class="s-menu__item"
            :class="{ 's-menu__item--danger': item.danger, 's-menu__item--disabled': item.disabled }"
            :disabled="item.disabled"
            @click="choose(item)"
          >
            <SIcon v-if="item.icon" :name="item.icon" :size="13" />
            <span class="s-menu__item-label">{{ item.label }}</span>
            <span v-if="item.note" class="s-menu__item-note">{{ item.note }}</span>
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style lang="scss" scoped>
.s-menu {
  display: inline-flex;

  &__trigger {
    display:       inline-flex;
    align-items:   center;
    gap:           6px;
    padding:       5px;
    min-height:    0;
    background:    none;
    border:        none;
    border-radius: var(--studio-radius);
    color:         var(--studio-text-secondary);
    cursor:        pointer;

    &:hover,
    &--open {
      background: var(--studio-surface-subtle);
      color:      var(--studio-text);
    }
  }

  &__label { font: var(--studio-caption-12); }
}

// Teleported to body, so it is outside the component's scope and needs its own block.
.s-menu__panel {
  position:      fixed;
  z-index:       2000;
  min-width:     200px;
  padding:       var(--studio-space-4) 0;
  background:    var(--studio-surface);
  border:        1px solid var(--studio-border);
  border-radius: var(--studio-radius);
  box-shadow:    var(--studio-shadow-popover);

  &--right { transform: translateX(-100%); }
}

.s-menu__item {
  display:     flex;
  align-items: center;
  gap:         var(--studio-space-8);
  width:       100%;
  padding:     7px var(--studio-space-12);
  min-height:  0;
  background:  none;
  border:      none;
  text-align:  left;
  font:        var(--studio-body-13);
  color:       var(--studio-text);
  cursor:      pointer;

  &:hover:not(&--disabled) { background: var(--studio-surface-subtle); }

  &--danger { color: var(--studio-error); }

  &--disabled {
    opacity: 0.45;
    cursor:  not-allowed;
  }
}

.s-menu__item-label { flex: 1 1 auto; }

.s-menu__item-note {
  font:  var(--studio-caption-12);
  color: var(--studio-text-tertiary);
}

// A row of icons rather than a line of words, for a small mutually exclusive pick. Same padding
// as an item so it lines up with the words below it.
.s-menu__choices {
  display:        flex;
  align-items:    center;
  gap:            var(--studio-space-8);
  padding:        7px var(--studio-space-12);

  &-label {
    flex:  1 1 auto;
    font:  var(--studio-body-13);
    color: var(--studio-text);
  }

  &-row {
    display: flex;
    gap:     2px;
  }
}

.s-menu__choice {
  display:         flex;
  align-items:     center;
  justify-content: center;
  width:           28px;
  height:          24px;
  padding:         0;
  min-height:      0;
  background:      none;
  border:          none;
  border-radius:   var(--studio-radius);
  color:           var(--studio-text-secondary);
  cursor:          pointer;

  &:hover { background: var(--studio-surface-subtle); }

  &--on {
    background: var(--studio-surface-subtle);
    color:      var(--studio-text);
    box-shadow: inset 0 0 0 1px var(--studio-border);
  }
}

.s-menu__divider {
  height:     1px;
  margin:     var(--studio-space-4) 0;
  background: var(--studio-border-subtle);
}
</style>
