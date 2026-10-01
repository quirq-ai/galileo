# galileo reference

The exact behavior of galileo v0: commands, settings, addresses, routes,
headers, files and data. [ARCHITECTURE.md](ARCHITECTURE.md) explains how the
parts fit; [DECISIONS.md](DECISIONS.md) explains why.

## Commands and settings

```bash
npm start                   # galileo on http://localhost:4100
npm run demo                # galileo with the sample app, its folder and the README as sources
npm run sample              # the sample app alone (--port, --build live|dev)
npm test                    # every suite, with node --test (Node 21+, for the glob)
```

`npm start` runs `src/server.mjs`, which takes:

| Flag | Does |
| --- | --- |
| `--source <name>=<where>` | adds a source at start; repeatable: `web=5173`, `notes=~/notes`, `site=./dist` (a relative path is relative to the current folder here). On a clash with the saved list, the flag wins. |
| `--port <n>` | where to listen (default `PORT`, else 4100) |

`npm start` reads its settings from the environment, or from `.env.local`
beside the checkout (see `.example.env`); what the shell sets wins.
`npm run demo` reads the environment only.

| Variable | Default | Does |
| --- | --- | --- |
| `PORT` | `4100` | Where galileo listens, on `127.0.0.1` only. `--port` wins. |
| `GALILEO_DATA` | `data/` | Where galileo keeps its list of sources. |
| `SAMPLE_PORT` | `4173` | The demo's sample app. A taken port falls back to a free one. |

A port that is already taken stops galileo with a message naming the next one
to try.

## Sources and addresses

A source has a name and is one of two kinds:

| Kind | Given as | Kept as |
| --- | --- | --- |
| port | `5173`, `localhost:5173`, `127.0.0.1:5173` or `[::1]:5173`, with or without `http://` and a trailing `/` | `{ "name", "type": "port", "port" }` |
| files | a full path (`/Users/me/notes`, `~/notes`, `~`), a file or a folder | `{ "name", "type": "files", "path" }` |

- A number is always a port (1 to 65535): for a folder called `2024`, write
  `./2024` on the command line, or its full path on the Sources page. Any
  other host or scheme is refused: sources are on this machine.
- The sources API refuses a relative path, and a port source on galileo's own
  port.
- Names are DNS labels: lowercase letters, digits and inner dashes, 40
  characters at most. Adding a name that exists points it somewhere else.

```
localhost:4100                  ─▶ /sources
localhost:4100/sources          ─▶ the Sources page
localhost:4100/s/acme/pricing   ─▶ the source acme at /pricing, under telescope's bar
acme.localhost:4100/pricing     ─▶ the source itself, at its own address
<unknown>.localhost:4100        ─▶ a page listing the sources (404)
any other host                  ─▶ 421, and nothing else
```

Any other host is what a page elsewhere sends when it points its own name at
this machine (DNS rebinding), so it learns nothing, not even the sources'
names.

## Routes

**On galileo's own host** (`localhost`, `127.0.0.1` or `[::1]`, on galileo's
port):

| Route | Answers |
| --- | --- |
| `GET /`, `/sources`, `/s/…` | telescope's page (`HEAD` too) |
| `GET /__xo/telescope/telescope.js`, `telescope.css`, `icon.svg` | telescope's files (`HEAD` too) |
| `GET /__xo/health` | `{ ok, sources }`: the names, cheap enough to poll |
| `GET /__xo/api/sources` | `{ sources }`: every source with its address and state |
| `POST /__xo/api/sources` | `{ "name": "notes", "location": "~/notes" }` adds a source (`201`), or points a name somewhere else (`200`): `{ source }` |
| `DELETE /__xo/api/sources/:name` | removes a source: `{ ok }`, or `404` |
| anything else | `404` |

