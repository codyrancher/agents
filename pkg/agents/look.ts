// How the chat and its file viewer look, as one preference shared by every pane in the
// dashboard: the Studio's drawer, a workspace's conversations, a review's. localStorage, so
// it is the person's and survives a reload; every pane reads it on mount and writes it from
// its Appearance menu, and the file viewer reads and writes the `files` part from its own
// header, so a choice made in one place is the choice everywhere.
export const LOOK_KEY = 'mc-chat.look';

export interface Look {
  size: 'small' | 'medium' | 'large';
  density: 'compact' | 'comfortable';
  /** User messages in a bubble, or flat like the rest. */
  bubbles: boolean;
  /** Thinking rows open by default. */
  thoughts: boolean;
  /** Tool input and output open by default. */
  toolIo: boolean;
  times: boolean;
  /** Files the chat opens: markdown rendered and code highlighted, or the bytes as they are. */
  files: 'rendered' | 'raw';
}

export const LOOK_DEFAULTS: Look = {
  size: 'medium', density: 'comfortable', bubbles: true, thoughts: false, toolIo: false, times: true, files: 'rendered',
};

export function readLook(): Look {
  try {
    return { ...LOOK_DEFAULTS, ...JSON.parse(localStorage.getItem(LOOK_KEY) || '{}') };
  } catch {
    return { ...LOOK_DEFAULTS };
  }
}

export function writeLook(look: Look): void {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch { /* a browser without storage keeps it for this visit */ }
}
