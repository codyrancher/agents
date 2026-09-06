// The chord that opens the agent, from anywhere in Rancher.
//
// This bundle is a UIPlugin, so index.ts runs on every page load of the whole dashboard - the
// Studio's screens, Rancher's own, a cluster's Workloads list. That is already a global hook,
// and it is the only one needed: a keydown listener on the document, and a panel appended to
// the body. There is no slot to claim and nothing to register with, which is the point - the
// header's single NavHeaderRight slot is the mechanism this product deliberately gave up, since
// the last extension to claim it silently wins.
//
// ---------------------------------------------------------------------------
// Who this is offered to, and why that is a decision rather than an omission.
//
// The pane runs as the `extension-studio` ServiceAccount, which is bound to cluster-admin. The
// exec WebSocket is authenticated as whoever is looking at the page, so Kubernetes refuses
// anybody without exec rights in this namespace - but exec in one namespace is not
// cluster-admin, and a user with edit on `extension-studio`, or a project containing it, has the
// first without the second. For them this chord is a one-keystroke privilege escalation, so the
// affordance is offered to Rancher admins only, and to everybody else it does not exist: no
// disabled button, no refusal, no hint that a chord is there. A control that only ever says no
// is noise.
//
// Say the honest thing about what that gate is: it is a UI gate, not a security boundary. A
// non-admin with exec rights in this namespace can still reach the pod with `kubectl`, and
// nothing in a browser can stop that. The real fix is to scope the pod's ServiceAccount below
// cluster-admin, and it is not done here because the agent's whole usefulness is that it can
// reach every extension pod and ask the cluster anything - a narrower grant is a design, not a
// smaller number.
// ---------------------------------------------------------------------------
import { createApp } from 'vue';
import { isAdminUser } from '@shell/store/type-map';
import AgentPanel from './components/AgentPanel.vue';
import { readDrawerState } from './drawer';

/**
 * Put the drawer back the way this browser left it.
 *
 * Only when it was open: a person who closed it gets nothing built, no store watched and no
 * request made, which is every page load for everybody who does not use this.
 *
 * The wait is the awkward part and it is not avoidable. This runs while the bundle is being
 * evaluated, which on a cold load is before Rancher has fetched the schemas `isAdminUser` reads,
 * so asking now would answer "not an admin" for an admin and silently drop the drawer. Watching
 * the store answers the moment the schemas land, and stops watching as soon as it has - a timer
 * polling for the same thing would either be too slow to feel like a restore or still running an
 * hour later.
 */
let stopWaitingForAdmin: (() => void) | null = null;
let waitingForApp: any = null;

/** How long to keep looking for the dashboard's app, and how often. See below for both. */
const APP_POLL_MS = 200;
const APP_WAIT_MS = 30000;

function restoreDrawer(): void {
  if (!readDrawerState().open) {
    return;
  }

  whenAppExists((store) => {
    if (isAdmin()) {
      panelInstance();

      return;
    }

    stopWaitingForAdmin = store.watch(
      () => isAdminUser(store.getters),
      (admin: boolean) => {
        if (!admin) {
          return;
        }

        stopWaitingForAdmin?.();
        stopWaitingForAdmin = null;
        // The panel reads the stored state itself when it mounts, so building it is the whole
        // of reopening it - which keeps one owner for "was it open" rather than two.
        panelInstance();
      },
    );
  });
}

/**
 * Wait for the dashboard's own Vue app, then hand over its store.
 *
 * A poll, and the reason it is one is worth stating because the first version of this had no
 * wait at all and simply did nothing. A UIPlugin is evaluated during the dashboard's bootstrap,
 * inside `extendApp`, which is *before* `vueApp.mount('#app')` - so at the moment this runs
 * there is no `#app.__vue_app__` to read a store off, and asking once answers null on every cold
 * load. The drawer restored perfectly when the bundle happened to be re-evaluated later, and
 * never on a refresh, which is the case it exists for.
 *
 * It is a poll rather than an event because mounting is not one: Vue sets `__vue_app__` on the
 * element and announces nothing. The deadline is what keeps it from being a leak - a page where
 * the app never mounts is a broken page, not one to keep asking about.
 */
function whenAppExists(then: (store: any) => void): void {
  const store = dashboardStore();

  if (store) {
    then(store);

    return;
  }

  const deadline = Date.now() + APP_WAIT_MS;

  waitingForApp = setInterval(() => {
    const ready = dashboardStore();

    if (!ready && Date.now() < deadline) {
      return;
    }

    clearInterval(waitingForApp);
    waitingForApp = null;

    if (ready) {
      then(ready);
    }
  }, APP_POLL_MS);
}

/**
 * `event.code`, not `event.key`.
 *
 * Shift and a backtick produce `~` on a US layout and something else again elsewhere, so the
 * character the browser reports is not the key the chord is named after. `Backquote` is the
 * physical key, which is what "ctrl+shift+`" means to the person pressing it.
 */
const CHORD_CODE = 'Backquote';

/** Where the panel is mounted. Identified so a second bundle load finds it instead of stacking. */
const HOST_ID = 'extension-studio-agent-overlay';

let panel: any = null;
let listening = false;

