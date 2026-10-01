# Why galileo works the way it does

The decisions behind galileo v0, each with what it costs. When a change goes
against one of them, update this file in the same change.

[ARCHITECTURE.md](ARCHITECTURE.md) shows how the parts fit together;
[REFERENCE.md](REFERENCE.md) has the exact routes, headers and files;
[ROADMAP.md](ROADMAP.md) has what v0 leaves out.

## Scope

### 1. galileo inspects sources, and starts nothing

A source is something on this machine to look at. galileo shows it and never
runs a command, starts a process, or writes to a source.

- **Why**: galileo stays small and predictable, and apps run however you
  already run them: a terminal, an editor, a container, an agent's session.
  Nothing galileo does can start code on this machine or change a file.
- **Cost**: a port source has to be running already. Until something answers,
  its pages say so and try again every 2 seconds.

### 2. Two kinds of source: ports and files

A source is an app on a port of this machine, or a file or folder on it.

- **Why**: those are the two things a space produces: the apps an agent runs,
  and the files it writes. Two kinds keep the Sources page and the code small.
- **Cost**: no deployments at a URL, no versions of an app. They may come back
  after v0 ([ROADMAP.md](ROADMAP.md)).

### 3. v0 is small on purpose

v0 is the Sources page, telescope's bar and router, and the bridge. The
in-page tools (inspect, comments, captures, logs, asking the agent), designs,
versions, the launcher, a feed, and mounting inside xo-client are left out.

- **Why**: so people can try galileo and say what it should do next, on code
  small enough to read in an evening.
- **Cost**: what was cut has to come back deliberately. It is in git history
  ([ROADMAP.md](ROADMAP.md) says where), and xo-client, which mounted the old
  galileo, has to be brought up to v0.

## Addresses

### 4. Every source gets a hostname, not a path

`acme.localhost:4100` is the source acme. galileo never serves a source under a
path such as `/acme/`.

- **Why**: apps write absolute URLs everywhere: links, `/_next/static/…`
  assets, API calls, redirects, hot-reload sockets. With a path prefix the
  first absolute URL escapes it. A hostname keeps every request on its source,
  for any app, with nothing to configure.
- **Also**: each source is its own origin, so sources never share cookies,
  storage or service workers, with each other or with telescope.
- **Cost**: one hostname per source, which needs the next decision.
- **Where**: `routeForHost` in `src/sources.mjs`.

### 5. `*.localhost`, with no DNS setup

- **Why**: browsers resolve `localhost` and every name under it to this
  machine (RFC 6761), so there is no `/etc/hosts` entry, no local DNS server
  and no certificate to install.
- **Cost**: Safari before macOS 26 doesn't resolve `*.localhost`. Tools that do
  their own DNS (some CLIs) may not either; they can call the port itself.

### 6. One port, and galileo's own host holds telescope and the sources API

`localhost:4100` serves telescope and the sources API, and never a source.

- **Why**: no source's code ever runs on that origin, which makes it the one
  place allowed to add and remove sources.
- **Cost**: galileo's own host can't also be a source.

## telescope

### 7. telescope is galileo's whole page: a bar and a router, sources in a frame

galileo serves one page. telescope's bar runs along the top; under it is the
Sources page, or one source in a frame. telescope owns the address:
`/s/<name>/<path>`. One frame shows every source, sent from place to place in
place of its page, so Back and Forward never meet a step that does nothing.

- **Why**: one place to look at everything, which sources can't break, since
  their code runs in a frame on their own origin. Apps change nothing to show
  up: no SDK, no build plugin. The old way, a whole bar injected into each
  page, needed far more code and could still be broken by a page's styles or
  scripts.
- **Cost**: telescope can't see inside a frame on another origin; decision 8
  covers that. A link to another site can't open in the frame (decision 9), so
  it opens in a tab of its own. A framed source gets fullscreen and clipboard
  writes only: a browser keeps a permission given in a frame for galileo's own
  origin, so the camera for one source would be the camera for all. A source
  that needs more opens on its own.
- **Where**: `telescope/telescope.js`.

### 8. A small bridge tells telescope where the framed page is

galileo appends `<script async src="/__xo/bridge.js">` to each HTML page a
source serves. When framed, it posts the page's address and title to telescope
whenever they change.

- **Why**: the bar, Back and Forward, and the address have to follow clicks
  inside a source, and only the page itself knows where it is. Watching the
  proxy's requests instead would miss single-page apps and every files source.
- **How**: it looks at the address a few times a second rather than wrapping
  the page's `history` functions, so it never changes how a page behaves. A
  click on a link to something that isn't a page (an image, a file) is posted
  before the page leaves, since that has no bridge of its own.
