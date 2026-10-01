# galileo reference

The exact behavior: commands, settings, addresses, routes, headers and files,
as they work today. [ARCHITECTURE.md](ARCHITECTURE.md) explains how the parts
fit; [DECISIONS.md](DECISIONS.md) explains why; what is planned is in
[ROADMAP.md](ROADMAP.md).

## Commands and settings

```bash
npm start                   # galileo on http://localhost:4100
npm run demo                # the sample app's live and dev builds as acme's versions, plus xo for :3000
npm run sample              # the sample app alone
npm test                    # every suite, galileo's and telescope's, with node --test (Node 21+)
```

`npm start` runs `src/server.mjs`, which takes:

| Flag | Does |
| --- | --- |
| `--target <spec>` | adds an app or a version at start; repeatable. The left side reads like the address it creates: `web=5173`, `dev.web=5173`, `live.web=https://web.vercel.app`, `docs=localhost:3001`. The first version given is the default. |
| `--upstream <url>`, `--name <name>` | one app in front of one upstream, as `--target name=url` (named `app` without `--name`) |
| `--port <n>` | where to listen (default `PORT`, else 4100) |

Settings come from the environment, or from `.env.local` beside the checkout
(see `.example.env`); what the shell sets wins.

| Variable | Default | Does |
| --- | --- | --- |
| `PORT` | `4100` | Where galileo listens, on `127.0.0.1` only. `--port` wins. |
| `XO_GATEWAY_DATA` | `data/` | Where apps, threads, captures, designs and agent requests are kept. |
| `SAMPLE_PORT`, `SAMPLE_DEV_PORT` | `4173`, `4174` | The demo's sample builds. A taken port falls back to a free one. |

A port that is already taken stops galileo with a message naming the next one
to try.

## Apps and addresses

An app is a name, one or more versions, and an upstream for each version: a
port (`5173`, meaning `http://localhost:5173`), a `host:port`, or an `http(s)`
URL. Apps come from `--target` flags and the admin API (the launcher uses it),
and are kept in `data/targets.json`. On a clash the flags win; a default
version chosen in the launcher is kept.

```
localhost:4100                ─▶ the home page (galileo's own, never proxied)
localhost:4100/launcher       ─▶ the launcher (galileo's own, never proxied)
acme.localhost:4100           ─▶ acme's default version
dev.acme.localhost:4100       ─▶ acme's dev version, e.g. http://127.0.0.1:4174
live.acme.localhost:4100      ─▶ acme's live version, e.g. https://acme.vercel.app
acme.localhost:4100/live/…    ─▶ 302 to live.acme.localhost:4100/…
<unknown>.localhost:4100      ─▶ 404 page listing the apps that exist
beta.acme.localhost:4100      ─▶ 404 page listing acme's versions
```

- Names are DNS labels: lowercase letters, digits and inner dashes, 40
  characters at most. An app added without a version gets one called `main`.
- A name that isn't registered never falls through to another app or version.
- On an app's own host, a page load (never a fetch) of `/<version>/…`
  redirects to that version's host. Version hosts pass every path to the app,
  so an app's own `/live` page stays reachable there.
- galileo starts nothing. If a version's upstream doesn't answer, pages get a
  "Waiting for acme" page (`502`) that retries every 2 seconds and still
  carries telescope; anything else gets a plain `502`.

## What changes in a page

galileo appends one tag after the last byte of each HTML document. It loads
telescope; its names still say toolbar, telescope's old name:

```html
<script async data-xo-toolbar data-explicit-opt-in="true" data-preview-id="acme-dev-3f9a1c"
        data-project="acme" data-app-version="dev" data-app-versions="dev,live"
        nonce="…" src="/__xo/toolbar/loader.js"></script>
```

`data-explicit-opt-in` tells the loader to show the bar (it also shows on any
`localhost` host; a `__xo_toolbar=0` cookie hides it). `data-project`,
`data-app-version` and `data-app-versions` feed the navbar, and
`data-preview-id` names this app, version and galileo run.

A response gets the tag when the request is a `GET` for a document
(`Sec-Fetch-Dest` `document`, `iframe` or `frame`, else an `Accept` with
`text/html`), the status isn't 1xx, 204 or a redirect (an app's own error
pages get it too), the type is `text/html`, the body isn't compressed, and
neither the `x-xo-skip-toolbar` header nor `?xo_toolbar=off` opts out.