telescope's page is sent with `Content-Security-Policy: default-src 'self';
script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self';
frame-src http://*.localhost:<port>; base-uri 'none'; form-action 'self';
frame-ancestors 'none'`.

The sources API answers galileo's own pages only: a `Sec-Fetch-Site` of
`same-origin`, or none (as from `curl`). Changes must be JSON, 64 KB at most.
Errors are `{ error }` with `400` (a bad name or location), `403` (another
origin), `404`, `413` or `415` (not JSON).

A source in the API:

```json
{ "name": "acme", "type": "port", "port": 5173, "url": "http://acme.localhost:4100/", "up": true }
{ "name": "notes", "type": "files", "path": "/Users/me/notes", "url": "http://notes.localhost:4100/", "kind": "folder", "up": true }
```

For a port, `up` is whether it answered a `HEAD /` within 600 ms just now. For
files, `kind` is `file`, `folder`, or `null` when the path is gone, and `up` is
whether it is there.

**On a source's address** (`<name>.localhost:<port>`):

| Route | Answers |
| --- | --- |
| `GET /__xo/bridge.js` | the bridge |
| anything else under `/__xo/` | `404` |
| a WebSocket upgrade | tunnelled to a port source's port when its `Origin` is the source's own, galileo's, or absent; `403` from any other origin; closed for anything but a port source |
| anything else | the source: proxied to its port, or read from disk |

A name nobody added answers a page load with a `404` page listing the sources
(each a link to telescope), and anything else with `404` `{ error }`. A port
where nothing answers gives a page load a `502` page that refreshes every 2
seconds and carries the bridge, and anything else a plain `502`.

## What changes in a source's responses

| Header | Change | Why |
| --- | --- | --- |
| `X-Frame-Options` | removed | so telescope can frame the source |
| CSP `frame-ancestors` | removed, and galileo's own policy added: `frame-ancestors 'self' http://localhost:<port> http://127.0.0.1:<port>` | only galileo, and the source itself, may frame it |
| CSP `script-src` that trusts a nonce, hash or `'strict-dynamic'`, or is `'none'` | galileo's nonce added, `'none'` dropped (pages with the bridge only) | the bridge's tag carries the nonce |
| CSP `script-src` that lists sources only | `'self'` added if missing (pages with the bridge only) | the bridge comes from the page's own origin |
| CSP with `'unsafe-inline'` and no nonce | never given a nonce | a nonce would switch the page's own inline scripts off |
| CSP with only `default-src` | a `script-src` copied from it (pages with the bridge only) | `default-src` itself is left alone |
| `Content-Length`, `ETag`, `Last-Modified` | removed (pages with the bridge only) | the body grew by one tag |
| `x-galileo-bridge` | `added` (pages with the bridge only) | says the bridge was added |
| `Location` pointing at the port, whole or as `//localhost:<port>/…` | rewritten to the source's address | redirects stay on galileo |
| `Set-Cookie` `Domain=` | removed | a cookie for another domain would be dropped on the source's address |
| hop-by-hop headers | removed | they belong to one connection |

`Content-Security-Policy-Report-Only` headers are rewritten the same way as
enforced ones. A header that holds several policies, comma-separated (as
Node joins a header sent twice), is rewritten policy by policy, and each is
sent as a header of its own. Requests to a port get its own `Host` (`localhost:<port>`),
`accept-encoding: identity`, `x-forwarded-host` and `x-forwarded-proto`, and
no hop-by-hop headers.

A response gets the bridge when the request is a `GET` for a document
(`Sec-Fetch-Dest` `document`, `iframe` or `frame`, else an `Accept` with
`text/html`), the status isn't 1xx, 204 or a redirect (an app's own error
pages get it too), the type is `text/html`, and the body isn't compressed. The
tag is appended after the last byte:

```html
<script async nonce="…" src="/__xo/bridge.js"></script>
```

When framed, the bridge posts `{ galileo: "where", href, title }` to its parent
whenever the page's address or title changes. [telescope/README.md](../telescope/README.md#the-bridge)
has the details.

## Files sources

