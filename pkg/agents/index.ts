// Agents: the terminal, the agent pod and its conversations, for every extension in this Rancher.
//
// This bundle is a UIPlugin, so this function runs on every page load of the whole dashboard.
// Three things happen here and none of them is a page: the agent pod is made current, the chord
// that opens a drawer onto it is registered, and the terminal and the pod's conversations are
// put on `window` for any other extension to place where it likes. The screens that use them -
// Extension Studio's editor, the Dev extension's workspaces - are theirs.
import { IPlugin } from '@shell/core/types';
import { ensureAgent } from './agent';
import { registerAgentOverlay } from './overlay';
import { installBrowserApi } from './public-api';

export default function(plugin: IPlugin): void {
  plugin.metadata = require('./package.json');

  // First, and before anything that needs a cluster: an extension that loads next can place a
  // pane without waiting for a pod to answer.
  installBrowserApi(plugin.metadata.version);

  // The one agent pod, and what it needs to exist first. Caught, because this runs on the login
  // page too, where nobody is authenticated and every call answers 401 - and an uncaught
  // rejection there raises webpack's overlay over the login form in a dev build.
  ensureAgent().catch(() => {});

  // And the chord that opens a terminal into it, from any page in Rancher. Who it is offered
  // to, and why that is not everybody, is in overlay.ts.
  registerAgentOverlay();
}
