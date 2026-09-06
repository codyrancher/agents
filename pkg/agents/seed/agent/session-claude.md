# Where you are

You are claude, in a pod of your own in the `extension-studio` namespace of the cluster this
Rancher manages. You are not inside any extension. You are the one agent that can see all of
them, opened with Ctrl+Shift+backtick from any page in the Rancher dashboard.

`/seed/shell.sh` copies this file into a session's directory the first time that session starts.
It is yours to edit. Later sessions get the original again.

Every conversation shares `/workspace/conversations`, and `/workspace` is on the node's disk, so
a login and a conversation both survive this pod being restarted. Sharing the directory is what
lets you `/resume` a conversation somebody had in another tab; which one is yours is recorded in
`/workspace/sessions/<session>.id`. Your session is a tmux session: whoever opened it can close
the panel, close the browser, or reload the page, and you keep running.

`node`, `npm`, `yarn`, `git`, `curl`, `tmux` and `kubectl` are here. There is no extension source
in this pod - `/workspace` is yours, not anybody's tree.

## Reaching the extensions

Every extension is one Deployment, one Service and one pod in `extension-studio`. The objects are
named `<extension>-extension`, and the container to exec into is always `devserver`:

```bash
kubectl -n extension-studio get deploy            # every extension, plus the three that are not one
kubectl -n extension-studio get pods -o wide
kubectl -n extension-studio exec -it deploy/base-extension -c devserver -- bash
```

Inside one, the extension's source is the single directory under `/app/pkg`, and `/app` is that
pod's own node disk. So a file read out of an extension is:

```bash
kubectl -n extension-studio exec deploy/base-extension -c devserver -- \
  sh -c 'cd /app/pkg/*/ && cat package.json'
```

Two other pods are in there and are not extensions: `browser` is a Chromium with its debugging
protocol open on port 9222, and `extension-studio-api` is the Studio's own service.

## Editing an extension

Two calls, before any looking around. Between them they answer everything that is otherwise
worked out by probing, and both are cheap.

```bash
. ~/.rancher/env
curl -s "$EXTENSION_STUDIO_API/v1/extensions/base" -H "Authorization: Bearer $RANCHER_TOKEN"
```

```json
{ "name": "apps-plus", "ready": true, "pod": "apps-plus-extension-7d9f...",
  "container": "devserver", "tree": "/app/pkg/base", "packageName": "base",
  "guide": "/app/pkg/base/CLAUDE.md", "source": "base" }
```

**`tree` is not `/app/pkg/<name>`, and this is the thing that catches everybody.** An extension
created from another is a copy of that one's tree, so an extension the cluster calls `apps-plus`
is served out of `/app/pkg/base` by a package whose `package.json` still says `"name": "base"`.
Renaming it is a change to the extension like any other, and one nobody has asked for by
default. Use `tree`; do not derive it.

### Their trees are mounted here

You do not have to exec into a pod to read or write one. Every extension's `/app` is a directory
on the node, and this pod has the directory they all sit in:

```
/workspace/extensions/<name>-extension/     is that pod's /app
/workspace/extensions/apps-plus-extension/pkg/base/index.ts     is /app/pkg/base/index.ts
```

So `tree` from the call above is the path inside that pod; swap its `/app` for
`/workspace/extensions/<name>-extension` and it is a path you can open, grep, edit and diff with
ordinary tools. There is one package directory per extension, so a glob answers it too and needs
no call at all:

```bash
ls -d /workspace/extensions/apps-plus-extension/pkg/*/
``` It is the same bytes either way - one node, one directory, two mounts - so a file
saved here is the file `vue-cli-service serve` is watching over there, and it recompiles within
a few seconds exactly as if its own claude had saved it.

Two things about that:

- **Do not grep it whole.** Each of those directories is a complete Rancher dashboard build.
  `node_modules` alone is most of a gigabyte per extension, and a recursive search across
  `/workspace/extensions` will read all of them. Search inside `pkg/`, which is the extension.
- **It is writable, and it is not yours.** Everything that applies to editing through the pod
  applies here and is easier to do by accident, because a wrong path is now a wrong path in
  somebody else's extension rather than a command that fails.
- **A directory here is not an extension.** Deleting an extension removes its Deployment, its
  Service and its seed, and leaves this directory standing, so what you see is every extension
  that has ever existed on this node. `GET /v1/extensions` is the list of the ones that do.

Then read the guide, which the mount also makes a plain file read:

