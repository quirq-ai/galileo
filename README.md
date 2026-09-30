# galileo

The XO gateway (formerly xo-gateway). It puts every app on this machine behind
one port, each at its own address: every folder of your XO root, with its dev
server started when you open it, and any app you add, each with any number of
versions (a dev server, the live deployment, a preview). It appends one
`<script>` tag to every HTML page it serves, the way Vercel's edge does on
preview URLs, which loads the XO toolbar: its own project,
[xo-toolbar](../xo-toolbar).

galileo also keeps what the toolbar produces: comments, screenshots and
recordings, toolbar designs, and requests for the agent. Its home page says
what it routes right now and how it works.

No dependencies besides xo-toolbar. Node 20+.

## Run it

```bash
npm install     # links ../xo-toolbar; optional when both checkouts sit side by side
npm start       # http://localhost:4100
```

| Address | What it is |
| --- | --- |
| <http://localhost:4100/> | the home page: every route, live, and how galileo works |
| <http://localhost:4100/launcher> | the launcher: add and remove apps and versions, start and stop folders, toolbar designs |
| `<folder>.localhost:4100` | a folder of the XO root: its dev server, started when you open it, or its files |
| `<version>.<name>.localhost:4100` | one version of an app |

Settings come from the environment, or from `.env.local` beside this README
(see `.example.env`); what the shell sets wins.

| Variable | Default | What it does |
| --- | --- | --- |
| `XO_PROJECTS_ROOT` | `~/xo-projects` | The XO root, as xo-space calls it: every folder in it is an app, except xo-space's own `agents`, `memory`, `state` and `projects`. `--root` replaces it. |
| `PORT` | `4100` | Where galileo listens, on `127.0.0.1` only. `--port` wins. |
| `XO_GATEWAY_DATA` | `data/` | Where comments, captures, designs and added apps are kept. |
| `XO_TOOLBAR_DIR` | the package, else `../xo-toolbar` | Another xo-toolbar checkout. |

Put galileo in front of other apps too. The left side of each `--target`
reads like the address it creates; the first version given is the default:

```bash
node src/server.mjs --target dev.web=5173 --target live.web=https://web.vercel.app --target docs=localhost:3001
```

```bash
npm test          # rules, names and routing, uploads, designs, the pages, and end-to-end runs through several apps
```

### The demo

```bash
npm run demo
```

| Address | What it is |
| --- | --- |
| <http://acme.localhost:4100/> | Acme Notes, its default version (dev), with the toolbar |
| <http://dev.acme.localhost:4100/> | Acme Notes, dev build on :4174: a "Dev build" note and a new Team price |
| <http://live.acme.localhost:4100/> | Acme Notes, live build on :4173 |
| <http://acme.localhost:4100/live/pricing> | picks the live version: redirects to `live.acme.localhost:4100/pricing` |
| <http://xo.localhost:4100/> | whatever serves :3000 (xo-client's dev server), with the toolbar |
| <http://localhost:4173/> | Acme Notes as its own server sends it: no toolbar, and it refuses to be framed |
| `<folder>.localhost:4100` | any folder next to this checkout: its dev server, started when you open it, or its files |

### Where the toolbar comes from

The gateway loads xo-toolbar from, in order: `XO_TOOLBAR_DIR` (another checkout),
the installed package (`npm install` links `../xo-toolbar`), or a sibling
checkout at `../xo-toolbar`. It serves the toolbar's bundles and checks every
design it saves with the toolbar's own schema (`src/toolbar.mjs`).

## Mounted in another server

galileo also runs inside another server on that server's port. xo-client
mounts it this way, so the XO UI and every app share `localhost:3000`:

```js
import { createGateway } from "galileo";

const gateway = createGateway({ port, dataDir, targets });
server.on("request", (req, res) => (gateway.owns(req) ? gateway.handle(req, res) : app(req, res)));
server.on("upgrade", (req, socket, head) => (gateway.owns(req) ? gateway.upgrade(req, socket, head) : appUpgrade(req, socket, head)));
```