- Only `GET` and `HEAD`; anything else is `405`.
- A path is decoded first. A part that starts with `.`, or holds `\` or a NUL,
  is `404`. So is anything that, once symlinks are followed, leads outside the
  source or through a hidden name: a link called `env` to `.env` is as hidden
  as `.env`. A source may be any folder, `/` included.
- A folder without its trailing `/` is `301` to it. A folder serves its
  `index.html` (by the same rules), or else a listing: names, sizes and times,
  folders first, with hidden names, `node_modules`, and links that lead
  outside or to a hidden name left out. `node_modules` is still served when
  asked for by path.
- A single file answers at `/` only.
- A path that is gone is `404` saying so.

What a file gets:

| Request | HTML file | Any other file |
| --- | --- | --- |
| a page load, without `?raw` | the file, with the bridge appended | a page that shows it: text (up to 2 MB), an image, video, audio or a PDF, else a download link |
| anything else, or `?raw` | the file as it is | the file as it is, with byte ranges |

A file's type comes from its extension: `.html` `.htm` `.css` `.js` `.mjs`
`.json` `.svg` `.png` `.jpg` `.jpeg` `.gif` `.webp` `.avif` `.ico` `.pdf`
`.mp4` `.webm` `.mov` `.mp3` `.wav` `.ogg` `.woff` `.woff2` `.wasm`. Any other
file is `text/plain` when its first 8 KB hold no NUL byte, else
`application/octet-stream`. Files are sent with `Cache-Control: no-cache`
and `X-Content-Type-Options: nosniff`.

The pages galileo makes on a source's address (listings, file pages, the
waiting and missing pages) are sent with `default-src 'none'`, a nonce for
their one style and the bridge, `img-src`, `media-src` and `frame-src` of
`'self'`, and galileo's `frame-ancestors`.

## Data

```
data/sources.json    { "sources": [{ "name", "type": "port", "port" } or { "name", "type": "files", "path" }] }
```

Saved whole through a temporary file and a rename after every change, and
loaded at start; an entry that no longer makes sense is dropped. `data/` is
runtime state: it is gitignored, and one galileo process owns it.

## As a library

`index.mjs` exports `createGalileo`, `logSource`, `parseLocation`,
`parseSourceSpec` and `sourceUrl`.

```js
import { createGalileo } from "galileo";

const galileo = createGalileo({ sources: [{ name: "web", type: "port", port: 5173 }], dataDir });
galileo.server.listen(4100, "127.0.0.1");
```

| Option | Default | Does |
| --- | --- | --- |
| `sources` | `[]` | sources at start, as `parseSourceSpec` returns them |
| `dataDir` | `data/` | where the list is kept |
| `port` | the listener's | the port addresses name, when something other than `server` listens |
| `log` | `console.log` | where galileo reports |

It returns `{ server, handle, upgrade, sources, close }`: the server, not yet
listening; the handlers it is made of; the list (`get`, `list`, `add`,
`remove`); and `close()`, which stops the server.

## Files

```
index.mjs          the library entry
src/server.mjs     createGalileo: routing, telescope's page and the sources API, the proxy and tunnel, the pages galileo makes; the CLI
src/sources.mjs    names, ports and paths, routeForHost, the list in data/sources.json, a source's state
src/inject.mjs     pure rules: which responses get the bridge, framing, policies, request and response headers
src/files.mjs      a files source, read only: safe paths, files, file pages, listings
telescope/         the page (index.html, telescope.js, telescope.css, icon.svg) and the bridge (bridge.js)
sample-app/        Acme Notes: a three-page site with strict security headers
demo.mjs           Acme Notes, its folder and the README as three sources
test/              node --test suites: sources, inject, files, galileo (end to end)
```

## Limits

- Safari before macOS 26 can't resolve `*.localhost`.
- A CSP set in a `<meta>` tag isn't adjusted, only headers are; it may block
  the bridge, and the bar then doesn't follow that page.
- A port that compresses HTML despite `accept-encoding: identity` is passed
  through without the bridge rather than corrupted.
- The frame shows sources only. A link to another site opens in a tab of its
  own; a page that sends the frame elsewhere by script is blocked.
- A framed source may go fullscreen and write to the clipboard, nothing more:
  a browser keeps a permission given in a frame for galileo's own origin, so
  it would hold for every source. For the camera, the microphone or the
  location, open the source on its own (↗).
- Text over 2 MB isn't shown in a page; Raw opens it. Markdown shows as text.
- Sources are on this machine: a deployment at a URL isn't a source in v0.
- One galileo per data folder.
