<script>
// The design's icon set, resolved against Rancher's own icon font.
//
// The Figma file draws 45 icons as vector components. Redrawing them here would be the wrong
// move twice over: they are generic glyphs a person could not pick out of a line-up, and
// Rancher already ships a font whose glyphs are the ones the rest of the dashboard uses - so
// borrowing them is both less code and more consistent than being faithful to a concept's
// hand-drawn approximations of the same shapes.
//
// So `name` is the design's name and the mapping below is where it lands. Seven of them have
// no glyph in the font (there is no save, compare, rocket, monitor, undo, stop or server) and
// those are inline SVG, drawn at 16x16 on the same 1.33 stroke the Figma icons use.
const FONT = {
  menu:         'icon-menu',
  home:         'icon-home',
  puzzle:       'icon-extension',
  gear:         'icon-gear',
  bell:         'icon-notify-bell',
  grid:         'icon-apps',
  chevronDown:  'icon-chevron-down',
  chevronRight: 'icon-chevron-right',
  chevronLeft:  'icon-chevron-left',
  chevronUp:    'icon-chevron-up',
  plus:         'icon-plus',
  minus:        'icon-minus',
  search:       'icon-search',
  refresh:      'icon-refresh',
  external:     'icon-external-link',
  folder:       'icon-folder',
  file:         'icon-file',
  branch:       'icon-fork',
  github:       'icon-github',
  terminal:     'icon-terminal',
  sparkle:      'icon-ai',
  check:        'icon-checkmark',
  alert:        'icon-alert',
  close:        'icon-close',
  play:         'icon-play',
  eye:          'icon-show',
  clock:        'icon-history',
  more:         'icon-actions',
  edit:         'icon-edit',
  trash:        'icon-trash',
  upload:       'icon-upload',
  download:     'icon-download',
  filter:       'icon-filter',
  code:         'icon-code',
  lock:         'icon-lock',
  user:         'icon-user',
  book:         'icon-document',
  pin:          'icon-pin',
  list:         'icon-list-flat',
  spinner:      'icon-spinner',
  error:        'icon-error',
  warning:      'icon-warning',
  info:         'icon-info',
};

// The ones with no glyph. Paths are stroked, not filled, so they inherit `color` the same
// way the font icons do and sit at the same visual weight beside them.
const SVG = {
  save:    'M3 3.667h7.333L13 6.333V13H3V3.667Z M5.667 3.667v3h4.666v-3 M5.667 13v-3.333h4.666V13',
  compare: 'M4 2v8 M4 12.667a1.333 1.333 0 1 0 0-2.667 1.333 1.333 0 0 0 0 2.667Z M12 6v8 M12 5.333a1.333 1.333 0 1 0 0-2.666 1.333 1.333 0 0 0 0 2.666Z M4 6h5.333A2.667 2.667 0 0 1 12 8.667',
  rocket:  'M9.333 2.667c2 0 4 2 4 4 0 2.667-2.666 5.333-2.666 5.333H5.333S2.667 9.333 2.667 6.667c0-2 2-4 4-4h2.666Z M8 7.333a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z M6 12v2 M10 12v2',
  monitor: 'M2 3.333h12v7.334H2V3.333Z M6 13.333h4 M8 10.667v2.666',
  undo:    'M3 7.333h7a3 3 0 0 1 0 6H6 M3 7.333 6 4.333 M3 7.333l3 3',
  stop:    'M4 4h8v8H4V4Z',
  // `icon-right-arrow-alt` is not in the font this loads, so the class rendered an empty
  // element that still took its width - which is what pushed "Send" off-centre in the
  // composer, an icon nobody could see holding a space open beside the label.
  arrowRight: 'M3.333 8h9.334 M9.333 4.667 12.667 8l-3.334 3.333',
  server:  'M2.667 3.333h10.666v3.334H2.667V3.333Z M2.667 9.333h10.666v3.334H2.667V9.333Z M5 5h.007 M5 11h.007',
  // The element picker's crosshair. Not in the Figma set and not in Rancher's font: this is
  // the shape every browser's inspect tool uses, and the point of it is that it is already
  // familiar rather than that it is ours.
  target:  'M8 12.667a4.667 4.667 0 1 0 0-9.334 4.667 4.667 0 0 0 0 9.334Z M8 9.333A1.333 1.333 0 1 0 8 6.667a1.333 1.333 0 0 0 0 2.666Z M8 1.333V3.333 M8 12.667v2 M14.667 8h-2 M3.333 8h-2',
  // Where a panel sits, drawn the way every browser's devtools draws the same choice: one
  // frame, with a line showing which edge the panel has taken. They are here rather than in
  // the panel that uses them because a name in this map is how the rest of this product asks
  // for an icon, and a second icon vocabulary beside it is how the two drift.
  dockLeft:   'M2 3h12v10H2V3Z M6.5 3v10',
  dockBottom: 'M2 3h12v10H2V3Z M2 9.5h12',
  dockRight:  'M2 3h12v10H2V3Z M9.5 3v10',
};

export default {
  name: 'SIcon',

  props: {
    /** A name from the design's icon set. Anything unknown renders nothing. */
    name: {
      type:     String,
      required: true,
    },

    /** Pixel size. The design draws these at 13, 16 and 20. */
    size: {
      type:    [Number, String],
      default: 16,
    },
  },

  computed: {
    fontClass() {
      return FONT[this.name] || null;
    },

    svgPath() {
      return SVG[this.name] || null;
    },

    sizePx() {
      return `${ parseInt(this.size, 10) }px`;
    },
  },
};
</script>

<template>
  <svg
    v-if="svgPath"
    class="s-icon s-icon--svg"
    :style="{ width: sizePx, height: sizePx }"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
  >
    <path
      :d="svgPath"
      stroke="currentColor"
      stroke-width="1.333"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>

  <i
    v-else-if="fontClass"
    class="s-icon icon"
    :class="fontClass"
    :style="{ fontSize: sizePx, width: sizePx, height: sizePx }"
    aria-hidden="true"
  />
</template>

<style lang="scss" scoped>
.s-icon {
  display:     inline-flex;
  align-items: center;
  flex:        0 0 auto;
  line-height: 1;

  &--svg {
    display: inline-block;
  }
}
</style>