- `owns(req)` (`ownsRequest` in `src/targets.mjs`) claims every `*.localhost`
  host, registered or not, and `/__xo/*` on the bare host: the API and the
  toolbar's files. The bare host's pages stay the other server's, so the home
  page and the launcher aren't shown there; the host lists apps itself
  (xo-client's Apps module uses the same API).
- `port` is the port the host listens on, used for addresses in responses when
  a request's `Host` has none.
- `addAppsIn` names where the host adds apps, for the link on the gateway's
  404 pages: "Add one in the launcher" by default, "Settings › Apps" in
  xo-client. `addAppsAt` is the bare-host path that link opens: `/launcher`
  by default, `/` when `addAppsIn` is the host's own.
- `index.mjs` is the library entry: `createGateway`, `ownsRequest`,
  `parseTargetSpec`, `appUrl`, `logApp` and `logFolders`.
  `test/mounted.test.mjs` runs the gateway this way.
- `roots`, `exclude` and `idleMinutes` serve folders as apps (see
  [Every folder is an app](#every-folder-is-an-app)). Await `close()` before
  the process exits, so dev servers the gateway started stop with it.
  xo-client does both.

## Apps and versions are reached by name

```
localhost:4100                ─▶ the home page (galileo's own, never proxied)
localhost:4100/launcher       ─▶ the launcher (galileo's own, never proxied)
acme.localhost:4100           ─▶ acme's default version
dev.acme.localhost:4100       ─▶ http://127.0.0.1:4174   (acme's dev version)
live.acme.localhost:4100      ─▶ http://127.0.0.1:4173   (acme's live version)
acme.localhost:4100/live/…    ─▶ 302 to live.acme.localhost:4100/…
<unknown>.localhost:4100      ─▶ 404 page listing the real apps
beta.acme.localhost:4100      ─▶ 404 page listing acme's versions
```

- **Each app and each version is its own origin**, so they never share cookies, storage, service workers or HTTP cache.
- **Everything a page loads stays on its version**: links, assets, API calls, redirects and hot-reload sockets all go to the host the page came from, so any app works, with no base path to configure.
- **A path picks a version**: on an app's own host, a page address that starts with a version's name redirects to that version's host, keeping the rest of the address. Only page loads are picked, never fetches, and version hosts pass every path to their app, so an app's own `/live` page stays reachable at `live.acme.localhost:4100/live`.
- **Switching is just going to another address**: the toolbar's navbar opens the same page on another version, or another app at its root, and the app's own host serves whichever version is its default.
- **Browsers resolve `*.localhost` to this machine**, nested names included, with no DNS setup (Chrome, Firefox, and Safari from macOS 26).

Apps come from `--target` flags plus apps and versions added in the launcher
(saved to `data/targets.json`). On a clash, the flags win; a default chosen in
the launcher is kept. An app named without a version gets one called `main`.
Names are DNS labels: lowercase letters, digits and inner dashes.

## Every folder is an app

`npm start` serves the XO root. Give galileo other roots instead and every
folder in them gets its own address, by its name, with nothing to register:

```bash
node src/server.mjs --root ~/work              # web.localhost:4100, docs.localhost:4100, … for every folder in ~/work
node src/server.mjs --root ~/work --idle 10    # stop the dev servers it started after 10 idle minutes (default 30)
```

The demo's root is the folder that holds this checkout; `XO_GATEWAY_ROOTS`, a
list split like `PATH`, picks others, in the demo and in xo-client. As a
library: `createGateway({ roots, exclude, idleMinutes })`. A root given as
`{ dir, projectsOnly: true }` makes apps of its xo-projects only (folders with
`.xo/project.json`); xo-client passes its `XO_PROJECTS_ROOT` that way.

- **Names**: the folder's name as a DNS label: lowercase, anything else a
  dash, 40 characters at most (`My Notes_2026` is `my-notes-2026.localhost`).
  Hidden folders, `node_modules`, the gateway's own checkout and `exclude`
  are skipped. The same name in a later root gets `-2`, `-3`.
- **New folders appear by themselves**: roots are watched and rescanned every
  10 seconds, and a name nobody knows rescans before it gets a 404.
- **An app added by name keeps its versions**: a folder with the same name
  joins it as one more version (`dev` or `files`), unless the app already has
  a version by that name.

A folder is served by the first of these it has:

| | Serves | Version |
| --- | --- | --- |
| 1 | its own `.claude/launch.json`: the first configuration that runs inside the folder (one that `cd`s through `..` or to an absolute path runs a neighbour, and is skipped) | `dev` |
| 2 | an entry in its root's `.claude/launch.json` that names it: `--prefix web`, `--dir web`, `--directory web`, `-C web`, `--cwd web`, `sh -c "cd web && …"` or a `web/…` path | `dev` |
| 3 | its `package.json`'s `dev` script, else `start`, run with pnpm, yarn, bun or npm by its lockfile | `dev` |
| 4 | its files: `index.html`, else a listing to browse | `files` |

### Dev servers start when you open them

A runnable folder's address goes to the server the gateway started for it, else
to one already listening from inside the folder (another terminal, an editor,
xo-client's own, found with `lsof` and never stopped by the gateway), else to
a new one. When the folder's command names a port, only a server on that port,
or one run from the folder itself, is the folder's; otherwise any server run
from inside it is, except one in a nested checkout (a subfolder with its own
`.git` or `.xo/project.json`). So a folder holding other projects never adopts
their servers.

A new one starts like this:

1. The command runs in its own process group with `PORT` set to a free port,
   `HOST=127.0.0.1` and `BROWSER=none`. It is ready when anything in that group
   answers HTTP, so a tool that ignores `PORT` is found where it did listen. A
   configuration's `port` counts only if nothing answered there before.
2. Meanwhile a "Starting web" page shows the command and where it runs, and
   reloads every second until the app answers; anything that isn't a page gets
   `503` with `Retry-After`. If the command fails, the page shows its error,
   the last lines of its output and a *Try again* button.
3. It stops after `--idle` minutes without a request, and every server the
   gateway started stops with the gateway (`close()`, `SIGINT`, `SIGTERM`).

**Only your own page loads start servers.** A typed address, or a navigation
from a page on this machine (the launcher, xo-client, another app), starts one.
A fetch, an image, a frame, or a link from another site gets the "isn't
running" page instead, whose *Start* button is a same-origin form post
(`mayStart` in `src/server.mjs`). Hot-reload WebSockets are tunnelled only
while the server runs.

### Folders served as files

A folder with nothing to run gets a small file server on a loopback port,
proxied like any app, so its pages carry the toolbar too. Hidden files and
folders (`.env`, `.git`, `.xo`) are never listed or served, nothing outside the
folder is, symlinks included, and `node_modules` isn't listed. It answers only
`GET` and `HEAD`, and only requests addressed to `127.0.0.1` or `localhost`,
as the gateway's are: a page elsewhere that points its own name at this machine
gets nothing.

The launcher lists every folder with what serves it and its state, with *Open*,
*Start* and *Stop*.

## Toolbar designs

A design says which tools the bar shows, in what order, where it docks, its
labels and accent color (the schema is in xo-toolbar's README). Every app gets:

1. its own design, if it has one (`data/toolbars/<app>.json`), else
2. the gateway's default design (`data/toolbars/_default.json`), else
3. the toolbar's built-in design.

Designs are edited with the toolbar's own editor, in two places:
- **The launcher**: *Edit the default toolbar* for the gateway's default, and
  each app's *Toolbar* button for that app, both with a live preview.
- **The app itself**: *Customize* in its toolbar (the sliders button), or by
  dragging the bar to another dock. A change there gives that app its own design.

Changes save as they are made. An open app picks up a design changed in the
launcher when you return to its tab. The files can also be edited by hand; the
gateway checks them when it reads them.

## How a request is routed

```
                        ┌───────────────────────── gateway :4100 ─────────────────────────┐
request ──────────────▶ │ Host = localhost          ─▶ home, launcher, API, designer.js   │
                        │ Host = [<version>.]<name>.localhost ─▶ that app's version:      │
                        │     /__xo/toolbar/*       ─▶ xo-toolbar's bundles               │
                        │     /__xo/uploads/*       ─▶ that app's captures (byte ranges)  │
                        │     /__xo/api/*           ─▶ that app's toolbar API             │
                        │     WebSocket upgrade     ─▶ raw tunnel to that version         │
                        │     /<version>/… page     ─▶ 302 to that version (own host only)│
                        │     anything else         ─▶ proxied to that version ──▶ :4174  │
response ◀───────────── │ HTML document? no  ─▶ piped through untouched                   │
                        │                yes ─▶ headers rewritten, body streamed,         │
                        │                       loader tag appended after the last byte   │
                        └─────────────────────────────────────────────────────────────────┘
```

1. `routeForHost` (`src/targets.mjs`) turns the `Host` header into galileo's own pages,
   a version of a registered app, or an unknown name or version, which never
   falls through to another app or version. `versionPick` handles `/<version>/…`.
2. `/__xo/*` on an app's host stays in the gateway (`handleToolbar`).
3. WebSocket upgrades are tunnelled, so Vite and Next.js hot reload keep working.
4. Everything else is proxied. `shouldInject` (`src/inject.mjs`) decides whether
   a response is a page; pages get rewritten headers and the tag appended as the
   body streams through, so streamed HTML stays streamed.
5. If the version is down, a "Waiting for <name>" page retries every 2 seconds
   and still carries the toolbar. A folder app that isn't running gets its
   "Starting" page, or a *Start* button when the request may not start it.

### What changes in a page's headers

| Header | Change | Why |
| --- | --- | --- |
| `X-Frame-Options` | removed | so XO's Browser pane can frame the page |
| CSP `frame-ancestors` | removed | same reason; it overrides `X-Frame-Options` |
| CSP `script-src` with a nonce, hash or `'strict-dynamic'` | gateway nonce added | the tag carries that nonce |
| CSP `script-src` that lists sources only | `'self'` added if missing | the loader comes from the page's own origin |
| CSP with `'unsafe-inline'` and no nonce | never given a nonce | a nonce would switch the page's own inline scripts off |
| CSP `connect-src`, `img-src`, `media-src` | `'self'` added if missing | the toolbar's API, and captures shown back from `/__xo/uploads/` |
| CSP with only `default-src` | explicit copies of it with the above | `default-src` itself is left alone |
| `Location` pointing at the app | rewritten to the app's name on the gateway | redirects stay on the gateway |
| `Set-Cookie` `Domain=` | removed | a cookie for the app's domain would be dropped on the gateway's host |

## The APIs

**Each app's toolbar API**, under `<name>.localhost:4100/__xo/api/`, accepts
requests only from that app's own origin (`Sec-Fetch-Site: same-origin`).

| Route | Does |
| --- | --- |
| `GET /threads?page=/pricing` | this app's threads for one page |
| `POST /threads` | new thread; an empty `nodeId` makes it about the whole page; `attachments` are upload ids |
| `POST /threads/:id/comments` | reply (404 from any other app) |
| `PATCH /threads/:id`, `DELETE /threads/:id` | resolve, reopen, delete |
| `POST /uploads` | a PNG, JPEG, WebP, WebM or MP4 as the raw body (150 MB at most) |
| `DELETE /uploads/:id` | discard a capture |
| `POST /agent` | `{ ask, page, element?, attachments?, logs?, environment }`, recorded with the version it came from |
| `GET /toolbar`, `PUT /toolbar`, `DELETE /toolbar` | this app's design, with where it came from |
| `GET /targets` | the gateway's apps and their versions for the navbar, which one this page is, and where apps are managed (`manageIn`); a folder shows its place on disk as a `~` path, never its dev server's details: read-only |
| `POST /start?next=/path` | start this folder app's dev server (the *Start* button's form), then `303` to `next` |

Comments, captures and designs belong to the app, shared by all its versions;
each thread records the version it was started on.

**The launcher's API**, under `localhost:4100/__xo/api/`, is the only place
apps can be added or removed and the only place one app's design can be changed
from outside it. No app code runs on that origin. Changes must be JSON, from
the launcher's own origin.

| Route | Does |
| --- | --- |
| `GET /targets` | every app with its versions, their addresses and whether they answer; a folder's app also has `source` (`added`, `folder`, `added and folder`) and `folder` (`dir`, `serves`, `from`, `xoProject`, `server`), and its folder version a `state` (`files`, `running`, `starting`, `stopped`, `failed`) and `external` |
| `POST /targets` | `{ "name": "acme", "version": "live", "upstream": "https://acme.vercel.app" }` adds an app or a version (no version: `main` for a new app, the default version for an existing one) |
| `PATCH /targets/:name` | `{ "defaultVersion": "live" }`: what the app's own host serves |
| `DELETE /targets/:name`, `DELETE /targets/:name/versions/:version` | remove an app, or one of its versions (an app keeps at least one) |
| `GET /toolbars` | the default design and every app's design, with their sources |
| `PUT /toolbars/_default`, `DELETE /toolbars/_default` | set the gateway's default design, or go back to the built-in one |
| `PUT /toolbars/:name`, `DELETE /toolbars/:name` | set an app's own design, or hand it back the default |
| `POST /folders/:name/start`, `POST /folders/:name/stop` | start a folder's dev server, or stop one the gateway started (`400` for a folder served as files, `409` for a server it didn't start) |

**Ask the agent** is where the toolbar hands off. The gateway appends the
request to `data/agent-requests.jsonl`, with each capture's file path so an
agent can open it, and prints it:

```
[gateway] acme (dev): ask the agent on /pricing: "The plan cards need more room" (+ image …/data/uploads/acme/u_….png; 3 log entries)
```

In XO, this route belongs in xo-space, which would turn it into a turn of the
project's Claude Code or Codex session.

## Data

```
data/targets.json            apps and their versions: { name, defaultVersion, versions: [{ name, upstream }] }
data/threads.json            every app's comment threads
data/agent-requests.jsonl    requests for the agent, one per line
data/toolbars/_default.json  the gateway's default design
data/toolbars/<app>.json     an app's own design
data/uploads/<app>/u_….png   screenshots and recordings, per app
```

A thread keeps the fields Vercel's toolbar uses, plus the app name and an
`anchor` for re-finding its element; comments may carry `attachments`:

```json
{
  "id": "t_…", "target": "acme", "version": "dev", "page": "/pricing",
  "nodeId": "[data-testid=\"plan-team\"]>p,#plans>article:nth-of-type(2)>p",
  "anchor": { "tag": "p", "textQuote": "Most teams pick this", "offsetX": 0.5, "offsetY": 0.5 },
  "status": "open",
  "comments": [{ "id": "c_…", "text": "…", "author": "Local user", "createdAt": "…",
                 "attachments": [{ "id": "u_…", "url": "/__xo/uploads/u_….png", "type": "image/png", "kind": "image", "size": 177424 }] }]
}
```

## Files

```
src/server.mjs     host routing, proxy, tunnel, toolbar bundles, both APIs
src/targets.mjs    app and version names, the registry, routing by Host, picking a version by path
src/inject.mjs     pure rules: which responses get the tag, header rewrites, the tag
src/store.mjs      threads, agent requests and designs on disk
src/uploads.mjs    captures on disk, served with byte ranges
src/toolbar.mjs    finds xo-toolbar
src/discover.mjs   folders as apps: names, what serves each one, watching the roots
src/runner.mjs     dev servers: started on demand, found already running, stopped when idle
src/processes.mjs  listening servers and their folders, from lsof
src/files.mjs      folders served as files
home/              the home page: every route, live, and how galileo works
launcher/          the launcher page, with the design editor
sample-app/        Acme Notes, a three-page site with strict security headers, in a live and a dev build
demo.mjs           both builds as acme's live and dev versions, plus xo and every folder of the workspace, behind one gateway
test/              node --test suites
```

## Limits

- On an app's own host, a page load of `/<version>/…` always goes to that
  version. An app page with the same name as one of its versions is still
  reachable on any version's own host.
- A CSP delivered in a `<meta>` tag is not rewritten; only headers are.
- An upstream that ignores `accept-encoding: identity` and compresses HTML is
  passed through without the toolbar rather than corrupted.
- The toolbar runs in the same page as the app, so the app could call its own
  toolbar API. Nothing there is privileged; in XO, an agent request should still
  be confirmed on XO's side before it runs.
- Safari before macOS 26 can't resolve `*.localhost`.
- Opening a folder's address runs that folder's own dev command, as
  `npm run dev` there would. Put only folders you trust under a root.
- `HOST=127.0.0.1` is a hint: Next.js dev ignores it and listens on every
  interface, as `python3 -m http.server` does without `--bind`. What a started
  server exposes beyond this machine is up to its own command.
- Folder servers rely on `lsof` and process groups: macOS and Linux. When two
  servers run from one folder, the lowest port that answers wins.