/**
 * The dashboard's Vuex store, taken off the app Vue mounted.
 *
 * There is no import for it: `@shell/config/store` builds one, and the running dashboard's is
 * the one already mounted on `#app`. Vue 3 puts the app it mounted on the element, so this reads
 * that rather than constructing a second store which would answer about nobody.
 *
 * Null is a real answer and the gate below fails closed on it - on the login page, or before the
 * app has mounted, there is no user to be an admin.
 */
function dashboardApp(): any {
  return (document.querySelector('#app') as any)?.__vue_app__ || null;
}

function dashboardStore(): any {
  return dashboardApp()?.config?.globalProperties?.$store || null;
}

function isAdmin(): boolean {
  const store = dashboardStore();

  return !!store && isAdminUser(store.getters);
}

/**
 * Whether this keystroke is somebody typing rather than asking for the panel.
 *
 * The panel itself is exempt, and that exemption is the whole reason this is not a one-line
 * check. xterm's input is a textarea, so once the panel is open every keystroke in it looks like
 * typing - and the chord that opens the panel is also the chord that closes it. Without this,
 * the panel could be opened and never closed from the keyboard.
 */
function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;

  if (!target || document.getElementById(HOST_ID)?.contains(target)) {
    return false;
  }

  return /^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable;
}

/** The panel, made the first time it is wanted so a non-admin never builds one. */
function panelInstance(): any {
  if (panel) {
    return panel;
  }

  const host = document.createElement('div');

  host.id = HOST_ID;
  document.body.appendChild(host);

  // Its own Vue app rather than a component slotted into the dashboard's, because there is no
  // slot to put it in.
  const app = createApp(AgentPanel);

  adoptDashboardContext(app);
  panel = app.mount(host);

  return panel;
}

/**
 * Give this app the dashboard's own component context.
 *
 * The panel renders `@shell/components/Tabbed`, and a shell component expects to be inside the
 * dashboard's app rather than beside it: `t()` is a global property the i18n plugin installs at
 * boot, `v-clean-tooltip` is a directive installed at the same time, and Vuex reaches a
 * component through a provide rather than through a prop. An app made with `createApp` has none
 * of that, and the failures are at render time, in a drawer, on somebody else's page.
 *
 * Rebuilding it - installing the shell's plugins, components and directives into this app -
 * would be a second copy of the dashboard's boot sequence running in front of a page that has
 * already finished it, and it would need keeping in step with that sequence for ever. Copying
 * the context that is already there cannot drift. The cost is `_context`, which is Vue's
 * internal name for it.
 *
 * The global properties are copied as descriptors rather than as values, because `$route` is
 * defined as a getter: assigning it would freeze whichever page the drawer was first opened on
 * into every shell component inside it, for the life of the tab.
 */
function adoptDashboardContext(app: any): void {
  const host = dashboardApp();

  if (!host) {
    return;
  }

  Object.assign(app._context.components, host._context.components);
  Object.assign(app._context.directives, host._context.directives);
  Object.assign(app._context.provides, host._context.provides);
  Object.defineProperties(
    app.config.globalProperties,
    Object.getOwnPropertyDescriptors(host.config.globalProperties),
  );
}

function onKeyDown(event: KeyboardEvent): void {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.code !== CHORD_CODE) {
    return;
  }

  if (isTyping(event) || !isAdmin()) {
    return;
  }

  event.preventDefault();
  panelInstance().toggle();
}

/**
 * Listen for the chord, and hand back the way to stop.
 *
 * Guarded against a second call: a bundle evaluated twice would otherwise leave two listeners on
 * the document, and the chord would open the panel and immediately close it again.
 */
export function registerAgentOverlay(): () => void {
  if (listening) {
    return () => {};
  }

  listening = true;
  window.addEventListener('keydown', onKeyDown);
  restoreDrawer();

  return () => {
    stopWaitingForAdmin?.();

    if (waitingForApp) {
      clearInterval(waitingForApp);
      waitingForApp = null;
    }

    window.removeEventListener('keydown', onKeyDown);
    listening = false;
    panel = null;
    document.getElementById(HOST_ID)?.remove();
  };
}

/**
 * Rebuild the overlay when the dev server replaces this module.
 *
 * The panel is its own Vue app, mounted once into `document.body` the first time somebody opens
 * it. Vue's own hot reload replaces a component's definition wherever it is rendered, but this
 * module is plain TypeScript: nothing accepts an update for it, so the listener registered at
 * load and the app mounted from it both survive a recompile holding the previous code. The
 * symptom is a change that is definitely compiled and definitely not on screen, and the usual
 * conclusion is that the dev server is broken when it is doing exactly what it was asked.
 *
 * So: tear the overlay down before the replacement arrives, and register the new one after.
 * Only in development - `import.meta.webpackHot` is undefined in a built bundle, which is why
 * this is guarded rather than compiled out.
 */
const hot = (import.meta as any)?.webpackHot;

if (hot) {
  hot.accept();

  hot.dispose(() => {
    stopWaitingForAdmin?.();

    if (waitingForApp) {
      clearInterval(waitingForApp);
      waitingForApp = null;
    }

    window.removeEventListener('keydown', onKeyDown);
    listening = false;
    panel = null;
    document.getElementById(HOST_ID)?.remove();

    // Whatever this panel had reserved of Rancher's layout goes back with it. The replacement
    // sets it again from its own state; leaving it would strand a gap the new panel does not
    // know it owns.
    document.getElementById('mc-agent-reservation')?.remove();
  });
}
