# agents

The terminal, the agent pod and its conversations, as one Rancher UI extension every other
extension can borrow from.

Install it and three things happen on every page of the dashboard, none of them a page of
its own:

- **The agent pod.** One claude in the cluster (`extension-studio-agent`, in the
  `extension-studio` namespace, on a hostPath that outlives it), made from the files under
  `pkg/agents/seed` and kept current with them. It runs as a cluster-admin ServiceAccount
  and is handed the Rancher identity of whoever opens a pane, so it can reach every pod and
  ask the cluster anything.
- **The drawer.** `ctrl+shift+backtick` opens a panel of conversations with that pod, docked
  to an edge, from anywhere in Rancher. Admins only; see `overlay.ts` for why.
- **`window.__agents`.** The terminal as a Vue component, and the pod's conversations as
  functions - list, start with a name and an opening prompt, rename, end, read a pane - so an
  extension places a pane where it wants one: Extension Studio's editor opens it onto its
  dev-server pods, the Dev extension onto a workspace's conversations, a review agent, a
  discussion under a comment. See `public-api.ts`.

This code lived in Extension Studio until 0.5.93. The pod, its namespace and its data keep
their names from then, so nothing anybody had is lost, and the Studio makes the same
namespace and account when it is installed first; either order works.