- **Cost**: one script in every page, and a policy loosened for it (decision
  10). A page whose policy sits in a `<meta>` tag may block it.
- **Where**: `telescope/bridge.js`; `shouldInject` and `bridgeTag` in
  `src/inject.mjs`.

## Carrying sources into the frame

### 9. Only galileo may frame a source

`X-Frame-Options` is removed from every response of a source, and so is each
policy's `frame-ancestors`; galileo then adds `frame-ancestors 'self'` and its
own origins.

- **Why**: apps that refuse frames (most production ones send `X-Frame-Options:
  DENY`) still show under the bar, yet no other site can frame a source, and
  what the bridge posts reaches telescope only.
- **Cost**: an app that relies on its own `frame-ancestors` for anything else
  loses it behind galileo.
- **Where**: `rewriteSecurityHeaders` and `framePolicy` in `src/inject.mjs`.

### 10. A page's policy is loosened only for the bridge

| Change | Reason |
| --- | --- |
| a nonce added to `script-src`, only if it trusts nonces, hashes or `'strict-dynamic'`, or allows nothing (`'none'` is dropped) | the tag carries the nonce |
| `'self'` added to a `script-src` that only lists sources | the bridge comes from the page's own origin |
| never a nonce on a policy that relies on `'unsafe-inline'` | browsers ignore `'unsafe-inline'` once a nonce is present, which would switch off the page's own inline scripts |
| `default-src` copied into a new `script-src`, never widened | `default-src` also governs styles, fonts, frames and requests |

- **Why**: a page's policy is the app's decision. galileo loosens exactly what
  one same-origin script needs, nothing else.
- **Streaming**: the tag is appended as the body streams through, so a page is
  never held back, and galileo asks ports for `accept-encoding: identity`, which
  costs nothing on a loopback hop. A port that compresses anyway is passed
  through without the bridge rather than corrupted.
- **Where**: `rewritePolicy` in `src/inject.mjs`.

### 11. Files are read only, and only what the source holds

Only `GET` and `HEAD` are answered, and nothing outside the source is served,
once symlinks are followed. Hidden names (`.env`, `.git`) are never listed or
served, nor is anything a link reaches through one, so a link called `env` to
`.env` is refused like `.env`; `node_modules` is not listed. A single file is a source of its
own, answering at `/`, and nothing beside it is served. A page load of a file
that isn't HTML gets a page around it that shows it; everything else, and
`?raw`, gets the file itself.

- **Why**: anyone can add a folder, and galileo must never become a way to read
  more of the disk than was added, or to change it. The page around a file
  carries the bridge, so the bar follows every step through a folder.
- **Cost**: an HTML file that loads assets from beside it needs its folder
  added, not the file alone.
- **Where**: `src/files.mjs`.

## Trust

### 12. Listen on 127.0.0.1, and answer only the hosts galileo owns

- **Why**: galileo can reach every port and readable file on this machine, so
  it must not be on the network, and only telescope, on galileo's own host,
  may change what it serves. The API takes `same-origin` requests only (or
  none, as from `curl`), and changes must be JSON, so a form on another site
  can't post one.
- **Also**: a host that is neither galileo's nor under `.localhost` gets `421`
  and nothing else, since that is what a page elsewhere sends when it points
  its own name at this machine (DNS rebinding). A port's WebSockets open only
  for the source's own pages, galileo's, or no page.
- **Cost**: other devices can't open sources through galileo.
- **Where**: `routeForHost` in `src/sources.mjs`; `guardSameOrigin`,
  `requireJson` and `upgrade` in `src/server.mjs`.

## Building galileo

### 13. No dependencies, no build step

Plain ESM JavaScript on Node 20+ with only Node's own modules, and plain
scripts for telescope.

- **Why**: something that can read a machine's files and reach its ports should
  be small enough to read, and start from a fresh clone with nothing to
  install.
- **Cost**: proxying and streaming are written by hand, and covered by tests
  instead of a framework.

### 14. Pure rules, tested without a server

Names, where a source is, routing by host, and every header rewrite are pure
functions (`src/sources.mjs`, `src/inject.mjs`). The end-to-end tests run a
real galileo in front of the sample app and a scratch folder.

### 15. State is one file

The list of sources is `data/sources.json`, rewritten whole through a
temporary file and a rename.

- **Why**: easy to read, to back up, and for an agent to open. No database to
  run.
- **Cost**: one galileo per data folder; give a second one its own
  `GALILEO_DATA`.
