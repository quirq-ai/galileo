# AGENTS.md: working on galileo

galileo is the inspector of a space: it keeps a list of sources (apps on ports
of this machine, and files or folders on it), gives each its own address, and
serves telescope, the bar and router that shows them one at a time. This is
v0, small on purpose so people can try it. This file is the contract for
agents and people changing it.

## Read first

1. [README.md](README.md): what galileo is and how to run it.
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how a request moves through
   it, and telescope through a page, with a diagram for each flow.
3. [docs/DECISIONS.md](docs/DECISIONS.md): why it works that way. A change
   that goes against a decision updates that file in the same change.
4. [docs/REFERENCE.md](docs/REFERENCE.md): exact routes, headers, files and
   data, when you need them.
5. [telescope/README.md](telescope/README.md): the bar, the router and the
   bridge, before changing anything in `telescope/`.
6. [docs/ROADMAP.md](docs/ROADMAP.md): what v0 leaves out, where it is in git
   history, and what may come next.

Inside the quirq workspace, quirq's own `AGENTS.md` governs the outer
repository; this file governs galileo.

## Where things are

| To change | Edit | Test | Then update |
| --- | --- | --- | --- |
| names, ports and paths, which source a host means, the saved list | `src/sources.mjs` | `test/sources.test.mjs` | REFERENCE: Sources and addresses |
| routes, the sources API, the proxy and tunnel, the pages galileo makes | `src/server.mjs` | `test/galileo.test.mjs` | ARCHITECTURE, REFERENCE: Routes |
| which responses get the bridge, framing, a page's policy, headers | `src/inject.mjs` | `test/inject.test.mjs` | REFERENCE: What changes, DECISIONS 9 and 10 |
| what a files source serves, and how | `src/files.mjs` | `test/files.test.mjs`, `test/galileo.test.mjs` | REFERENCE: Files sources, DECISIONS 11 |
| the bar, the router, the Sources page | `telescope/index.html`, `telescope.js`, `telescope.css` | by hand, in the demo | telescope/README |
| the bridge | `telescope/bridge.js` | `test/galileo.test.mjs` serves it; by hand, in the demo | telescope/README: The bridge |
| the demo | `demo.mjs`, `sample-app/` | `npm run demo` | README: The demo |

## What belongs here

- **galileo inspects; it starts nothing.** It never runs a command, starts a
  process, or writes to a source. A port source has to be running already.
- **Two kinds of source**, ports and files. Anything new is a decision first
  (`docs/DECISIONS.md`), and a plan in `docs/ROADMAP.md`.
- **telescope is galileo's whole page**: the bar and the router, with sources
  in a frame. It talks to galileo through the sources API only, and to a
  source's pages through the bridge only.
- **galileo's own host never serves a source.** Telescope and the sources API
  live there; every source lives at `<name>.localhost:<port>`.
- **v0 stays small.** The in-page tools, designs, versions, URLs as sources,
  the launcher and mounting in xo-client are out until feedback brings them
  back (`docs/ROADMAP.md`). xo-client mounted the old galileo and isn't on v0
  yet.

## Rules that keep galileo safe

Each is a decision in `docs/DECISIONS.md`. Don't weaken one without updating it
and saying so in the change.

1. Listen on `127.0.0.1` only.
2. Only galileo's own pages may use the sources API: same-origin requests,
   and changes as JSON (`guardSameOrigin`, `requireJson`).
3. No source is ever served on galileo's own host, an unknown name never
   falls through to another source, and a foreign host gets `421` and nothing
   else.
4. Only galileo's origins, and the source itself, may frame a source
   (`framePolicy`) or open its WebSockets. A frame gets fullscreen and
   clipboard writes only.
5. Pages stream: the bridge is appended at the end as the body passes through.
   Never buffer a page, never append to a compressed body, and loosen a page's
   policy only for the bridge.
6. Files are read only: `GET` and `HEAD`, and judged by where they really are
   (`insideSource`): nothing outside the source and nothing hidden, links
   included.
7. galileo never runs a command or starts a process.
8. No dependencies and no build step: plain ESM on Node 20+ and its own
   modules, plain scripts for telescope.

## Code

- Plain ESM `.mjs` with tabs, double quotes and semicolons, like the code
  around it. telescope's scripts are plain browser scripts in an IIFE.
- Rules without I/O stay pure and testable without a server: names, locations
  and routing in `src/sources.mjs`, headers and policies in `src/inject.mjs`,
  path rules in `src/files.mjs` (`pathSegments`). I/O stays in
  `src/server.mjs`, `src/files.mjs` and the registry in `src/sources.mjs`.
- API errors are `Object.assign(new Error(message), { status })`, answered as
  `{ error }` JSON.
- telescope builds what it shows with text nodes; a source's text is never
  parsed as HTML.
- Comments say what a function returns or does and why, in plain sentences.
  Match the surrounding density.
- Text people read (pages, logs, docs): short, plain sentences, and no em or en
  dashes.

## Docs

- Docs describe what works today. Plans live in `docs/ROADMAP.md`, marked as
  plans, and move into the other docs when they ship.
- A behavior change updates the docs in the same change: the README for what
  people do, `docs/REFERENCE.md` for exact behavior, `docs/ARCHITECTURE.md` for
  how parts connect (and its diagrams), `docs/DECISIONS.md` for why.
- Diagrams are Mermaid, kept in the docs. Check that each one renders with
  Mermaid 11, the version GitHub uses, and that links and anchors resolve.

## Test and verify

```bash
npm test          # node --test over test/ (Node 21+, for the glob)
npm run demo      # Acme Notes on a port, its folder, and the README, as sources
```

- Suites: `sources` (names, locations, routing, the saved list), `inject`
  (which responses get the bridge, framing, policies, headers), `files` (path
  rules, what is inside a source, file types) and `galileo`
  (end to end: galileo's host, the sources API, port sources through the
  sample app, files sources in a scratch folder).
- telescope has no browser tests yet. After changing `telescope/`, run the
  demo, open a source, click around inside it, and check the bar and the
  address follow, Back and Forward included.
- A behavior change comes with a test. Pure rules get unit tests; routing,
  proxy and files changes get an end-to-end case.
- One galileo per data folder. When running a second copy, give it its own
  `GALILEO_DATA`.

## Git

- galileo is its own repository, public at `github.com/quirq-ai/galileo`
  (branch `main`). Never commit `data/`, `.env.local`, logs or secrets;
  `.gitignore` already excludes the first two.
- Commit and push only when asked. Keep commits focused, with a plain
  imperative subject.
