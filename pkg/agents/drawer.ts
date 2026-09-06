// Where the agent panel sits and whether it is open, remembered per browser.
//
// This is the part of the agent's state that does NOT belong in the pod, and the distinction is
// worth writing down because everything beside it goes the other way. Which conversations exist,
// and what they are called, are facts about the cluster: a second browser tab has to see them
// and a colleague has to see them, so they live in the pod. Whether a panel is open, which side
// it is docked to and how wide somebody dragged it are facts about one person in front of one
// browser. Putting them in the pod would mean docking the panel left here docked it left on
// somebody else's screen.
//
// So: localStorage, which is per browser and per origin, and which is allowed to be missing.
// Every read is a guess that may be wrong - a private window throws on write, storage can be
// cleared, and a conversation that was on top yesterday may have been ended since - so nothing
// here throws, everything is validated on the way out, and the caller treats what comes back as
// a preference rather than as state.

/** Namespaced, because this is Rancher's own origin and it is shared with the dashboard. */
const KEY = 'extension-studio.agent.drawer';

/**
 * Where the panel can sit, in the order the menu draws them.
 *
 * Three of the four a browser's devtools offers. There is no separate window: it was built and
 * taken out again, and the reason it is worth naming is that a stored preference can still say
 * `window` in a browser where somebody chose it. That is what the validation below is for, and
 * it is the case it exists for rather than a hypothetical one.
 */
export const PLACEMENTS = ['left', 'bottom', 'right'] as const;

export type Placement = typeof PLACEMENTS[number];

/** Bottom, because that is the one that existed before there was a choice. */
export const DEFAULT_PLACEMENT: Placement = 'bottom';

export interface Geometry {
  /** Docked bottom. */
  height: number;
  /** Docked left or right. */
  width: number;
}

export interface DrawerState {
  open: boolean;
  /** The conversation that was on top. May no longer exist; the panel checks. */
  active: string;
  placement: Placement;
  geometry: Geometry;
}

/**
 * Sizes a panel is allowed to be.
 *
 * A minimum because a terminal narrower than this is not one, and because a panel dragged to
 * nothing cannot be dragged back. A maximum expressed as a margin off the viewport, so a panel
 * sized on a large monitor and reopened on a laptop is still reachable rather than covering
 * everything including its own controls.
 */
export const MIN_SIZE = 220;
export const VIEWPORT_MARGIN = 80;

function defaultGeometry(): Geometry {
  return { height: 420, width: 520 };
}

function closed(): DrawerState {
  return {
    open: false, active: '', placement: DEFAULT_PLACEMENT, geometry: defaultGeometry(),
  };
}

/** A number from storage, or the default when it is not one. */
function size(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * What this browser last had open, and where.
 *
 * Every field is validated rather than trusted, which covers the ways this can be wrong: no
 * entry yet, storage that throws, JSON that does not parse, a value written by an older version
 * of this file with a different shape, and a hand-edited one. An unknown placement in particular
 * falls back to bottom rather than rendering a panel with no position at all.
 */
export function readDrawerState(): DrawerState {
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) || 'null');

    if (!stored || typeof stored !== 'object') {
      return closed();
    }

    const fallback = defaultGeometry();
    const geometry = (stored.geometry && typeof stored.geometry === 'object') ? stored.geometry : {};

    return {
      open:      stored.open === true,
      active:    typeof stored.active === 'string' ? stored.active : '',
      placement: PLACEMENTS.includes(stored.placement) ? stored.placement : DEFAULT_PLACEMENT,
      geometry:  {
        height: size(geometry.height, fallback.height),
        width:  size(geometry.width, fallback.width),
      },
    };
  } catch {
    return closed();
  }
}

/**
 * Remember it, and carry on if that is not possible.
 *
 * A browser that refuses to store this is a browser where the panel opens at the bottom every
 * time, which is a smaller thing than a panel that throws while somebody is dragging it.
 */
export function writeDrawerState(state: DrawerState): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private mode, a full quota, or storage disabled for this origin.
  }
}