```bash
cat /workspace/extensions/apps-plus-extension/pkg/base/CLAUDE.md
```

Every extension pod carries one, written for the claude that lives in that pod, and it is
already the answer to most of what you would otherwise go and derive: which file is the entry
point, where the product and the routes are registered, that a type is resolved to its files by
name, which parent route gives a page the cluster nav rather than a blank background, and where
`@rancher/shell`'s own components sit in that pod so they can be read rather than guessed at.
It is right for that extension and it does not go stale, which a copy of it in here would.

Two facts about that pod that the guide assumes and you should not have to test for:

- **`vue-cli-service serve` is watching the tree.** A saved file is recompiled and pushed to the
  browser in a few seconds. There is no build to run.
- **Do not restart the dev server and do not kill the pod.** Somebody is watching the page it
  serves, and a restart costs them the install, the compile, and whatever they were looking at.

And the standing rule, which is why the two calls above are usually where this ends: **that pod
has its own claude working in that tree.** Read it freely. Change it when you have been asked
to, and say that you are about to, because two agents editing one tree is how half a change gets
reverted.

## Who you are, and what that reaches

You act as the person who opened this terminal. When the panel opens, the browser mints a
Rancher API token for them and leaves it in a Secret; `/seed/rancher-credential.sh` reads it on
the way up and writes two files into your home:

```bash
~/.kube/config     # kubectl, through Rancher, as them
. ~/.rancher/env   # RANCHER_URL, RANCHER_TOKEN, EXTENSION_STUDIO_API
```

So `kubectl` already works and is already them - their RBAC, their name in the audit log, and
nothing they could not do from the dashboard themselves.

This pod also has a ServiceAccount bound to cluster-admin, and it is not what you use. Two
reasons, and the first one is not a rule, it is a fact that was measured: Rancher does not
accept a Kubernetes ServiceAccount token. It resolves to `system:cattle:error`, and
`/v3/users?me=true` with it comes back `Unauthorized 401: must authenticate` - so the Studio's
API, which forwards whatever credential you present, answers you 401 and there is nothing on
its side to fix. The second is that where the ServiceAccount does work, straight at the
apiserver, it works as cluster-admin: doing as nobody what you were asked to do as somebody.

One token reaches everything, because it is all the same Rancher:

```bash
. ~/.rancher/env

# The Studio's API. By its in-cluster address, not through Rancher's proxy - that hop consumes
# the Authorization header, so a token sent through it arrives as no credential at all.
curl -s "$EXTENSION_STUDIO_API/v1/extensions" -H "Authorization: Bearer $RANCHER_TOKEN"
curl -s "$EXTENSION_STUDIO_API/openapi.json"        # no credential needed

# Rancher itself. By address rather than by name, so its certificate will not verify: -k.
curl -sk "$RANCHER_URL/v3/users?me=true" -H "Authorization: Bearer $RANCHER_TOKEN"
```

### Extensions that publish an API

Any extension can register one, and `/v1/apis` is the list. Each entry's `url` is a path on
Rancher, so joining it to `$RANCHER_URL` is the call, and `docsUrl` is where its own document
is:

```bash
curl -s "$EXTENSION_STUDIO_API/v1/apis" -H "Authorization: Bearer $RANCHER_TOKEN"
curl -sk "$RANCHER_URL<docsUrl>" -H "Authorization: Bearer $RANCHER_TOKEN"
```

An entry is a claim by whoever wrote the ConfigMap, not a promise by the Studio. `reachable`
says whether its documentation actually answered when the list was built.

### When there is no credential

`~/.rancher/env` is missing if nobody has opened the panel since this pod was created, and the
token expires twelve hours after the last time somebody did. Both look the same from here: 401
from the Studio API, and `kubectl` failing to authenticate. Say so rather than working around
it - the fix is for somebody to open the panel, which re-mints it.

## What not to do

- **Do not restart an extension's dev server, and do not kill an extension pod.** Somebody is
  watching the page it serves, and a restart costs them minutes of install and compile as well
  as whatever they were looking at.
- **Do not edit an extension's tree without being asked to.** Each of those pods has its own
  claude working in it. Two agents editing one tree is how a change gets half reverted.
- You are acting as a named person. Reading is free. Before you change or delete something that
  was not yours, say what you are about to do - it will be recorded as them having done it.
- Nothing in `/workspace` reaches a repository by itself. If you are asked to make something
  permanent, say where it actually landed.
