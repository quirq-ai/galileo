# AGENTS.md: working on galileo

galileo is XO's local inspector: it gives every app on a local port (or at a
URL) its own address on one port, and carries telescope, XO's in-page bar,
into every page it serves. telescope is part of this repo, in `telescope/`:
both the bar in the page and its server side. This file is the contract for
agents and people changing either.

galileo is heading toward inspecting files, folders and the traffic it
carries too. That work is planned, not built, and follows
[docs/ROADMAP.md](docs/ROADMAP.md).

## Read first

1. [README.md](README.md): what galileo is and how to run it.
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how a request moves through
   it, and telescope through a page, with a diagram for each flow.
3. [docs/DECISIONS.md](docs/DECISIONS.md): why it works that way. A change
   that goes against a decision updates that file in the same change.
4. [docs/REFERENCE.md](docs/REFERENCE.md): exact routes, headers, settings and
   files, when you need them.
5. [telescope/README.md](telescope/README.md): telescope's tools, designs,
   navbar and page API, before changing anything in `telescope/`.
6. [docs/ROADMAP.md](docs/ROADMAP.md): before building toward the inspector.

Inside the quirq workspace, quirq's own `AGENTS.md` governs the outer
repository; this file governs galileo.

## Where things are

| To change | Edit | Test | Then update |
| --- | --- | --- | --- |
| names, addresses, which app and version a host means | `src/targets.mjs` | `test/targets.test.mjs` | REFERENCE: Apps and addresses |
| the proxy, the WebSocket tunnel, the waiting and 404 pages | `src/server.mjs` | `test/gateway.test.mjs` | ARCHITECTURE, REFERENCE |
| the admin API, health, the list of apps telescope reads | `src/server.mjs` (`handleLauncher`, `handleXo`) | `test/gateway.test.mjs`, `test/mounted.test.mjs` | REFERENCE: The APIs |
| which responses carry telescope, header rewrites, the tag | `telescope/server/inject.mjs` | `telescope/test/inject.test.mjs` | REFERENCE: What changes in a page |
| telescope's API: threads, captures, designs, agent requests | `telescope/server/api.mjs`, `store.mjs`, `uploads.mjs` | `test/gateway.test.mjs` | REFERENCE: The APIs, Data |
| the bar in the page | `telescope/src/` | `telescope/test/bundle.test.mjs`, then by hand in the demo | telescope/README |
| what a design may hold | `telescope/layout.mjs` | `telescope/test/layout.test.mjs` | telescope/README: Designs |
| galileo's home page and launcher | `home/`, `launcher/` | `test/gateway.test.mjs`, then by hand | README |
| how hosts mount galileo | `index.mjs`, `createGateway`'s options | `test/mounted.test.mjs` | README, REFERENCE: As a library, and xo-client |

## What belongs here

- **galileo routes, carries and keeps**: it keeps a list of apps by name,
  routes each request by hostname to the app's port or URL, carries telescope
  into pages, and keeps what telescope produces. Its home page explains it and
  the launcher manages the list; neither grows into an app UI.
- **galileo starts nothing.** It doesn't run commands, discover folders or
  projects, or manage processes. Apps run however their owners run them. The
  inspector work keeps this: a folder will be read, never run.
- **telescope is the bar in every page**, in `telescope/`, both halves of it:
  browser scripts in `telescope/src/`, the design schema in
  `telescope/layout.mjs` and the bundles in `telescope/index.mjs`, and its
  server side in `telescope/server/`: its `/__xo/` routes (`createTelescope`
  in `api.mjs`), its page rules (`inject.mjs`) and what it keeps (`store.mjs`,
  `uploads.mjs`). galileo's `src/` only routes and proxies; it imports
  `telescope/server/index.mjs` and hands telescope every `/__xo/` request that
  isn't galileo's own. It never reaches into `telescope/src/`.
- **The name telescope is for people; the wire names stay.** telescope was
  called xo-toolbar. Text people read (pages, labels, logs, docs) says
  telescope. Internal names keep "toolbar" so pages, hosts and saved designs
  keep working: the `/__xo/toolbar/*` and `/__xo/api/toolbar(s)` routes,
  `data-xo-toolbar` and the other tag attributes, `<xo-toolbar>`,
  `window.__xo_toolbar`, the `xo-toolbar:*` storage keys and event,
  `x-xo-skip-toolbar`, `?xo_toolbar=off`, `XoToolbarSchema`, and
  `data/toolbars/`. Don't rename one without a migration and a matching
  change in every host.
- **Hosts mount galileo.** xo-client runs it inside its own server on
  `localhost:3000`. Keep that contract working (below).

## Rules that keep galileo safe

