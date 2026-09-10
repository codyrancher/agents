<script>
// The panel the global chord opens: several conversations with the agent pod, as tabs.
//
// Inside a tab is PodTerminal, pointed at one conversation in the agent pod.
//
// Two things about the conversations, and they pull in opposite directions on purpose:
//
//   - Which conversations exist, and what they are called, come from the pod. tmux and a
//     directory under /workspace/sessions are where a conversation actually is, so that is what
//     is asked (see agent.ts), which is what makes a second browser tab, a reload and a
//     colleague's session all show the same list with the same names.
//   - Whether this panel is open, where it sits and how big it is come from localStorage. That
//     is one person in front of one browser, and putting it in the pod would mean docking the
//     panel left here docked it left on somebody else's screen. See agent-drawer.ts.
//
// ---------------------------------------------------------------------------
// Why the tab row is written out here rather than imported.
//
// It is Rancher's `@shell/components/Tabbed` - its markup, its class names, its roles and its
// arrow-key behaviour - with two controls added to each tab. That component cannot express
// those, and the check is short: its label is rendered as escaped text (`{{ tab.labelDisplay }}`
// with no slot and no markup), and the one slot it has, `tab-row-extras`, is after the whole tab
// list. Its own add and remove controls live in a `tab-list-footer` at the end of the row and
// act on whichever tab happens to be active, which is exactly the arrangement being replaced: a
// person closing the third conversation should not have to select it first.
//
// So the row below is that row, kept deliberately recognisable, minus what a panel does not
// have: no `useHash` (this is not a route, and putting a conversation id in the URL would put it
// in Rancher's history), no side-tab mode, no extension tabs. Its styles are copied for the same
// reason - Tabbed's are `scoped`, so the class names alone inherit nothing.
//
// The one intended visual difference beyond the controls: the active tab is not accented.
// Rancher colours it `--active` and underlines it; here it reads as active through the underline
// and the weight alone, because an accent colour on a terminal's chrome fights the terminal.
// ---------------------------------------------------------------------------
import { isAdminUser } from '@shell/store/type-map';
// The Studio's design tokens, which SMenu and SIcon are drawn in. Imported here, the way every
// Studio page imports them, because this panel is the one part of the Studio that opens over
// Rancher's own pages - and those pages have never loaded a Studio route, so without this the
// menu renders with `background: var(--studio-surface)` resolving to nothing and floats over the
// terminal as unreadable text. The stylesheet declares custom properties on `body` and nothing
// else, so carrying it on every page changes the look of none of them.
import '../design/tokens';
import PodTerminal from './PodTerminal';
import SIcon from './ui/SIcon.vue';
import SMenu from './ui/SMenu.vue';
import {
  agentSessions, startAgentSession, renameAgentSession, endAgentSession,
} from '../agent';
import { ensureAgentCredential } from '../credential';
import {
  readDrawerState, writeDrawerState, PLACEMENTS, DEFAULT_PLACEMENT, MIN_SIZE, VIEWPORT_MARGIN,
} from '../drawer';

/** The mouse button a tab is closed with, as `MouseEvent.button` numbers it. */
const MIDDLE_BUTTON = 1;

/** The id of the one stylesheet this panel reserves the dashboard's room with. */
const RESERVATION_ID = 'mc-agent-reservation';

/**
 * The stylesheet holding the reservation, made on first use.
 *
 * One element for the life of the page rather than a rule rewritten into an existing sheet:
 * setting `textContent` on it is a single assignment the browser reparses, so there is no rule
 * index to keep and nothing to clean up but the element itself.
 */
function reservationSheet() {
  const existing = document.getElementById(RESERVATION_ID);

  if (existing) {
    return existing;
  }

  const sheet = document.createElement('style');

  sheet.id = RESERVATION_ID;
  document.head.appendChild(sheet);

  return sheet;
}

/**
 * The placement row, in the order a browser's devtools draws the same choice.
 *
 * Three of its four. A separate window was built and taken out again: a real popup means the
 * terminal, its WebSocket and a Vue app in a second document with no access to the dashboard's
 * store, and the floating panel that stood in for it was a fourth thing to position, drag,
 * clamp and persist for no use anybody had. What remains of it is the fallback in
 * agent-drawer.ts, which turns a stored `window` back into `bottom`.
 */
