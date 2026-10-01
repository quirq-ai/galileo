# Why galileo works the way it does

The decisions behind galileo, each with what it costs. When a change goes
against one of them, update this file in the same change.

[ARCHITECTURE.md](ARCHITECTURE.md) shows how the parts fit together;
[REFERENCE.md](REFERENCE.md) has the exact routes, headers and files.
Decision 17 is where galileo is going, and [ROADMAP.md](ROADMAP.md) has the
plan.

## Scope

### 1. galileo routes to ports; it starts nothing

An app is a name for a port or a URL. galileo forwards to whatever answers
there, and never runs a command, watches a folder, or manages a process.

- **Why**: the gateway stays small and predictable, and apps run however you
  already run them: a terminal, an editor, a container, a deployment. Nothing
  galileo does can start code on this machine.
- **Cost**: an app has to be running, and added by name, before its address
  works. Until it answers, its pages get a waiting page that retries.

## Addresses

### 2. Every app and every version gets a hostname, not a path

`acme.localhost:4100` is acme's default version, `dev.acme.localhost:4100` its
dev version. galileo never mounts an app under a path such as `/acme/`.

- **Why**: apps write absolute URLs everywhere: links, `/_next/static/…`
  assets, API calls, redirects, hot-reload sockets. With a path prefix the
  first absolute URL escapes the prefix and lands on the wrong app, unless
  every app is configured with a base path. A hostname keeps every request on
  the version the page came from, for any app, with nothing to configure.
- **Also**: each app and version is its own origin, so they never share
  cookies, storage, service workers or HTTP cache, and live and dev can be
  open side by side.
- **Cost**: one hostname per app and version, which needs the next decision.
- **Where**: `routeForHost` and `appUrl` in `src/targets.mjs`.

### 3. `*.localhost`, with no DNS setup

- **Why**: browsers resolve `localhost` and every name under it to this
  machine (RFC 6761), nested names included, so there is no `/etc/hosts` entry,
  no local DNS server and no certificate to install.
- **Cost**: Safari before macOS 26 doesn't resolve `*.localhost`. Tools that do
  their own DNS (some CLIs) may not either; they can call the app's own port.

### 4. One port, and the bare host is the control plane

`localhost:4100` is galileo's own: its home page, the launcher and the admin
API. It is never proxied, so no app code ever runs on that origin.

- **Why**: that makes the bare host the one place allowed to add and remove
  apps and to change any app's design. An app's page, on its own origin, can't
  reach those routes (decision 10).
- **Cost**: the bare host can't also be an app. When galileo is mounted in
  another server, that server keeps the bare host and galileo keeps only
  `/__xo/*` there (decision 14).

### 5. A version is picked by hostname, and a path only redirects

`acme.localhost:4100/live/pricing` answers `302` to
`live.acme.localhost:4100/pricing`. Only page navigations are redirected,
never fetches, and version hosts pass every path through.

- **Why**: a short way to open another version from the address bar, without
  taking a path away from the app: its own `/live` page still works on any
  version host.
- **Where**: `versionPick` in `src/targets.mjs`.

## Carrying telescope into pages

### 6. One script tag appended to each HTML page, not an SDK

galileo appends `<script async data-xo-toolbar … src="/__xo/toolbar/loader.js">`
after the last byte of every HTML document it proxies, the way Vercel's edge
adds its toolbar to preview deployments. The script loads telescope.

- **Why**: apps change nothing: no package, no build plugin, no code. It works
  for any framework, and the same app runs with or without galileo.
- **Streaming**: the tag is appended as the body streams through (a
  `Transform` that adds it at the end), so streamed HTML stays streamed and
  the page never waits for galileo.
- **Compression**: galileo asks upstreams for `accept-encoding: identity`, which
  costs nothing on a loopback hop. An upstream that compresses anyway is passed
  through without the tag rather than corrupted.
- **Opt out**: the `x-xo-skip-toolbar` request header, or `?xo_toolbar=off`.
- **Where**: `shouldInject` and `loaderTag` in `telescope/server/inject.mjs`.

### 7. Rewrite security headers only as much as the tag needs

| Change | Reason |
| --- | --- |
| `X-Frame-Options` and CSP `frame-ancestors` removed | so XO can show the page in a frame |
| a nonce added to `script-src`, only if the policy already trusts nonces, hashes or `'strict-dynamic'` | the tag carries it |
| `'self'` added to a `script-src` that only lists sources | the loader comes from the page's own origin |
| never a nonce on a policy that relies on `'unsafe-inline'` | browsers ignore `'unsafe-inline'` once a nonce is present, which would switch off the page's own inline scripts |
| `'self'` added to `connect-src`, `img-src`, `media-src` | telescope's API and captures are same-origin |
| `default-src` copied into explicit directives, never widened | `default-src` also governs styles, fonts and frames |

- **Why**: a page's policy is the app's decision. galileo loosens exactly what
  telescope needs and nothing else.
- **Cost**: a CSP in a `<meta>` tag isn't seen, only headers are.
- **Where**: `rewriteSecurityHeaders` in `telescope/server/inject.mjs`.

### 8. Everything telescope needs is served from the page's own origin

Its bundles (`/__xo/toolbar/*`), its API (`/__xo/api/*`) and captures
(`/__xo/uploads/*`) all live under `/__xo/` on each app host.