Each is a decision in `docs/DECISIONS.md`. Don't weaken one without updating it
and saying so in the change.

1. Listen on `127.0.0.1` only.
2. The bare host is never proxied. It alone can add or remove apps and change
   any app's design. Its API takes same-origin JSON only (`guardSameOrigin`,
   `requireJson`).
3. An app's API answers only that app's own origin, and only about that app.
   Pages never see where uploads sit on disk (`publicUpload`).
4. An unknown app or version name never falls through to another one.
5. Pages stream: the tag is appended at the end as the body passes through.
   Never buffer a page, and never append to a compressed body. Header rewrites
   loosen only what telescope needs.
6. Everything telescope uses lives under `/__xo/` on the page's own origin.
7. galileo never runs a command or starts a process.
8. No dependencies and no build step: plain ESM on Node 20+ and its own
   modules for galileo, plain classic scripts for telescope's browser code.

The inspector work adds rules of its own, listed in
[docs/ROADMAP.md](docs/ROADMAP.md): read a folder and never run it, never
serve hidden files or anything outside the folder, never show a folder's path
to a page, keep traffic on this machine with secrets masked, and never slow a
response to record it. A part that ships brings its rules here and into
DECISIONS.md.

## The contract with hosts

xo-client depends on these; changing one means changing xo-client too:

- `index.mjs` exports: `createGateway`, `logApp`, `appUrl`, `ownsRequest`,
  `parseTargetSpec`.
- `createGateway` options: `targets`, `dataDir`, `port`, `addAppsIn`,
  `addAppsAt`, `log`. Old options (`roots`, `exclude`, `idleMinutes`, `env`)
  are ignored rather than refused, so hosts written for them still start.
- What it returns: `server`, `handle`, `upgrade`, `owns`, `store` (telescope's
  store), `registry`, and `close()` (nothing to stop today; hosts await it).
- `ownsRequest`: every `*.localhost` host, and `/__xo/*` on the bare host.
- The admin API under `/__xo/api/` (`targets`, `targets/:name`,
  `targets/:name/versions/:version`, `toolbars`) and the shape of an app in
  `GET /__xo/api/targets`: `name`, `url`, `defaultVersion`, `upstream`, `up`,
  and `versions` with `name`, `url`, `default`, `upstream`, `up`.
- The tag's attributes and the `/__xo/` routes telescope calls, and
  `/__xo/toolbar/designer.js` with its `XoDesigner` global, which xo-client's
  Settings › Apps mounts.

## Code

- Plain ESM `.mjs` with tabs, double quotes and semicolons, like the code
  around it.
- Rules without I/O stay pure and testable without a server: names and routing
  in `src/targets.mjs`, page rules in `telescope/server/inject.mjs`. I/O stays
  in `src/server.mjs` and in telescope's routes and stores (`telescope/server/`).
- API errors are `Object.assign(new Error(message), { status })`, answered as
  `{ error }` JSON.
- Comments say what a function returns or does and why, in plain sentences.
  Match the surrounding density.
- Text people read (pages, logs, docs): short, plain sentences, and no em or en
  dashes.

## Docs

- Docs describe what works today. Plans live in `docs/ROADMAP.md`, marked as
  plans, and move into the other docs when they ship.
- A behavior change updates the docs in the same change: the README for what
  people do, `docs/REFERENCE.md` for exact behavior, `docs/ARCHITECTURE.md`
  for how parts connect (and its diagrams), `docs/DECISIONS.md` for why.
- Diagrams are Mermaid, kept in the docs. Check that each one renders with
  Mermaid 11, the version GitHub uses, and that links and anchors resolve.

## Test and verify

```bash
npm test          # node --test over test/ and telescope/test/ (Node 21+, for the globs)
npm run demo      # the sample app as acme's dev and live versions, with telescope
```

- Suites: galileo's `targets` (names, routing), `gateway` (end to end, through
  the sample app, telescope's routes included) and `mounted` (inside another
  server), and telescope's `inject` (page rules, headers), `bundle` (the
  bundles galileo serves) and `layout` (the design schema).
- telescope's browser code has no browser tests yet. After changing
  `telescope/src/`, run the demo and use the bar on a page.
- A behavior change comes with a test. Pure rules get unit tests; routing and
  proxy changes get an end-to-end case.
- One galileo per data folder. When running a second copy (a demo beside a
  real one, say), give it its own `XO_GATEWAY_DATA`: two sharing one overwrite
  each other's threads and apps.

## Git

- galileo is its own repository, public at `github.com/quirq-ai/galileo`
  (branch `main`). Never commit `data/`, `.env.local`, captures, logs or
  secrets; `.gitignore` already excludes the first two.
- Commit and push only when asked. Keep commits focused, with a plain
  imperative subject.