const PLACEMENT_CHOICES = [
  { id: 'left', icon: 'dockLeft', label: 'Dock left' },
  { id: 'bottom', icon: 'dockBottom', label: 'Dock bottom' },
  { id: 'right', icon: 'dockRight', label: 'Dock right' },
];

export default {
  name: 'AgentPanel',

  components: {
    PodTerminal, SIcon, SMenu
  },

  data() {
    const stored = readDrawerState();

    return {
      open:     false,
      /** [{ id, title }], as the pod reports them. */
      sessions: [],
      active:   '',
      // Whether the tab remembered from the last visit has been restored yet. Until it has, it
      // outranks whatever this page load happened to select.
      restoredTab: false,
      // Which of them have ever been on top. A terminal is mounted on first visit and then kept
      // (an inactive panel is hidden with v-show), so coming back to a conversation is instant
      // and its scrollback is intact, while one nobody has opened here holds no socket at all.
      seen:     [],
      loading:  false,
      /** The id being renamed, and the text in the box, or null when nothing is. */
      renaming: null,
      error:    '',
      /** The Rancher user the pod is currently acting as, or '' when it has no identity. */
      identity: '',

      placement: stored.placement,
      geometry:  { ...stored.geometry },
      /** The drag in progress, or null. See onGrab. */
      drag:      null,
      // Collected with function refs rather than string ones, which is what Tabbed does and for
      // the same reason: a string ref inside v-for is an array whose order is not the list's.
      renameRef:  null,
    };
  },

  computed: {
    /**
     * Whether to show any of this at all.
     *
     * Rancher's own definition, read from what the user's schemas say they may PUT rather than
     * from a global role name we would have to keep in step with Rancher's. See the note in
     * agent-overlay.ts for why the gate is here as well as on the key handler.
     */
    admin() {
      return isAdminUser(this.$store.getters);
    },

    /**
     * Where the panel is, as inline style.
     *
     * Only the dimension that placement makes resizable is set here; the rest is CSS, so a
     * panel docked at the bottom cannot end up carrying a width from a session where it was
     * docked to a side.
     */
    frameStyle() {
      const { height, width } = this.geometry;

      return this.placement === 'bottom' ? { height: `${ height }px` } : { width: `${ width }px` };
    },

    /**
     * The room the dashboard gives up to this panel, as one CSS rule.
     *
     * `.dashboard-root` is the element Rancher sizes to the viewport, on every layout it has,
     * and everything else - the header, the nav, the scrolling main area - divides up what is
     * inside it. Padding it is therefore the whole reservation: the dashboard lays itself out
     * in what is left, keeps its own single scrollbar, and needs to know nothing about this.
     *
     * The obvious alternative was Rancher's own `--wm-height` / `--wm-vl-width` /
     * `--wm-vr-width`, which is how its window manager reserves space for a docked shell. Two
     * things rule it out. Only the default layout has a row for `--wm-height` at all -
     * `home.vue` and `plain.vue` size columns and stop - so a bottom panel would go on
     * overlaying the Home page, which is one of the pages the chord is offered on. And the
     * variables belong to the window manager: writing them would fight whatever it had docked
     * rather than sit beside it.
     */
    reservation() {
      if (!this.open) {
        return '';
      }

      const { height, width } = this.geometry;

      const side = {
        bottom: `padding-bottom: ${ height }px`,
        left:   `padding-left: ${ width }px`,
        right:  `padding-right: ${ width }px`,
      }[this.placement];

      return side ? `.dashboard-root { ${ side }; }` : '';
    },

    /**
     * The panel's own menu.
     *
     * This is where further options go. Anything else this panel grows - a font size, a mode,
     * somewhere to put a transcript - belongs in this list rather than in a second control
     * beside it, which is how a strip ends up with five icons nobody can tell apart.
     */
    menuItems() {
      return [{
        id: 'placement', label: 'Placement', choices: PLACEMENT_CHOICES, value: this.placement,
      }];
    },

    activeSession() {
      return this.sessions.find((session) => session.id === this.active) || null;
    },

    /**
     * The conversations as a menu: the phone's version of the tab row.
     *
     * Everything the row can do is here, because the row is not rendered beside it - picking
     * one, starting another, renaming and ending the one that is open. Rename and End name the
     * conversation they act on rather than saying "this one", since the menu is closed by the
     * time anything happens and a menu that acted on something unnamed is how the wrong
     * conversation gets ended.
     */
    sessionMenuItems() {
      const title = this.activeSession?.title || '';

      return [
        ...this.sessions.map((session) => ({
          id:    `go:${ session.id }`,
          label: session.title,
          icon:  session.id === this.active ? 'check' : '',
        })),
        { id: 'divider', divider: true },
        { id: 'new', label: 'Another conversation', icon: 'plus' },
        {
          id: 'rename', label: title ? `Rename ${ title }` : 'Rename', icon: 'edit', disabled: !this.active,
        },
        {
          id: 'end', label: title ? `End ${ title }` : 'End', icon: 'close', danger: true, disabled: !this.active,
        },
      ];
    },
  },

  /**
   * Reopen as this browser left it.
   *
   * The panel is only built at all when the chord is pressed or when the overlay has already
   * read that it was open, so this runs once and does not have to guard against being early.
   */
  watch: {
    // A stylesheet rather than an inline style on the element, because `.dashboard-root` is
    // rendered by whichever layout the current route asked for and is replaced when the route
    // moves between them. A rule survives that; a style attribute set on the old element does
    // not, and the panel would silently start overlaying again on the first navigation.
    reservation: {
      handler(now) {
        reservationSheet().textContent = now;
      },
      immediate: true,
    },
  },

  mounted() {
    // The viewport this was stored against is not necessarily this one.
    this.clamp();
    window.addEventListener('resize', this.clamp);

    if (readDrawerState().open) {
      this.setOpen(true);
    }

  },

  beforeUnmount() {
    // Rancher keeps rendering after this panel is gone, so anything it was told to reserve has
    // to be given back or the dashboard keeps a strip of empty space for ever.
    document.getElementById(RESERVATION_ID)?.remove();

    this.endGrab();
    window.removeEventListener('resize', this.clamp);

  },

  methods: {
    // -----------------------------------------------------------------------
    // Open, closed, and where
    // -----------------------------------------------------------------------

    /** What the chord does. It is also the only way to dismiss the panel: there is no X. */
    toggle() {
      this.setOpen(!this.open);
    },

    close() {
      this.setOpen(false);
    },

    setOpen(open) {
      if (!this.admin) {
        return;
      }

      this.open = open;
      this.remember();

      if (open) {
        this.refresh();
      }
    },

    remember() {
      // Never write an empty tab over a remembered one. Opening the panel remembers before it
      // refreshes, and on a fresh page load there is no active tab yet - so the id from the last
      // visit was erased a moment before the code that restores it went looking for it.
      const stored = readDrawerState();

      writeDrawerState({
        open:      this.open,
        active:    this.active || stored.active,
        placement: this.placement,
        geometry:  this.geometry,
      });
    },

    onMenu(id) {
      if (PLACEMENTS.includes(id)) {
        this.movePanel(id);
      }
    },

    /** The conversations menu, which is the tab row on a phone. */
    onSessionMenu(id) {
      if (id.startsWith('go:')) {
        this.select(id.slice(3));

        return;
      }
      if (id === 'new') {
        this.startNew();

        return;
      }
      if (id === 'rename' && this.active) {
        this.startRename(this.active);

        return;
      }
      if (id === 'end' && this.active) {
        this.closeSession(this.active);
      }
    },

    /**
     * Take a side, or come off the edges altogether.
     *
     * The geometry is clamped on arrival rather than on the way out, because the viewport a
     * width was stored against is not the one it is being restored into: a panel sized on a
     * large monitor would otherwise open on a laptop covering the page and its own controls.
     */
    movePanel(placement) {
      this.placement = PLACEMENTS.includes(placement) ? placement : DEFAULT_PLACEMENT;
      this.clamp();
      this.remember();
      // xterm measures the box it is in, and the box has just changed size.
      this.$nextTick(() => window.dispatchEvent(new Event('resize')));
    },

    clamp() {
      const maxHeight = Math.max(MIN_SIZE, window.innerHeight - VIEWPORT_MARGIN);
      const maxWidth = Math.max(MIN_SIZE, window.innerWidth - VIEWPORT_MARGIN);
      const fit = (value, max) => Math.min(Math.max(value, MIN_SIZE), max);

      this.geometry = {
        height: fit(this.geometry.height, maxHeight),
        width:  fit(this.geometry.width, maxWidth),
      };
    },

    // -----------------------------------------------------------------------
    // Dragging: one implementation, four edges
    // -----------------------------------------------------------------------

    /**
     * Start a drag of one of the panel's edges.
     *
     * `what` is the edge being pulled. Every placement has exactly one thing that resizes - the
     * height when docked at the bottom, the width when docked to a side - so there is no
     * placement that renders and cannot be resized, which was the thing to avoid.
     *
     * Listeners go on the window rather than the handle: the pointer leaves a four-pixel grip
     * immediately and a drag that stopped tracking there would be a panel that resizes for one
     * pixel and then stops.
     */
    onGrab(what, event) {
      event.preventDefault();

      this.drag = {
        what,
        startX:   event.clientX,
        startY:   event.clientY,
        geometry: { ...this.geometry },
      };

      window.addEventListener('mousemove', this.onDrag);
      window.addEventListener('mouseup', this.endGrab);
    },

    onDrag(event) {
      if (!this.drag) {
        return;
      }

      const { what, startX, startY, geometry } = this.drag;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const next = { ...geometry };

      // Which way the number moves depends on which edge is being pulled: dragging the top edge
      // of a bottom-docked panel upwards is a negative dy and a taller panel.
      if (what === 'n') {
        next.height = geometry.height - dy;
      }

      if (what === 'w') {
        next.width = geometry.width - dx;
      }

      if (what === 'e') {
        next.width = geometry.width + dx;
      }

      this.geometry = next;
      this.clamp();
    },

    endGrab() {
      if (!this.drag) {
        return;
      }

      this.drag = null;
      window.removeEventListener('mousemove', this.onDrag);
      window.removeEventListener('mouseup', this.endGrab);
      this.remember();
      window.dispatchEvent(new Event('resize'));
    },

    // -----------------------------------------------------------------------
    // The conversations
    // -----------------------------------------------------------------------

    /**
     * Ask the pod what conversations there are, and settle on one to show.
     *
     * The stored tab is a preference rather than state: it may have been ended from another
     * browser since it was written, so it is used only when the pod still reports it, and the
     * first conversation is the fallback rather than a blank pane.
     */
    async refresh() {
      this.loading = true;
      this.error = '';

      try {
        // Before the conversations, because starting a pane is what reads it: the pod writes
        // this person's kubeconfig on the way up, and a pane that got there first would be the
        // one running as nobody. It is not fatal - an agent with no Rancher identity can still
        // hold a conversation, and saying so beats refusing to open the panel - so the failure
        // is reported and the tabs load anyway.
        this.identity = await ensureAgentCredential().catch((e) => {
          this.error = `The agent has no Rancher identity: ${ e?.message || e }`;

          return '';
        });

        this.sessions = await agentSessions();
      } finally {
        this.loading = false;
      }

      if (!this.sessions.length) {
        await this.startNew();

        return;
      }

      // The remembered tab wins until it has been honoured once. Preferring `this.active`
      // first meant an early refresh - one that ran before the session list arrived, so nothing
      // matched and the first tab was chosen - then wrote that choice back over the remembered
      // one, and a reload always came back on the first conversation.
      const stored = readDrawerState().active;
      const order = this.restoredTab ? [this.active, stored] : [stored, this.active];
      const wanted = order.find((id) => id && this.sessions.some((session) => session.id === id));

      if (wanted) {
        this.restoredTab = true;
      }

      this.select(wanted || this.sessions[0].id);
    },

    /** Show one conversation, mounting its terminal the first time. */
    select(id) {
      if (!id) {
        return;
      }

      this.active = id;

      if (!this.seen.includes(id)) {
        this.seen = [...this.seen, id];
      }

      this.remember();
    },

    /** Start another conversation. The pod picks the name; see startAgentSession for why. */
    async startNew() {
      this.error = '';

      try {
        const id = await startAgentSession();

        this.sessions = [...this.sessions, { id, title: id.replace(/^agent-/, '') }];
        this.select(id);
      } catch (e) {
        this.error = e?.message || String(e);
      }
    },

    /**
     * End one conversation: the tab, the tmux session and the transcript.
     *
     * Every route in comes here - the close control on the tab, and a middle click on it -
     * because they are the same act. The chord is not one of them: it hides the panel, which is
     * why the panel has no close control of its own and this one is per tab.
     */
    async closeSession(id) {
      if (!id) {
        return;
      }

      this.sessions = this.sessions.filter((session) => session.id !== id);
      this.seen = this.seen.filter((name) => name !== id);

      if (this.active === id) {
        this.active = this.sessions[0]?.id || '';
        this.remember();
      }

      try {
        await endAgentSession(id);
      } catch (e) {
        this.error = e?.message || String(e);
      }

      if (!this.sessions.length) {
        await this.startNew();
      }
    },



    // -----------------------------------------------------------------------
    // Naming
    // -----------------------------------------------------------------------

    startRename(id) {
      const session = this.sessions.find((entry) => entry.id === id);

      if (!session) {
        return;
      }

      this.select(id);
      this.renaming = { id: session.id, title: session.title };
      this.$nextTick(() => this.renameRef?.select());
    },

    async commitRename() {
      const pending = this.renaming;

      if (!pending) {
        return;
      }

      this.renaming = null;

      const title = pending.title.trim();
      const session = this.sessions.find((entry) => entry.id === pending.id);

      if (!session || title === session.title) {
        return;
      }

      // Optimistic, then confirmed by a re-read: the name lives in the pod, so this is the one
      // place where what is on screen and what is true can differ, and the re-read is what
      // closes that rather than trusting the write.
      session.title = title;

      try {
        await renameAgentSession(pending.id, title);
        this.sessions = this.withRename(await agentSessions(), pending.id, title);
      } catch (e) {
        this.error = e?.message || String(e);
      }
    },

    /**
     * The re-read, with the name we just wrote kept.
     *
     * The rename lands in the pod as a file operation and `agentSessions()` lists that
     * directory, and the two are not ordered: the listing that follows a successful rename can
     * still be the one from before it. Taking that answer literally put the old name back on
     * the tab for a poll or two before the next read agreed - the flicker.
     *
     * `renameAgentSession` having resolved is the stronger fact of the two, so it wins over a
     * listing that disagrees with it. A listing that agrees is unchanged by this, and a rename
     * that actually failed threw before ever reaching here.
     */
    withRename(sessions, id, title) {
      return sessions.map((session) => (session.id === id ? { ...session, title } : session));
    },

    // -----------------------------------------------------------------------
    // Keyboard, as Tabbed does it
    // -----------------------------------------------------------------------

  },
};
</script>

