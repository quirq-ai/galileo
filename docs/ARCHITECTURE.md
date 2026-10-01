# How galileo works

galileo is one Node.js process in front of the apps on this machine. It gives
each app, and each version of an app, its own address on one port, routes
every request by its hostname to the app's port or URL, and carries
telescope, XO's in-page bar, into every HTML page it serves. It starts
nothing: apps run however you run them.

This page follows a request through galileo, then telescope through a page,
then each part in turn. Why each part works the way it does is in
[DECISIONS.md](DECISIONS.md), exact routes, headers and files are in
[REFERENCE.md](REFERENCE.md), and what is planned is in
[ROADMAP.md](ROADMAP.md).

- [The picture](#the-picture)
- [A page, from request to telescope](#a-page-from-request-to-telescope)
- [What changes on the way through](#what-changes-on-the-way-through)
- [WebSockets](#websockets)
- [telescope in the page](#telescope-in-the-page)
- [What telescope makes](#what-telescope-makes)
- [Designs](#designs)
- [Where apps come from](#where-apps-come-from)
- [Trust boundaries](#trust-boundaries)
- [What galileo keeps](#what-galileo-keeps)
- [Mounted in another server](#mounted-in-another-server)

## The picture

```mermaid
flowchart LR
  browser["Browser tab<br/>dev.acme.localhost:4100"]
  subgraph gw["galileo, one process on 127.0.0.1:4100"]
    route["routeForHost<br/>which app, which version"]
    proxy["proxy and tunnel<br/>one tag appended to pages"]
    tele["telescope's routes<br/>bundles, threads, captures,<br/>designs, agent requests"]
    own["the bare host<br/>home, launcher, admin API"]
  end
  dev["acme's dev server<br/>127.0.0.1:5173"]
  live["acme's deployment<br/>acme.vercel.app"]
  made[("data/<br/>what telescope makes")]
  apps[("data/targets.json<br/>the registry")]
  browser --> route
  route -->|"a page or an asset"| proxy
  route -->|"/__xo/* on an app's host"| tele
  route -->|"localhost:4100"| own
  proxy --> dev
  proxy --> live
  tele --> made
  own --> apps
```

| Part | File | Job |
| --- | --- | --- |
| Routing and registry | `src/targets.mjs` | turns a `Host` header into an app and a version; keeps the apps and saves them to `data/targets.json` |
| Proxy, tunnel and admin API | `src/server.mjs` | forwards requests and WebSocket upgrades to the version's upstream; the waiting and 404 pages; the bare host's pages; galileo's own `/__xo/*` (health, the list of apps, the admin API), handing the rest of `/__xo/*` to telescope; the CLI |
| Page rules | `telescope/server/inject.mjs` | which responses are pages, how their headers change, and the tag |
| telescope's routes | `telescope/server/api.mjs` | `createTelescope`: its bundles, captures, threads, designs and agent requests under `/__xo/`, on app hosts and the bare host |
| telescope's store | `telescope/server/store.mjs`, `uploads.mjs` | threads, designs, agent requests and captures on disk |
| telescope in the page | `telescope/src/`, `layout.mjs`, `index.mjs` | the bar's scripts, the design schema, and the bundles made from them |
| Pages of its own | `home/`, `launcher/` | the home page and the launcher on the bare host |

## A page, from request to telescope

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  box galileo on 127.0.0.1:4100
    participant G as routing and proxy
    participant T as telescope's routes
  end
  participant A as acme dev server
  B->>G: GET /pricing, Host dev.acme.localhost:4100
  G->>G: routeForHost finds acme, version dev
  G->>A: GET /pricing, Host 127.0.0.1:4174, accept-encoding identity
  A-->>G: 200 text/html, with a CSP and X-Frame-Options
  G->>G: shouldInject says it is a page, so rewrite headers and make a nonce
  G-->>B: the rewritten headers, then the body as it streams
  G-->>B: after the last byte, the loader tag
  B->>G: GET /__xo/toolbar/loader.js, same origin
  G->>T: handleApp
  T-->>B: the loader, which builds the bar and loads app.js in a hidden frame
  B->>G: GET /__xo/api/toolbar and /__xo/api/threads?page=/pricing
  G->>T: handleApp, as acme, version dev
  T-->>B: acme's design, and this page's threads
```

1. **Route.** `routeForHost` reads the `Host` header. `localhost` is galileo's
   own; `acme.localhost` is acme's default version; `dev.acme.localhost` is its
   dev version. A name nobody registered gets a 404 page listing the real ones,
   and never falls through to another app.
2. **Proxy.** The request goes to the version's upstream with the upstream's
   own `Host`, no hop-by-hop headers, and `accept-encoding: identity`, so the
   HTML comes back uncompressed.
3. **Decide.** `shouldInject` says whether the response is a page: a `GET` for
   a document, answered with uncompressed `text/html`, not opted out.
   Anything else (scripts, images, JSON, streams) is piped through untouched.
4. **Rewrite.** A page's headers are adjusted just enough for the tag to run
   and for XO to frame the page: `X-Frame-Options` and `frame-ancestors` go, a
   nonce or `'self'` is added where the policy needs it. Redirects and cookies
   are rewritten to stay on galileo's host.
5. **Append.** The body streams through a transform that adds one
   `<script src="/__xo/toolbar/loader.js">` after the last byte, so the page
   renders as fast as it would without galileo.
6. **Load telescope.** The loader comes from the page's own origin, so the
   page's CSP admits it with `'self'` or the nonce. It builds the bar and runs
   the rest of telescope in a hidden frame (see
   [telescope in the page](#telescope-in-the-page)), which loads the app's
   design and this page's threads. The navbar loads the list of apps when one
   of its menus opens. All of it goes to `/__xo/` on the same origin, which
   galileo scopes to that app.

If the upstream doesn't answer, a "Waiting for acme" page retries every 2
seconds, and still carries telescope. WebSocket upgrades (hot reload) are
tunnelled raw to the same version; any other upgrade is closed.

### How a request is sorted

```mermaid
flowchart TD
  req["a request"] --> host{"its Host"}
  host -->|"localhost or 127.0.0.1"| bare["galileo's own<br/>home, launcher, admin API"]
  host -->|"name.localhost or version.name.localhost"| known{"a registered app and version?"}
  known -->|no| missing["404 page listing the real apps or versions"]
  known -->|yes| where{"its path"}
  where -->|"/__xo/*"| xo["health and the app list,<br/>else telescope's routes"]
  where -->|"/version/... on the app's own host, a page load"| pick["302 to that version's host"]
  where -->|"anything else"| proxy["proxy to the version's upstream,<br/>carrying telescope into pages"]
  proxy --> down{"the upstream answers?"}
  down -->|yes| page["the app's response"]
  down -->|no| wait["Waiting page, retries every 2 s"]
```

## What changes on the way through

galileo changes as little as it can. Everything here is a pure function in
`telescope/server/inject.mjs`, tested without a server.

**To the upstream:**

- `Host` becomes the upstream's own. `x-forwarded-host` keeps the address the
  browser used, and `x-forwarded-proto` says `http`.
- `accept-encoding: identity`, so a page comes back uncompressed and the tag
  can be appended without decompressing it.
- Hop-by-hop headers and `x-xo-skip-toolbar` are dropped.
- A `*.vercel.app` upstream also gets `x-vercel-skip-toolbar: 1`, so telescope
  stands in for Vercel's toolbar.

**Back to the browser:**

- Hop-by-hop headers are dropped.
- A `Location` that points at the upstream's origin is rewritten to the app's
  host on galileo, and `Set-Cookie` loses its `Domain=`, so redirects and
  cookies stay on galileo's host.
- Only on a page: `X-Frame-Options` goes, each Content Security Policy is
  rewritten (below), `Content-Length`, `ETag` and `Last-Modified` go because
  the body grows by one tag, and `x-xo-toolbar: injected` says telescope was
  added.

**A page's Content Security Policy**, enforced or report-only:

```mermaid
flowchart TD
  policy["a page's CSP header"] --> fa["frame-ancestors is dropped"]
  fa --> copy["where only default-src covers script-src,<br/>connect-src, img-src or media-src,<br/>default-src is copied into that directive"]
  copy --> script{"script-src trusts a nonce, a hash<br/>or 'strict-dynamic', or is 'none'?"}
  script -->|yes| nonce["galileo's nonce is added,<br/>and the tag carries it"]
  script -->|no| hasSelf{"it lists 'self' or *?"}
  hasSelf -->|yes| keep["left as it is"]
  hasSelf -->|no| addSelf["'self' is added:<br/>the loader is same-origin"]
  copy --> others["connect-src, img-src, media-src:<br/>'self' added unless 'self' or * is there"]
```

A policy that relies on `'unsafe-inline'` takes the "no" branch and never
gets a nonce: browsers ignore `'unsafe-inline'` once a nonce is present, which
would switch the page's own inline scripts off. `default-src` itself is never
widened, since it also governs styles, fonts and frames.

## WebSockets

```mermaid
sequenceDiagram
  participant B as Browser
  participant G as galileo
  participant A as acme dev server
  B->>G: GET /hmr, Upgrade websocket, Host dev.acme.localhost:4100
  G->>G: routeForHost finds acme, version dev, and the path isn't under /__xo/
  G->>A: opens a socket (TLS for an https upstream), then sends the same request line and headers with A's Host
  A-->>B: 101 Switching Protocols, through galileo
  B->>A: frames, piped through galileo untouched
  A->>B: frames, piped through galileo untouched
  Note over B,A: an upgrade on galileo's own host, under /__xo/, or for an unknown name is closed
```

Hot reload keeps working because the socket reaches the same version the page
came from, on that version's own host.

## telescope in the page

telescope has two halves, both in `telescope/`. Its server side
(`telescope/server/`) is made once by galileo with
`createTelescope({ dataDir })`, which then gets every `/__xo/` request that
isn't galileo's own. Its page side is plain scripts in `telescope/src/`,
joined into three bundles (`loader.js`, `app.js`, `designer.js`) by
`telescope/index.mjs` on each request, with no build step. telescope was
called xo-toolbar, and its wire names still are (`/__xo/toolbar/*`,
`data-xo-toolbar`, `window.__xo_toolbar`, `data/toolbars/`), so pages, hosts
and saved designs keep working.

In the page, telescope keeps to itself. Its UI sits in a closed shadow root,
and its code runs in a hidden iframe that shares the page's origin but not its
globals, so the page's styles and scripts don't break it and its own don't
leak out.

```mermaid
flowchart LR
  subgraph pg["acme's page, on acme.localhost:4100"]
    direction LR
    tag["the tag galileo appended"]
    log["the page's log:<br/>console errors and warnings,<br/>errors, failed requests,<br/>CSP blocks"]
    subgraph el["the xo-toolbar element, on html"]
      subgraph sr["closed shadow root"]
        frame["hidden iframe, same origin:<br/>app.js, its own globals"]
        bar["the bar, menus, panels,<br/>pins, the capture review"]
      end
    end
    dom["the page's own DOM,<br/>styles and scripts"]
  end
  api["telescope's routes,<br/>/__xo/api/* on this origin"]
  tag -->|"loader.js builds it"| el
  log --> frame
  frame -->|"draws into"| bar
  frame -->|"reads and measures"| dom
  frame -->|"fetch, same origin"| api
```

```mermaid
sequenceDiagram
  participant P as the page
  participant L as loader.js
  participant F as app.js, in the hidden frame
  participant G as galileo
  P->>L: runs the appended tag, async
  L->>L: reads its tag: the app, its version and versions, the nonce
  L->>L: shows only on explicit opt-in or a localhost host, and never with a __xo_toolbar=0 cookie
  L->>L: starts the page's log
  L->>P: on DOMContentLoaded, appends xo-toolbar with a closed shadow root
  L->>F: a srcdoc frame whose one script is /__xo/toolbar/app.js, with the same nonce
  F->>G: GET /__xo/toolbar/app.js
  L->>F: initXoToolbar, with the shadow root, the page and the log
  F->>G: GET /__xo/api/toolbar and /__xo/api/threads?page=/pricing
  F->>P: draws the bar and the pins, then fires xo-toolbar:ready
  Note over F,P: every 500 ms it keeps the bar attached, follows route changes, and loads a new page's threads
```

- The log starts when the loader runs, at the end of the page. Failed
  requests come from the page's resource timings, including those made before
  the loader ran, so `fetch` is never wrapped.
- The navbar (`● dev ▾ · acme ▾ · /pricing`) reads the list of apps from
  `/__xo/api/targets` each time one of its menus opens. Every switch of app or
  version is a page load on another origin, since each app and version is
  one.
- A page can add its own tools with `window.__xo_toolbar.addTool`, before or
  after telescope boots; they are never saved into the design.
- [telescope/README.md](../telescope/README.md) has the tools, keys, navbar
  and page API.

## What telescope makes

Everything telescope makes belongs to the app, and is kept by its server side
in `data/`. Each route answers only the app's own origin, and only about that
app.

### Comments

```mermaid
sequenceDiagram
  participant U as Person
  participant T as telescope
  participant G as telescope's routes
  participant D as data/threads.json
  U->>T: Comment, then a click on an element
  T->>T: XoNodeId.build: selectors for the element, plus its tag and opening text
  U->>T: the comment, then Enter
  T->>G: POST /__xo/api/threads with nodeId, anchor, page and text
  G->>D: a thread for acme, with the version it was started on
  Note over T,D: later: a reload, a rebuild, or another version of acme
  T->>G: GET /__xo/api/threads?page=/pricing
  G-->>T: acme's threads for this page
  T->>T: each thread finds its element by its selectors in turn, then by its text, else says "Element not found"
```

A comment with no element is about the whole page. Replies, resolving and
deleting go to `/__xo/api/threads/:id`, and only from the app that owns the
thread.

### Captures

```mermaid
flowchart LR
  shot["Screenshot, Area,<br/>or one element"] --> review["the review:<br/>mark it up, add a note"]
  rec["Record,<br/>up to 5 minutes"] --> saved["POST /__xo/api/uploads<br/>as soon as it stops"] --> review
  review -->|"Ask the agent"| up1["POST /__xo/api/uploads,<br/>if not yet"] --> agent["POST /__xo/api/agent<br/>with the upload's id"]
  review -->|"Comment"| up2["POST /__xo/api/uploads,<br/>if not yet"] --> thread["POST /__xo/api/threads<br/>with the upload's id"]
  review -->|"Copy or Download"| local["stays in the browser"]
  review -->|"Discard"| gone["DELETE /__xo/api/uploads/:id,<br/>if it was uploaded"]
```

Captures use the Screen Capture API, so they show the tab's real rendering.
An upload is kept in `data/uploads/<app>/` and served back on the app's own
host at `/__xo/uploads/<file>`, with byte ranges so recordings can seek. Pages
get an upload's id and address, never where it sits on disk.

### Requests for the agent

```mermaid
flowchart LR
  from["telescope: an element's card,<br/>a capture's review, the logs panel,<br/>a thread, a prompt tool,<br/>or a page's own tool"] --> post["POST /__xo/api/agent<br/>ask, page, element, attachments,<br/>logs, environment"]
  post --> check["telescope's routes:<br/>same origin only, attachments must be<br/>this app's uploads, text cut to size"]
  check --> jsonl[("data/agent-requests.jsonl<br/>one line each,<br/>captures as file paths")]
  check --> printed["a line in galileo's log"]
  jsonl -.->|"not yet"| runtime["the XO runtime:<br/>reads a request, confirms it,<br/>runs a turn"]
```

galileo hands requests off and never runs one. The file is the hand-off
point; nothing reads it yet.

## Designs

A design says which tools the bar shows, in what order, where it docks, its
labels and its accent. Which one an app gets:

```mermaid
flowchart TD
  get["GET /__xo/api/toolbar<br/>on acme's host"] --> own{"data/toolbars/acme.json?"}
  own -->|yes| app["acme's own design<br/>source: app"]
  own -->|no| dflt{"data/toolbars/_default.json?"}
  dflt -->|yes| gw["galileo's default<br/>source: gateway"]
  dflt -->|no| builtin["telescope's built-in design<br/>source: built-in"]
```

Who can change one:

```mermaid
flowchart LR
  bar["Customize, or dragging the bar,<br/>in one of acme's pages"] -->|"PUT /__xo/api/toolbar"| acme[("data/toolbars/acme.json")]
  launcher["the launcher,<br/>on localhost:4100"] -->|"PUT /__xo/api/toolbars/acme"| acme
  launcher -->|"PUT /__xo/api/toolbars/_default"| shared[("data/toolbars/_default.json")]
```

An app's page can change only that app's design; only the launcher can change
another app's, or the default. Every design passes telescope's schema
(`normalizeLayout` in `telescope/layout.mjs`) when it is saved and when it is
read, so a hand-edited file can't break the bar.

## Where apps come from

```mermaid
flowchart LR
  flags["--target flags<br/>at start"] --> reg["the registry"]
  launcher["the launcher<br/>localhost:4100/launcher"] --> api["admin API<br/>POST /__xo/api/targets"]
  host["a host's own UI<br/>xo-client's Settings › Apps"] --> api
  api --> reg
  reg --> file[("data/targets.json")]
  reg --> route["routeForHost"]
```

- An app is a name, versions, and an upstream per version: a port, a
  `host:port`, or an `http(s)` URL.
- `--target` flags add apps at start; the admin API adds, changes and removes
  them while galileo runs. The launcher, and hosts such as xo-client, use that
  API.
- The registry saves every change to `data/targets.json` (a temporary file,
  then a rename) and loads it at start. On a clash the flags win, and a default
  version chosen later is kept.
- galileo only routes: whatever serves the port has to be running already.

## Trust boundaries

```mermaid
flowchart LR
  subgraph bare["localhost:4100, where no app code runs"]
    home["home page"]
    launcher["launcher"]
    admin["admin API<br/>add and remove apps and versions,<br/>any app's design"]
  end
  subgraph appHost["acme.localhost:4100, acme's own origin"]
    page["acme's pages, with telescope"]
    api["acme's API<br/>its threads, captures, design,<br/>agent requests, the list of apps"]
  end
  launcher --> admin
  page --> api
```

- galileo listens on `127.0.0.1` only.
- The bare host is never proxied, so no app code runs there. It is the only
  origin that can change the set of apps or any app's design. Its API takes
  same-origin requests only, and changes must be JSON, so a form on another
  site can't post one.
- Each app's API answers only that app's own origin, and only about that app.
  telescope runs inside the app's page, so whatever telescope may do, the
  app may do too; nothing there reaches another app or the set of apps.
- Uploads come back to pages without their place on disk; only the agent
  request log records file paths.

## What galileo keeps

```
data/targets.json            the apps and their versions
data/threads.json            comment threads, per app and page
data/agent-requests.jsonl    requests for the agent, one per line, with capture paths
data/toolbars/_default.json  the default telescope design
data/toolbars/<app>.json     an app's own design
data/uploads/<app>/          screenshots and recordings
```

Everything belongs to an app, not a version: threads, captures and designs are
shared by all of an app's versions, and each thread records the version it was
started on. Files are rewritten whole through a temporary file and a rename,
and one galileo process owns a data folder.

## Mounted in another server

```mermaid
flowchart LR
  browser["Browser"] --> host["xo-client's server.mjs<br/>127.0.0.1:3000"]
  host --> owns{"gateway.owns(req)"}
  owns -->|"*.localhost, or /__xo/* on localhost"| gw["galileo<br/>handle and upgrade"]
  owns -->|"everything else"| ui["Next.js<br/>the XO UI"]
```

`createGateway()` returns the handlers without listening, so another server can
share its port. xo-client does: `localhost:3000` is XO's UI, which manages apps
in Settings › Apps through the admin API, and every `*.localhost:3000` address
is galileo's. The host keeps the bare host, so galileo's home page and launcher
aren't shown there.
