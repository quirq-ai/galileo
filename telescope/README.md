# telescope

telescope is galileo's whole page: the bar along the top, and the router for
the view under it. galileo serves it on its own host, `localhost:4100`; the
view is either the Sources page or one source, framed at its own address.

```
┌──────────────────────────────────────────────────────────┐
│ XO galileo  ● acme ▾  /pricing                 ⟳  ↗  Sources │  the bar
├──────────────────────────────────────────────────────────┤
│                                                          │
│   the view: the Sources page, or a frame showing          │
│   acme.localhost:4100/pricing                             │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## The bar

| Part | Does |
| --- | --- |
| galileo's mark | goes to the Sources page |
| the source menu (`● acme ▾`) | lists the sources by kind, ports then files, each with a dot: green when it's there, red when it isn't; picking one shows it at `/` |
| the path | where the source is; type a path (or a whole address of another source) and press Enter to go there |
| ⟳ | loads the source's page again |
| ↗ | opens the source at its own address, in a tab of its own |
| Sources | the Sources page: add a source by name and port or path, open or remove one |

## The router

telescope owns the address of galileo's page:

| Address | View |
| --- | --- |
| `/` | goes to `/sources` |
| `/sources` | the Sources page |
| `/s/<name>/<path>` | the source `<name>` at `<path>`, in a frame of `http://<name>.localhost:4100/<path>` |

- Every source is shown in one frame. Going to another source or another path,
  from the bar or with Back, sends that frame there in place of the page it
  shows (`location.replace`), so telescope's own history entry is the step.
  A frame that was thrown away instead would leave its steps behind, each a
  Back press that does nothing.
- Clicks inside the frame add their own entries to the tab's history, as any
  frame's do, so Back and Forward step through a source's pages. telescope
  follows them through the bridge and replaces its own entry, never adding
  one.
- Just after it sends the frame to another source, telescope listens only to
  that source (for up to 10 seconds), since the page being left may still post.
- The Sources page hides the frame rather than closing it, so Back from it finds
  the source where it was. The source menu and Open show a source at `/`.
- The frame may go fullscreen and write to the clipboard, nothing more. A
  browser keeps a permission given in a frame for galileo's own origin, so
  the camera granted to one source would be granted to every source; a source
  that needs it opens on its own (↗).

## The bridge

A source runs on its own origin, so telescope can't look inside the frame.
galileo appends one script to each HTML page a source serves instead:

```html
<script async nonce="…" src="/__xo/bridge.js"></script>
```

When the page is framed, the bridge posts where it is, and posts again
whenever that changes:

```js
parent.postMessage({ galileo: "where", href: location.href, title: document.title }, "*");
```

- It looks at the address a few times a second, and on `popstate`,
  `hashchange` and `pageshow`, so single-page apps are followed too. It never
  wraps the page's own functions.
- On a click of a link on the same address, it posts where the link goes
  before the page leaves, since an image or a file has no bridge of its own.
- A link to another site opens in a tab of its own (the frame shows sources
  only); a link to another source stays in the frame, and telescope follows it.
- telescope accepts a message only from its current frame, and only from a
  source's origin, `http://<name>.localhost:<port>`. galileo lets only its own
  origins frame a source, so nothing else receives what the bridge posts.
- Outside a frame, the bridge does nothing.

## Files

```
index.html      the page: the bar and the Sources page
telescope.js    the bar and the router: sources, paths, the frame, the Sources page
telescope.css   its styles
bridge.js       the script galileo appends to each page a source serves
icon.svg        the XO mark, galileo's icon
```

No dependencies and no build step. galileo serves `index.html` for its
routes, `telescope.js`, `telescope.css` and `icon.svg` under
`/__xo/telescope/` on its own host, and `bridge.js` at `/__xo/bridge.js` on
every source's host. telescope builds everything it shows with text nodes,
under a policy that allows scripts and styles from galileo's own host only.

## Limits

- A page whose security policy is set in a `<meta>` tag may block the bridge;
  the frame still works, but the bar doesn't follow that page.
- A navigation the page makes by script to something that isn't a page (an
  image, a file) isn't seen until a page with the bridge loads again.