<template>
  <!--
    The admin check again, and not only on the key handler. A non-admin who reached this some
    other way gets nothing rendered rather than a terminal that would open into a cluster-admin
    ServiceAccount. See agent-overlay.ts for what this gate is and is not.
  -->
  <div
    v-if="open && admin"
    class="mc-agent"
    :class="[`mc-agent--${ placement }`, { 'mc-agent--dragging': !!drag }]"
    :style="frameStyle"
  >
    <!-- The one edge that resizes, per placement. -->
    <div
      v-if="placement === 'bottom'"
      class="mc-agent__grip mc-agent__grip--n"
      @mousedown="onGrab('n', $event)"
    />
    <div
      v-else-if="placement === 'left'"
      class="mc-agent__grip mc-agent__grip--e"
      @mousedown="onGrab('e', $event)"
    />
    <div
      v-else
      class="mc-agent__grip mc-agent__grip--w"
      @mousedown="onGrab('w', $event)"
    />

    <div class="mc-agent__row">
      <!--
        On a phone the conversations are a menu, not a row.

        The row is a horizontal scroller: at 390px it shows two and a half names, costs a line
        of the panel, and every one of its controls is a 12px glyph inside a tab that is itself
        a scroll target. Behind one button the pane gets that line back, the names are readable
        in full, and rename and end become entries somebody can hit. Everything the row does is
        in sessionMenuItems, because the row is not rendered beside it.
      -->
      <SMenu
        :items="sessionMenuItems"
        align="left"
        aria-label="Conversations"
        class="mc-agent__picker"
        @select="onSessionMenu"
      >
        <template #trigger>
          <span class="mc-agent__picker-title">{{ (activeSession && activeSession.title) || 'Conversations' }}</span>
          <span
            v-if="sessions.length > 1"
            class="mc-agent__picker-count"
          >{{ sessions.length }}</span>
          <SIcon
            name="chevronDown"
            :size="12"
          />
        </template>
      </SMenu>

      <!--
        New conversation, as a button rather than only a menu entry: starting one is the thing
        this bar is asked for most, and a one-click control beside the picker is easier to find
        and to hit than the same action folded into the dropdown. The dropdown keeps its entry
        too, for the phone layout and for anyone already there.
      -->
      <button
        type="button"
        class="mc-agent__new"
        aria-label="New conversation"
        title="New conversation"
        @click="startNew"
      >
        <SIcon
          name="plus"
          :size="14"
        />
      </button>

      <!-- The rename box, which now has no tab to live in. -->
      <input
        v-if="renaming"
        :ref="(el) => { if (el) renameRef = el; }"
        v-model="renaming.title"
        class="mc-agent__rename mc-agent__rename--wide"
        aria-label="Name this conversation"
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="renaming = null"
        @blur="commitRename"
      >

      <!--
        Rancher's tab row used to be here, and is gone.

        It was one line across the top of a panel that is often 300px tall, showing names the
        picker above already shows - and with the picker beside it, two controls answering one
        question. Choosing, renaming, ending and starting a conversation are all in the menu,
        which is where they can be read in full and hit with a thumb; moving between them is
        the menu's own arrow keys rather than the row's.
      -->

      <!--
        Outside the scroller, pinned to the right edge: however many conversations are open, and
        however far the row has been scrolled, the options button is where it was.
      -->
      <div class="mc-agent__end">
        <span
          v-if="loading"
          class="mc-agent__note"
        >Reading the pod</span>
        <span
          v-else-if="error"
          class="mc-agent__note mc-agent__note--error"
        >{{ error }}</span>

        <SMenu
          :items="menuItems"
          icon="more"
          :icon-size="12"
          aria-label="Agent panel options"
          @select="onMenu"
        />
      </div>
    </div>

    <div class="tab-container tab-container--flat">
      <!--
        Mounted on first visit and then kept: an inactive panel is hidden rather than unmounted,
        so coming back to a conversation is instant and its scrollback is intact, while one
        nobody has opened in this browser holds no exec socket at all.
      -->
      <section
        v-for="session in sessions"
        v-show="session.id === active"
        :id="session.id"
        :key="session.id"
        role="tabpanel"
        :aria-hidden="session.id !== active"
        :aria-labelledby="`tab-${ session.id }`"
      >
        <PodTerminal
          v-if="seen.includes(session.id)"
          :session="session.id"
        />
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.mc-agent {
  position: fixed;
  // Above Rancher's header and its side nav, which sit in the low hundreds, and below the
  // dashboard's own modals, which is where a dialog somebody opened deliberately belongs.
  z-index: 900;
  display: flex;
  flex-direction: column;
  background: var(--terminal-bg, var(--body-bg));
  box-shadow: 0 0 18px var(--shadow, rgba(0, 0, 0, 0.25));

  // While an edge is being dragged the pointer moves faster than the layout, and a pointer that
  // lands on the terminal mid-drag would otherwise start selecting text in it.
  &--dragging {
    user-select: none;
    cursor: grabbing;
  }

  &--bottom {
    left: 0;
    right: 0;
    bottom: 0;
    border-top: 1px solid var(--border);
  }

  &--left {
    left: 0;
    top: 0;
    bottom: 0;
    border-right: 1px solid var(--border);
  }

  &--right {
    right: 0;
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--border);
  }

  // The grips. Four pixels of hit area sitting over the edge, with no paint of their own so the
  // panel's own border stays the only line there is.
  &__grip {
    position: absolute;
    z-index: 2;

    &--n {
      top: -2px;
      left: 0;
      right: 0;
      height: 5px;
      cursor: ns-resize;
    }

    &--e {
      top: 0;
      bottom: 0;
      right: -2px;
      width: 5px;
      cursor: ew-resize;
    }

    &--w {
      top: 0;
      bottom: 0;
      left: -2px;
      width: 5px;
      cursor: ew-resize;
    }

  }

  &__row {
    display: flex;
    align-items: stretch;
    flex: 0 0 auto;
    min-width: 0;
    border-bottom: 1px solid var(--border);
    background: var(--header-bg, var(--body-bg));
  }

  // -------------------------------------------------------------------------
  // Rancher's tab row, from @shell/components/Tabbed. Its styles are scoped to that
  // component, so the class names alone bring nothing with them and the rules it applies to a
  // horizontal row are reproduced here. Metrics, hover and focus are its own; the two
  // differences are the controls on each tab and the active tab not being accented.
  // -------------------------------------------------------------------------
  .tabs {
    list-style-type: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: row;
    flex: 1 1 auto;
    min-width: 0;
    // Not Rancher's: a resource page has four tabs and a panel can have as many conversations
    // as somebody opens, so the row scrolls rather than crushing them.
    overflow-x: auto;

    // Keyboard focus is shown on the tab, and only for keyboard focus.
    //
    // The underline that used to accompany this was on `:focus` rather than `:focus-visible`,
    // so clicking a tab with the mouse boxed and underlined its label - which read as the label
    // being highlighted rather than as focus, and was reported three times as exactly that. The
    // outline alone says where the keyboard is, and a mouse user now gets nothing, which is
    // what they expect.
    &:focus-visible .tab.active {
      @include focus-outline;
      outline-offset: -2px;
    }

    .tab {
      position: relative;
      // Rancher floats these; this row also carries two controls per tab, which have to sit
      // beside the label rather than under it. Everything else about the box is Rancher's:
      // 4px either side, the anchor's 10px/15px, and therefore the same 38px tall row.
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      padding: 0 var(--studio-space-4, 4px);
      cursor: pointer;
      // Double click on a tab renames it, and without this the gesture also selects the label,
      // leaving a filled rectangle around the words that reads as a box drawn on the tab.
      user-select: none;

      a {
        display: flex;
        align-items: center;
        // Rancher's 10px/15px on three sides. The trailing padding is wider because the
        // pencil is drawn inside it rather than beside it: 20px for the control plus the same
        // 4px join every other gap in this row is made of. Nothing about it depends on whether
        // the pencil is currently shown, which is what makes hovering a tab move nothing.
        padding: 10px 24px 10px 15px;
        // Rancher leaves this to the global link colour and accents the active one. Neither
        // happens here: an accent on a terminal's chrome fights the terminal, so active reads
        // as active from the underline and the weight below.
        color: var(--body-text);

        &:hover {
          text-decoration: none;

          span {
            text-decoration: underline;
          }
        }
      }

      &.active {
        // Rancher draws this as a border-bottom, which takes two pixels of the tab's height and
        // so centres everything inside the active tab one pixel higher than everything inside
        // the others. On a resource page, where a tab holds only text, nobody sees it; on a row
        // where the tabs carry controls and the row also carries an add button and a menu, it is
        // four icons on three different lines. An inset shadow paints the same 2px line and
        // takes no layout space at all.
        box-shadow: inset 0 -2px 0 var(--body-text);

        > a {
          text-decoration: none;
          font-weight: 600;
        }
      }

      // Rancher shows keyboard focus by outlining the active tab when the list itself is
      // focused. These anchors and buttons are focusable in their own right, so the ring is put
      // on the tab that contains whatever the keyboard reached rather than on the anchor, whose
      // box hugs the label and reads as a box drawn around the words.
      //
      // `:focus-visible` rather than `:focus-within`, so a click does not draw one - a ring on
      // every click is the thing this whole treatment is trying not to be.
      &:has(a:focus-visible),
      &:has(button:focus-visible) {
        @include focus-outline;
        outline-offset: -2px;
      }
    }
  }

  // Rancher nests this inside the tab list, and so does this row: the add control travels with
  // the tabs and scrolls with them.
  .tab-list-footer {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    list-style: none;
    margin: 0;
    padding: 0 var(--studio-space-4, 4px);

    li {
      display: flex;
      align-items: center;
    }
  }

  // Outside the scroller, so it keeps its place at the right edge no matter how long the row is.
  &__end {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    padding: 0 var(--studio-space-4, 4px);

    // The menu's trigger is one more control on this bar, so it is the same control: same box,
    // same glyph size, same corner, same centre line. SMenu's own trigger is sized for a
    // toolbar, and its icon size is a prop; the box is reached through :deep because it belongs
    // to that component.
    :deep(.s-menu__trigger) {
      width: 20px;
      height: 20px;
      padding: 0;
      justify-content: center;
      border-radius: 3px;
    }
  }

  &__tab-control {
    display: flex;
    align-items: center;
    justify-content: center;
    // A square, so the hover surface is centred on the glyph and the same for both controls
    // rather than sized by each icon's own box.
    width: 20px;
    height: 20px;
    padding: 0;
    // Rancher gives every button in the dashboard a 40px min-height, which stretched these to
    // the full height of the row and made the row four pixels taller than Rancher's own. The
    // same line is in SMenu's trigger, for the same reason.
    min-height: 0;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--body-text);
    cursor: pointer;
    opacity: 0.55;

    &:hover {
      opacity: 1;
      background: var(--default-hover-bg, var(--body-bg));
    }

    // Shown when the pointer is over this tab, or when something inside it has focus - a
    // control only a mouse can reach is one a keyboard user cannot reach at all, and the
    // double click that also renames is not an affordance anybody can see.
    //
    // Out of the flow, inside the trailing padding the anchor already has, so it costs the tab
    // no width at all. That is what makes the row not move when the pointer crosses it: there
    // is no slot being reserved and then filled, and therefore nothing to get wrong. Reserving
    // a slot instead - the obvious version - makes every tab permanently a button wider and
    // doubles the gap between the label and the first control.
    &--rename {
      display: none;
      position: absolute;
      // Immediately left of the close control: 4px of tab padding plus its 20px box.
      right: 24px;
      top: 50%;
      transform: translateY(-50%);
    }
  }

  .tab:hover &__tab-control--rename,
  .tab:focus-within &__tab-control--rename {
    display: flex;
  }

  &__rename {
    // Wide enough for a name, and capped so that opening it never pushes the add control past
    // the edge of a row that was fitting a moment ago.
    width: 150px;
    max-width: 30vw;
    margin: 4px 0;
    padding: 3px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--body-bg);
    color: var(--body-text);
    font-size: 13px;

    // On a phone there is no row to keep inside, so the box takes the width it needs.
    &--wide {
      flex: 1 1 auto;
      width: auto;
      max-width: none;
      margin: 4px 8px 4px 0;
    }
  }

  // ── The conversations, as a menu (phone width) ──
  &__picker {
    flex: 0 1 auto;
    min-width: 0;
    margin: 2px 0;

    :deep(button) {
      display: flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      // A thumb target, and the same height as the controls at the other end of the bar.
      min-height: 32px;
      padding: 0 8px;
    }
  }

  &__picker-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }

  // How many there are, since the trigger only names the one that is open.
  &__picker-count {
    flex: 0 0 auto;
    padding: 0 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--body-text) 10%, transparent);
    color: var(--muted);
    font-size: 11px;
  }

  // New conversation, beside the picker. Same height as the picker so the two read as one pair,
  // and the same bare-icon treatment as the options button at the other end of the bar.
  &__new {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    min-height: 32px;
    margin: 2px 0;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--body-text);
    cursor: pointer;
    opacity: 0.7;

    &:hover {
      opacity: 1;
      background: var(--default-hover-bg, var(--body-bg));
    }
  }

  &__note {
    padding: 0 var(--studio-space-8, 8px);
    max-width: 240px;
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &--error {
      color: var(--error);
    }
  }

  .tab-container {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;

    // Rancher pads this by 20px and `--flat` takes it away. A terminal wants the whole box.
    &--flat {
      padding: 0;
    }

    > section {
      height: 100%;
    }
  }
}
</style>