- **Why**: same-origin requests pass the page's CSP with `'self'`, need no
  CORS, and scope every request to one app by its hostname.
- **Isolation**: telescope keeps to itself inside the page. Its UI sits in a
  closed shadow root and its code runs in a hidden same-origin iframe, so the
  page's styles and globals don't break it, and its own don't leak out.
- **Cost**: `/__xo/` is reserved on every app host; an app's own `/__xo/…`
  routes can't be reached through galileo.

## Trust

### 9. Listen on 127.0.0.1 only

- **Why**: galileo can reach anything on this machine, and the apps behind it
  are dev servers not meant for the network.
- **Cost**: other devices can't open the apps through galileo.

### 10. Two APIs with different powers

| | Admin API | An app's API |
| --- | --- | --- |
| Origin | `localhost:4100`, where no app code runs | `<app>.localhost:4100`, the app's own |
| Can | add and remove apps and versions, pick default versions, change any design | read and write this app's threads, captures and design, record agent requests, read the list of apps |
| Guard | same-origin requests only, and changes must be JSON | same-origin requests only |

- **Why**: telescope runs inside the app's page, so anything telescope can
  do, the app can do too. Giving that origin only its own data keeps a page
  from touching other apps or the set of apps. The JSON rule means a plain HTML
  form on another site can't post a change.
- **Also**: uploads come back to pages without their place on disk.
- **Where**: the admin API and an app's list of apps in `src/server.mjs`
  (`handleLauncher`, `handleXo`); an app's API and every design in
  `telescope/server/api.mjs` (`handleApp`, `handleGateway`). Both use
  `guardSameOrigin` and `requireJson`, kept in `src/server.mjs` and in
  `telescope/server/http.mjs`.

## Building galileo

### 11. No dependencies, no build step

Plain ESM JavaScript on Node 20+, with only Node's own modules, and plain
classic scripts for telescope's browser code, joined into bundles as they are
served.

- **Why**: a gateway in front of every app on a machine should be small enough
  to read, and start from a fresh clone with nothing to install.
- **Cost**: proxying and streaming are written by hand, and covered by tests
  instead of a framework.

### 12. telescope lives in this repo, under its new name

telescope, the bar in every page, was its own project, xo-toolbar, found as a
sibling checkout or an installed package. It is now `telescope/` in galileo,
with its server side too: `telescope/server/` holds its `/__xo/` routes
(`createTelescope`), its page rules (`inject.mjs`) and what it keeps
(`store.mjs`, `uploads.mjs`). galileo's `src/` only routes and proxies.

- **Why**: galileo and telescope change together (the tag, the routes, the
  API, the design schema), and a fresh clone of galileo now runs on its own.
- **The name**: text people read says telescope. Wire names keep "toolbar"
  (`/__xo/toolbar/*`, `/__xo/api/toolbar(s)`, `data-xo-toolbar`,
  `window.__xo_toolbar`, `x-xo-skip-toolbar`, `data/toolbars/`), so pages,
  hosts such as xo-client, and saved designs keep working.
- **Cost**: the code and its docs use two names for one thing.

### 13. Pure rules, tested without a server

Routing, names and header rewrites are pure functions (`src/targets.mjs`,
`telescope/server/inject.mjs`). End-to-end tests run real gateways in front of
the sample app. telescope's page rules, bundles and schema have tests of their
own, in `telescope/test/`. Everything runs
under `node --test`.

### 14. A library first, and a server second

`createGateway()` returns `handle`, `upgrade` and `owns`, so another server can
mount galileo on its own port. xo-client does: `localhost:3000` is XO's UI, and
`*.localhost:3000` and `/__xo/*` are galileo's. `npm start` is the same library
behind its own listener.

### 15. State is plain files

Apps, threads, designs and agent requests are JSON or JSON Lines in `data/`,
captures are files per app, and whole-file writes go through a temporary file
and a rename.

- **Why**: easy to read, to back up, and for an agent to open. No database to
  run.
- **Cost**: one galileo per data folder. Two processes sharing one overwrite
  each other's threads and apps; give each its own `XO_GATEWAY_DATA`.

### 16. Agent requests are handed off, not run

*Ask the agent* appends the request, with each capture's file path, to
`data/agent-requests.jsonl` and prints it.

- **Why**: galileo is only the gateway. Running an agent turn belongs to the XO
  runtime, which should confirm a request before acting on it.
- **Today**: nothing reads the file yet; it is the hand-off point.

## Direction

### 17. galileo grows into an inspector, and still starts nothing

galileo is to inspect anything on this machine through telescope: apps on
ports and deployments at URLs, as today, and next local files and folders,
and the traffic it carries to an app's port. The plan is
[ROADMAP.md](ROADMAP.md).

- **Why**: XO's agents, and the people working with them, move between
  running apps, deployments and files on disk. One place to open any of them,
  with the same bar to point at a part, comment, capture and ask an agent,
  keeps the loop between a person and an agent short.
- **What stays**: decision 1. Inspecting is reading and recording: a folder
  is served and never run, and nothing new starts a process.
- **Cost**: more to keep safe. Files need path rules (nothing outside the
  folder, no hidden files, no paths shown to pages), and traffic needs privacy
  rules (secrets masked, kept in memory on this machine).
- **Today**: planned. Until a part ships, the other docs describe only what
  works.