| Header | Change | Why |
| --- | --- | --- |
| `X-Frame-Options` | removed | so XO can frame the page |
| CSP `frame-ancestors` | removed | same reason; it overrides `X-Frame-Options` |
| CSP `script-src` with a nonce, hash or `'strict-dynamic'` | galileo's nonce added | the tag carries that nonce |
| CSP `script-src` that lists sources only | `'self'` added if missing | the loader comes from the page's own origin |
| CSP with `'unsafe-inline'` and no nonce | never given a nonce | a nonce would switch the page's own inline scripts off |
| CSP `connect-src`, `img-src`, `media-src` | `'self'` added if missing | telescope's API, and captures shown from `/__xo/uploads/` |
| CSP with only `default-src` | explicit copies of it with the above | `default-src` itself is left alone |
| `Content-Length`, `ETag`, `Last-Modified` | removed | the body grew by one tag |
| `Location` pointing at the upstream | rewritten to the app's host on galileo | redirects stay on galileo |
| `Set-Cookie` `Domain=` | removed | a cookie for the upstream's domain would be dropped on galileo's host |
| `x-xo-toolbar` | `injected` added | says telescope was added to this response |

`Content-Security-Policy-Report-Only` headers are rewritten the same way as
enforced ones. The `Location` and `Set-Cookie` rewrites apply to every
response; the rest only to pages that get the tag.

Requests to the upstream get its own `Host`, `accept-encoding: identity`,
`x-forwarded-host` and `x-forwarded-proto`, and no hop-by-hop headers. A Vercel
upstream (`*.vercel.app`) also gets `x-vercel-skip-toolbar: 1`, so telescope
replaces Vercel's toolbar.

## The APIs

**Health**, cheap enough to poll:

| Route | Answers |
| --- | --- |
| `GET localhost:4100/__xo/health` | `{ ok, apps }` |
| `GET <app>.localhost:4100/__xo/health` | `{ ok, app, version, upstream }` |

**An app's API**, under `<app>.localhost:4100/__xo/api/`, accepts requests
only from that app's own origin (`Sec-Fetch-Site` of `same-origin`, or none,
as from `curl`). JSON bodies are 256 KB at most, and text is trimmed and cut
to size: a comment to 5,000 characters, a request for the agent to 4,000, a
page path to 2,000. A thread or a request carries up to 10 attachments, and a
request for the agent keeps the last 200 log entries it is sent.

| Route | Does |
| --- | --- |
| `GET /threads?page=/pricing` | this app's threads for one page |
| `POST /threads` | a new thread; an empty `nodeId` makes it about the whole page; `attachments` are upload ids |
| `POST /threads/:id/comments` | a reply (404 from any other app) |
| `PATCH /threads/:id`, `DELETE /threads/:id` | resolve, reopen, delete |
| `POST /uploads` | a PNG, JPEG, WebP, WebM or MP4 as the raw body (150 MB at most) |
| `DELETE /uploads/:id` | discard a capture |
| `POST /agent` | `{ ask, page, element?, attachments?, logs?, environment }`, recorded with the version it came from |
| `GET /toolbar`, `PUT /toolbar`, `DELETE /toolbar` | this app's design: `{ layout, source, isDefault, options }` |
| `GET /targets` | `{ current, currentVersion, manageIn, manageAt, targets }`: every app for the navbar, which one this page is, and where apps are managed (`manageAt` is that page's path on the bare host). Read-only. |

Captures are served back at `<app>.localhost:4100/__xo/uploads/<file>`, with
byte ranges so recordings can be seeked. Threads, captures and designs belong
to the app and are shared by all its versions; each thread records the version
it was started on.

**The admin API**, under `localhost:4100/__xo/api/`, is the only place apps can
be added or removed, and the only place one app's design can be changed from
outside it. Requests must come from that origin, and changes must be JSON.

| Route | Does |
| --- | --- |
| `GET /targets` | `{ targets }`: every app with its versions, their addresses and whether they answer right now |
| `POST /targets` | `{ "name": "acme", "version": "live", "upstream": "https://acme.vercel.app", "makeDefault": false }` adds an app or a version (no version: `main` for a new app, the default version for an existing one) |
| `PATCH /targets/:name` | `{ "defaultVersion": "live" }`: what the app's own host serves |
| `DELETE /targets/:name`, `DELETE /targets/:name/versions/:version` | remove an app, or one of its versions (an app keeps at least one) |
| `GET /toolbars` | the default design and every app's design, with their sources |
| `PUT /toolbars/_default`, `DELETE /toolbars/_default` | set galileo's default design, or go back to the built-in one |
| `PUT /toolbars/:name`, `DELETE /toolbars/:name` | set an app's own design, or hand it back the default |

An app in `/targets` looks like this on both APIs:

```json
{
  "name": "acme", "url": "http://acme.localhost:4100/", "defaultVersion": "dev",
  "upstream": "http://127.0.0.1:4174", "up": true,
  "versions": [
    { "name": "dev", "url": "http://dev.acme.localhost:4100/", "default": true, "upstream": "http://127.0.0.1:4174", "up": true },
    { "name": "live", "url": "http://live.acme.localhost:4100/", "default": false, "upstream": "http://127.0.0.1:4173", "up": true }
  ]
}
```

`up` is whether the upstream answered a `HEAD /` within 600 ms just now.

**Ask the agent** appends the request to `data/agent-requests.jsonl`, with each
capture's file path so an agent can open it, and prints it:

```
[gateway] acme (dev): ask the agent on /pricing: "The plan cards need more room" (+ image …/data/uploads/acme/u_….png; 3 log entries)
```

Nothing reads that file yet.

## telescope designs

A design says which tools the bar shows, in what order, where it docks, its
labels and accent color (the schema is `telescope/layout.mjs`). Every app
gets:

1. its own design, if it has one (`data/toolbars/<app>.json`), else
2. galileo's default design (`data/toolbars/_default.json`), else
3. telescope's built-in design.

Designs are edited with telescope's own editor, in the launcher (the default,
and each app's *Telescope* button) or in the app itself (*Customize*, or dragging
the bar to another dock). A change inside an app gives that app its own design.
Every design is checked with the schema when it is saved and when it is read.

