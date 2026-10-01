# What's next for galileo

galileo v0 is small on purpose: sources (ports and files), telescope's bar and
router, and the bridge. It is out so people can try it and say what should
come next. Nothing on this page works yet; as a part ships, it moves into the
other docs.

## What v0 leaves out, and where it is

Everything below worked before v0, and is in git history at `92145c1`, the
last commit before v0 (`git show 92145c1:<path>`):

| Part | Where it is |
| --- | --- |
| telescope's in-page tools: inspect, comments and threads, screenshots, recording, markup, the page's logs, asking the agent | `telescope/src/`, `telescope/server/` |
| designs of the bar per app, and their editor | `telescope/layout.mjs`, `telescope/src/designer.js` |
| versions of an app (`dev.acme`, `live.acme`), and deployments at a URL | `src/targets.mjs` |
| the launcher and the old home page | `launcher/`, `home/` |
| mounting inside another server, as xo-client's Settings › Apps did | `createGateway` and `ownsRequest` in `src/server.mjs` and `src/targets.mjs` |

## What may come next

Feedback on v0 decides the order. The candidates:

1. **xo-client on v0.** xo-client mounted the old galileo inside
   `localhost:3000`. It needs a way to mount v0, and its Settings › Apps
   becomes the Sources page.
2. **A feed.** What changed across the sources: a file written, a port that
   started or stopped answering.
3. **Traffic.** Each request galileo carries to a port, with its status and
   timing, in a panel of telescope's: kept in memory, secrets masked.
4. **The coworking loop.** Comments on what you see, and handing a page, an
   element or a file to an agent, from telescope's bar.
5. **Better file views.** Markdown rendered, and code with line numbers to
   point at.
6. **URLs as sources.** A deployment beside the port it came from.

## Rules any of it keeps

- galileo starts nothing, and never writes to a source.
- No source runs on galileo's own host, and only telescope changes the list.
- Only galileo frames a source, and a page's policy is loosened only for what
  galileo adds to it.
- Pages stream: nothing is held back to look at it.
- Nothing galileo keeps holds a secret from a request.
- No dependencies, and no build step.

## Open questions

1. Should a space's root folder add each of its folders as a source by itself?
2. Should telescope keep a frame open per source, like tabs, rather than one at
   a time?
3. When in-page tools come back, do they live in the bridge, inside the page,
   or in telescope, outside it with the bridge's help?