## Data

```
data/targets.json            apps: { name, defaultVersion, versions: [{ name, upstream }] }
data/threads.json            every app's comment threads
data/agent-requests.jsonl    requests for the agent, one per line
data/toolbars/_default.json  galileo's default design
data/toolbars/<app>.json     an app's own design
data/uploads/<app>/u_….png   screenshots and recordings, per app
```

A thread keeps the fields Vercel's toolbar uses, plus the app, the version and
an `anchor` for re-finding its element:

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

`data/` is runtime state: it is gitignored, and one galileo process owns it.

## As a library

`index.mjs` exports `createGateway`, `logApp`, `appUrl`, `ownsRequest` and
`parseTargetSpec`.

```js
import { createGateway } from "galileo";

const gateway = createGateway({ port, dataDir, targets, addAppsIn: "Settings › Apps" });
server.on("request", (req, res) => (gateway.owns(req) ? gateway.handle(req, res) : app(req, res)));
server.on("upgrade", (req, socket, head) => (gateway.owns(req) ? gateway.upgrade(req, socket, head) : appUpgrade(req, socket, head)));
```

| Option | Default | Does |
| --- | --- | --- |
| `targets` | `[]` | apps at start, as `parseTargetSpec` returns them |
| `dataDir` | `data/` | where state is kept |
| `port` | the listener's | the port addresses name, when a host mounts galileo |
| `addAppsIn`, `addAppsAt` | `"the launcher"`, `/launcher` | where the 404 pages send people to add an app (`/` when `addAppsIn` is a host's own) |
| `log` | `console.log` | where galileo reports |

Older options (`roots`, `exclude`, `idleMinutes`, `env`) are ignored, so hosts
written for them still start.

It returns `{ server, handle, upgrade, owns, store, registry, close }`.
`owns(req)` claims every `*.localhost` host, registered or not, and `/__xo/*` on
the bare host; the host keeps everything else, so galileo's home page and
launcher aren't shown when mounted. `close()` has nothing to stop today and
resolves at once; hosts may still await it. `test/mounted.test.mjs` runs
galileo this way.

## Files

```
index.mjs          the library entry
src/server.mjs     createGateway: host routing, proxy, tunnel, the admin API, the waiting and 404 pages; the CLI
src/targets.mjs    names, the registry, routeForHost, versionPick, ownsRequest
home/              the home page: every route, live, and how galileo works
launcher/          the launcher, with telescope's design editor
telescope/         telescope: its browser scripts (src/), design schema (layout.mjs), bundles (index.mjs), server side and tests
telescope/server/  index.mjs (what galileo imports); api.mjs (createTelescope: its /__xo/ routes); inject.mjs (pure rules: which
                   responses get the tag, header rewrites, the tag); store.mjs (threads, agent requests, designs on disk);
                   uploads.mjs (captures on disk, served with byte ranges); http.mjs (JSON and the same-origin rules)
sample-app/        Acme Notes: a three-page site with strict security headers, in a live and a dev build
demo.mjs           both builds as acme's versions, plus xo for whatever runs on :3000
test/              node --test suites: targets, gateway (end to end), mounted; telescope's are in telescope/test/
```

## Limits

- A CSP delivered in a `<meta>` tag isn't rewritten; only headers are.
- An upstream that compresses HTML despite `accept-encoding: identity` is
  passed through without telescope rather than corrupted.
- telescope runs in the app's own page, so the app could call its own API.
  Nothing there is privileged; an agent request should still be confirmed on
  XO's side before it runs.
- Safari before macOS 26 can't resolve `*.localhost`.
- One galileo per data folder: two sharing one overwrite each other's threads
  and apps.
