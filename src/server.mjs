#!/usr/bin/env node
/**
 * galileo, the XO gateway: a local reverse proxy in front of several apps that
 * carries the XO toolbar (its own project, xo-toolbar) into every HTML page it
 * serves, the way Vercel's edge carries its toolbar into preview deployments.
 *
 *   localhost:4100               home: what galileo routes now, and how it works
 *   localhost:4100/launcher      the launcher: apps, versions, toolbar designs
 *   acme.localhost:4100      ──▶ acme's default version
 *   dev.acme.localhost:4100  ──▶ http://localhost:5173   (acme's dev version)
 *   live.acme.localhost:4100 ──▶ https://acme.vercel.app (acme's live version)
 *   acme.localhost:4100/dev/…  ─▶ 302 to dev.acme.localhost:4100/…
 *
 * Each app and each version is reached by name, so each is its own origin and
 * they never share cookies, storage or service workers. For an app's hosts:
 *
 *   /__xo/*            answered here: toolbar files and the app's toolbar API
 *   WebSocket upgrade  tunnelled to that version (dev-server hot reload)
 *   anything else      proxied to that version; HTML pages get the loader tag appended
 *
 *   node src/server.mjs --target dev.acme=5173 --target live.acme=https://acme.vercel.app --port 4100
 *
 * It runs on its own, or mounted in another server that shares its port, as
 * xo-client does: that server passes every request `owns(req)` claims to
 * `handle`, and every such WebSocket upgrade to `upgrade`, and answers the
 * rest itself. The bare host is then the other app's, except `/__xo/*`.
 *
 * Folders become apps by themselves: with `roots`, every folder in them gets
 * `<folder>.localhost` without being added. One with a dev command is served
 * by its dev server, found already running or started when you open it; any
 * other is served as files.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { XO_PREFIX, loaderTag, responseHeaders, shouldInject, upstreamRequestHeaders } from "./inject.mjs";
import { createStore } from "./store.mjs";
import { createDiscovery } from "./discover.mjs";
import { createFolderFiles } from "./files.mjs";
import { createRunner } from "./runner.mjs";
import { appUrl, createRegistry, ownsRequest, parseTargetSpec, portOf, routeForHost, versionPick } from "./targets.mjs";
import { toolbar } from "./toolbar.mjs";
import { createUploads } from "./uploads.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = path.join(HERE, "..");
const LAUNCHER_DIR = path.join(HERE, "..", "launcher");
const HOME_DIR = path.join(HERE, "..", "home");
/** Where the launcher is on the bare host; the home page has `/`. */
const LAUNCHER_PATH = "/launcher";
/** Pages of the gateway's own: scripts and styles from this origin only. */
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'";
/** Folders xo-space keeps for itself in the XO root, which are never apps. */
const XO_SPACE_FOLDERS = ["agents", "memory", "state", "projects"];
const MAX_BODY_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 600;

export function createGateway({
	targets = [],
	dataDir = path.join(HERE, "..", "data"),
	/** The port the gateway is reached on, when a host that mounts it listens instead of `server`. */
	port,
	/**
	 * Folders whose folders become apps, each at `<folder>.localhost`. None by
	 * default. `{ dir, projectsOnly: true }` makes apps of its xo-projects only.
	 */
	roots = [],
	/** Folders never treated as apps, besides this checkout (a host passes its own). */
	exclude = [],
	/** How long a dev server the gateway started keeps running without a request. */
	idleMinutes = 30,
	/** Where people add apps, as the 404 pages name it; xo-client passes "Settings › Apps". */
	addAppsIn = "the launcher",
	/** The bare-host path the 404 pages link to for that: the launcher on its own, the host's home when mounted. */
	addAppsAt = addAppsIn === "the launcher" ? LAUNCHER_PATH : "/",
	/** The environment dev servers start from; a Next.js host passes the one it had before loading its own. */
	env = process.env,
	log = (...parts) => console.log("[gateway]", ...parts),
}) {
	const registry = createRegistry({ dataDir, initial: targets });
	const store = createStore(dataDir);
	const uploads = createUploads(dataDir);
	const runId = randomBytes(3).toString("hex");
	const runner = createRunner({ idleMs: idleMinutes * 60_000, log, env });
	const files = createFolderFiles();
	const folders = roots.length ? createDiscovery({ roots, exclude: [GATEWAY_DIR, ...exclude], log, onChange: releaseGone }) : null;

	/**
	 * A folder that disappeared takes its dev server and file server with it.
	 * Checked again 1.5 s later, so a folder replaced in one rename (an atomic
	 * save, a checkout) isn't taken for a deleted one. Works from the folders it
	 * is given: a lookup here would scan again and call back in.
	 */
	function releaseGone(current) {
		const dirs = new Set([...current.values()].map((folder) => folder.dir));
		const gone = [
			...runner.active().filter((run) => !dirs.has(run.dir)),
			...files.list().filter((dir) => !dirs.has(dir)).map((dir) => ({ dir })),
		];
		if (!gone.length) return;
		const timer = setTimeout(() => {
			for (const item of gone) {
				if (existsSync(item.dir)) continue;
				if (item.name) runner.stop(item.name, "removed");
				else files.close(item.dir);
			}
		}, 1500);
		timer.unref?.();
	}

	/** An app by name: one added on the command line or in the launcher, a folder in a root, or both at once. */
	function lookup(name) {
		return withFolder(registry.get(name), folders?.get(name));
	}

	/** Every app's name, added or found, in order. */
	function appNames() {
		const names = new Set(registry.list().map((target) => target.name));
		for (const folder of folders?.list() ?? []) names.add(folder.name);
		return [...names].sort();
	}

	/** Answers a request: the home page, the launcher and their API on the bare host, an app on each of its hosts. */
	function handle(req, res) {
		const route = routeForHost(req.headers.host, lookup);
		const done = (promise) => promise.catch((error) => sendJson(res, error.status ?? 500, { error: error.message }));
		if (route.kind === "launcher") return done(handleLauncher(req, res));
		if (route.kind === "unknown") return unknownApp(req, res, route.name);
		if (route.kind === "unknown-version") return unknownVersion(req, res, route);
		if (req.url.startsWith(XO_PREFIX)) return done(withCurrentUpstream(route).then((current) => handleToolbar(req, res, current)));
		// acme.localhost:4100/dev/pricing picks the dev version: dev.acme.localhost:4100/pricing.
		const pick = versionPick(req, route, portFor(req));
		if (pick) {
			res.writeHead(302, { location: pick, "cache-control": "no-store" });
			res.end();
			return;
		}
		if (route.version.folder) return done(serveFolderApp(req, res, route));
		proxy(req, res, route);
	}

	/** WebSocket upgrades: tunnelled to the version an app's host names; any other is closed. */
	function upgrade(req, socket, head) {
		const route = routeForHost(req.headers.host, lookup);
		if (route.kind !== "app" || req.url.startsWith(XO_PREFIX)) {
			socket.destroy();
			return;
		}
		if (!route.version.folder) return tunnel(req, socket, head, route);
		// A folder's socket goes to its server only while one is running; it never starts one.
		currentUpstream(route.version.folder).then(
			(upstream) => (upstream ? tunnel(req, socket, head, withUpstream(route, upstream)) : socket.destroy()),
			() => socket.destroy(),
		);
	}

	const server = http.createServer(handle);
	server.on("upgrade", upgrade);

	function portFor(req) {
		return portOf(req.headers.host, port ?? server.address()?.port);
	}

	// --------------------------------------------------------------- folders

	/** Where a folder version is served right now, starting nothing: its files, its running dev server, or null. */
	async function currentUpstream(folder) {
		if (folder.plan.kind === "files") return files.urlFor(folder.dir);
		const current = await runner.resolve(folder);
		return current.state === "running" ? new URL(current.origin) : null;
	}

	async function withCurrentUpstream(route) {
		return route.kind === "app" && route.version.folder ? withUpstream(route, await currentUpstream(route.version.folder)) : route;
	}

	/** A folder app: its files, or its dev server, started when you open the page yourself. */
	async function serveFolderApp(req, res, route) {
		const folder = route.version.folder;
		if (folder.plan.kind === "files") return proxy(req, res, withUpstream(route, await files.urlFor(folder.dir)));
		const current = await runner.resolve(folder, { start: mayStart(req) });
		if (current.state === "running") {
			runner.touch(folder.name);
			return proxy(req, res, withUpstream(route, new URL(current.origin)));
		}
		folderPage(req, res, route, current);
	}

	/** A folder app that isn't answering: starting (the page refreshes itself), failed, or not running, with a Start button. */
	function folderPage(req, res, route, current) {
		const { target, version } = route;
		const folder = version.folder;
		const status = runner.status(target.name);
		const starting = current.state === "starting";
		const failed = current.state === "failed";
		if (!acceptsHtml(req)) {
			res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "2", "cache-control": "no-store" });
			res.end(`${target.name} is ${starting ? "starting" : "not running"}\n`);
			return;
		}
		const command = status?.command ?? [folder.plan.command.file, ...folder.plan.command.args].join(" ");
		const cwd = status?.cwd ?? folder.plan.command.cwd;
		const title = starting ? `Starting ${target.name}` : failed ? `${target.name} didn't start` : `${target.name} isn't running`;
		const seconds = starting && status ? Math.round((Date.now() - status.startedAt) / 1000) : 0;
		const lead = starting
			? `Running <code>${escapeHtml(command)}</code> in <code>${escapeHtml(cwd)}</code>, ${seconds} s so far. This page opens ${escapeHtml(target.name)} as soon as it answers.`
			: failed
				? `<code>${escapeHtml(command)}</code> ${escapeHtml(status?.error ?? "stopped")}.`
				: `Its dev server isn't running${status?.error ? ` (${escapeHtml(status.error)})` : ""}. Starting it runs <code>${escapeHtml(command)}</code> in <code>${escapeHtml(cwd)}</code>.`;
		const button = starting
			? ""
			: `<form method="post" action="/__xo/api/start?next=${escapeHtml(encodeURIComponent(req.url))}">` +
				`<button type="submit" style="font:inherit;padding:8px 14px;border:0;border-radius:8px;background:#3f6e18;color:#fff;cursor:pointer">` +
				`${failed ? "Try again" : `Start ${escapeHtml(target.name)}`}</button></form>`;
		const output = status?.output?.length
			? `<pre style="margin-top:20px;padding:12px;border-radius:8px;background:#f2f3ef;color:#333;font:12px/1.5 ui-monospace,Menlo,monospace;` +
				`white-space:pre-wrap;overflow-wrap:anywhere;max-height:50vh;overflow:auto">${escapeHtml(status.output.join("\n"))}</pre>`
			: "";
		const nonce = randomBytes(16).toString("base64");
		res.writeHead(starting ? 503 : failed ? 502 : 503, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
		});
		res.end(
			`<!doctype html><meta charset="utf-8">${starting ? '<meta http-equiv="refresh" content="1">' : ""}<title>${escapeHtml(title)}</title>` +
				`<body style="font:15px/1.5 system-ui;padding:48px;color:#222;max-width:900px"><h1 style="font-size:20px">${escapeHtml(title)}</h1>` +
				`<p>${lead}</p>${button}<p style="color:#666;font-size:13px">From ${escapeHtml(folder.plan.source)}. ` +
				`A dev server the gateway starts stops after ${idleMinutes} idle minutes.</p>${output}</body>` +
				tagFor(route, nonce),
		);
	}

	// ------------------------------------------------------------------ apps

	/** Forwards a request to the version the host names, and carries the toolbar into pages. */
	function proxy(req, res, route) {
		const upstream = route.version.upstream;
		const secure = upstream.protocol === "https:";
		const upstreamReq = (secure ? https : http).request(
			{
				hostname: upstream.hostname,
				port: upstreamPort(upstream),
				method: req.method,
				path: req.url,
				headers: upstreamRequestHeaders(req.headers, upstream),
				servername: secure ? upstream.hostname : undefined,
			},
			(up) => {
				const inject = shouldInject(req, up);
				const nonce = inject ? randomBytes(16).toString("base64") : undefined;
				res.writeHead(
					up.statusCode ?? 502,
					up.statusMessage,
					responseHeaders(up.headers, {
						inject,
						nonce,
						upstreamOrigin: upstream.origin,
						gatewayOrigin: `http://${req.headers.host}`,
					}),
				);
				if (!inject) {
					up.pipe(res);
					return;
				}
				up.pipe(appendAtEnd(`\n${tagFor(route, nonce)}\n`)).pipe(res);
			},
		);
		upstreamReq.on("error", (error) => {
			if (res.headersSent) {
				res.destroy(error);
				return;
			}
			unreachable(req, res, error, route);
		});
		req.pipe(upstreamReq);
	}

	function tagFor({ target, version }, nonce) {
		return loaderTag({
			nonce,
			previewId: `${target.name}-${version.name}-${runId}`,
			project: target.name,
			version: version.name,
			versions: target.versions.map((item) => item.name),
		});
	}

	/** The version is down: a page that says so, still carrying the toolbar, and retries by itself. */
	function unreachable(req, res, error, route) {
		const name = describeRoute(route);
		const origin = route.version.upstream.origin;
		if (!acceptsHtml(req)) {
			res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end(`${name} (${origin}) is not reachable: ${error.code ?? error.message}\n`);
			return;
		}
		const nonce = randomBytes(16).toString("base64");
		res.writeHead(502, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
		});
		res.end(
			`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>Waiting for ${escapeHtml(name)}</title>` +
				`<body style="font:15px system-ui;padding:48px;color:#222"><h1 style="font-size:20px">Waiting for ${escapeHtml(name)}</h1>` +
				`<p>Nothing is answering at ${escapeHtml(origin)} yet (${escapeHtml(error.code ?? error.message)}). ` +
				`This page retries every 2 seconds.</p></body>` +
				tagFor(route, nonce),
		);
	}

	/** A name nobody registered: list the ones that are, and point to where apps are added. */
	function unknownApp(req, res, name) {
		const port = portFor(req);
		if (!acceptsHtml(req)) return sendJson(res, 404, { error: `No app called "${name}" on this gateway` });
		const links = appNames()
			.map((app) => `<li><a href="${appUrl(app, port)}">${escapeHtml(app)}</a></li>`)
			.join("");
		res.writeHead(404, {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
		});
		res.end(
			`<!doctype html><meta charset="utf-8"><title>No app called ${escapeHtml(name)}</title>` +
				`<body style="font:15px system-ui;padding:48px;color:#222"><h1 style="font-size:20px">No app called “${escapeHtml(name)}”</h1>` +
				`<p>Apps on this gateway:</p><ul>${links || "<li>none yet</li>"}</ul>` +
				`<p><a href="http://localhost:${port}${addAppsAt}">Add one in ${escapeHtml(addAppsIn)}</a></p></body>`,
		);
	}

	/** A version name nobody registered for this app: list the ones that are. */
	function unknownVersion(req, res, route) {
		const { target, name } = route;
		const port = portFor(req);
		if (!acceptsHtml(req)) return sendJson(res, 404, { error: `${target.name} has no version called "${name}"` });
		const links = target.versions
			.map((version) => `<li><a href="${appUrl(target.name, port, version.name)}">${escapeHtml(version.name)}</a></li>`)
			.join("");
		res.writeHead(404, {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
		});
		res.end(
			`<!doctype html><meta charset="utf-8"><title>No version called ${escapeHtml(name)}</title>` +
				`<body style="font:15px system-ui;padding:48px;color:#222"><h1 style="font-size:20px">${escapeHtml(target.name)} has no version called “${escapeHtml(name)}”</h1>` +
				`<p>Versions of ${escapeHtml(target.name)}:</p><ul>${links}</ul>` +
				`<p><a href="http://localhost:${port}${addAppsAt}">Add one in ${escapeHtml(addAppsIn)}</a></p></body>`,
		);
	}

	/** WebSocket upgrades (dev-server hot reload) are piped straight through to the version. */
	function tunnel(req, socket, head, route) {
		const upstream = route.version.upstream;
		const secure = upstream.protocol === "https:";
		const port = upstreamPort(upstream);
		const upstreamSocket = secure
			? tls.connect({ host: upstream.hostname, port, servername: upstream.hostname })
			: net.connect({ host: upstream.hostname, port });
		upstreamSocket.once(secure ? "secureConnect" : "connect", () => {
			const lines = [`${req.method} ${req.url} HTTP/1.1`];
			for (let i = 0; i < req.rawHeaders.length; i += 2) {
				const name = req.rawHeaders[i];
				lines.push(`${name}: ${name.toLowerCase() === "host" ? upstream.host : req.rawHeaders[i + 1]}`);
			}
			upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
			if (head?.length) upstreamSocket.write(head);
			upstreamSocket.pipe(socket);
			socket.pipe(upstreamSocket);
		});
		const close = () => {
			socket.destroy();
			upstreamSocket.destroy();
		};
		upstreamSocket.on("error", close);
		socket.on("error", close);
	}

	// ------------------------------------------------------ an app's /__xo/*

	async function handleToolbar(req, res, where) {
		const { target, version } = where;
		const url = new URL(req.url, "http://gateway");
		const route = url.pathname;

		if (req.method === "GET" && route.startsWith("/__xo/toolbar/")) {
			return sendBundle(res, route.slice("/__xo/toolbar/".length));
		}
		if (req.method === "GET" && route === "/__xo/health") {
			return sendJson(res, 200, { ok: true, app: target.name, version: version.name, upstream: version.upstream?.origin ?? null });
		}
		if (req.method === "GET" && route.startsWith("/__xo/uploads/")) {
			if (await uploads.serve(target.name, route.slice("/__xo/uploads/".length), req, res)) return;
			return sendJson(res, 404, { error: "No such upload" });
		}
		if (!route.startsWith("/__xo/api/")) return sendJson(res, 404, { error: "Not found" });

		// Only the toolbar, running on this app's own origin, may use its API.
		// Another app on the gateway, or on another localhost port, is refused.
		guardSameOrigin(req);

		// A folder app's own Start button, from its page on its own origin.
		if (route === "/__xo/api/start" && req.method === "POST") {
			const folder = version.folder;
			if (!folder || folder.plan.kind !== "run") return sendJson(res, 400, { error: `${target.name} has nothing to start` });
			await runner.start(folder);
			const next = url.searchParams.get("next");
			if (next && next.startsWith("/") && !next.startsWith("//")) {
				res.writeHead(303, { location: next, "cache-control": "no-store" });
				return res.end();
			}
			return sendJson(res, 202, { status: runner.status(target.name) });
		}

		// The switcher reads the list; changing it is left to the launcher.
		// The navbar reads this from app pages: a folder shows where it is, never its dev server's output.
		if (route === "/__xo/api/targets" && req.method === "GET") {
			const targets = (await describeTargets(req)).map(forPage);
			return sendJson(res, 200, { current: target.name, currentVersion: version.name, manageIn: addAppsIn, targets });
		}

		if (route === "/__xo/api/threads" && req.method === "GET") {
			return sendJson(res, 200, { threads: store.list({ target: target.name, page: url.searchParams.get("page") ?? undefined }) });
		}
		if (route === "/__xo/api/uploads" && req.method === "POST") {
			const upload = await uploads.save(target.name, req);
			log(`${target.name}: saved ${upload.kind} ${upload.file} (${Math.round(upload.size / 1024)} KB)`);
			return sendJson(res, 201, { upload: publicUpload(upload) });
		}
		const uploadRoute = /^\/__xo\/api\/uploads\/(u_[a-z0-9]+)$/.exec(route);
		if (uploadRoute && req.method === "DELETE") {
			return (await uploads.remove(target.name, uploadRoute[1])) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "No such upload" });
		}

		// This app's toolbar design. Saving one gives the app its own; deleting it
		// hands the app back the gateway's default.
		if (route === "/__xo/api/toolbar" && req.method === "GET") {
			return sendJson(res, 200, design(store.getLayout(target.name)));
		}
		if (route === "/__xo/api/toolbar" && req.method === "PUT") {
			requireJson(req);
			const layout = store.saveLayout(target.name, await readJson(req));
			log(`${target.name}: toolbar design saved (${layout.items.length} items, dock ${layout.dock.position})`);
			return sendJson(res, 200, design({ layout, source: "app" }));
		}
		if (route === "/__xo/api/toolbar" && req.method === "DELETE") {
			log(`${target.name}: back to the default toolbar design`);
			return sendJson(res, 200, design(store.resetLayout(target.name)));
		}

		if (route === "/__xo/api/threads" && req.method === "POST") {
			const body = await readJson(req);
			const input = {
				target: target.name,
				version: version.name,
				// Empty for a comment on the whole page, such as one carrying a screenshot of it.
				nodeId: text(body.nodeId, 4000, ""),
				anchor: anchor(body.anchor),
				page: text(body.page, 2000),
				pageTitle: text(body.pageTitle, 300, ""),
				selectionRange: body.selectionRange?.text ? { text: text(body.selectionRange.text, 500) } : undefined,
				screenWidth: whole(body.screenWidth),
				screenHeight: whole(body.screenHeight),
				text: text(body.text, 5000),
				author: text(body.author, 80, "Local user"),
				attachments: await resolveAttachments(target.name, body.attachments),
			};
			const thread = store.create(input);
			log(`${describeRoute(where)}: comment on ${input.page} (${firstSelector(input.nodeId)}): ${JSON.stringify(input.text)}`);
			return sendJson(res, 201, { thread });
		}

		const threadRoute = /^\/__xo\/api\/threads\/([\w-]+)(\/comments)?$/.exec(route);
		if (threadRoute) {
			const [, id, comments] = threadRoute;
			if (comments && req.method === "POST") {
				const body = await readJson(req);
				const thread = store.reply(id, target.name, {
					text: text(body.text, 5000),
					author: text(body.author, 80, "Local user"),
					attachments: await resolveAttachments(target.name, body.attachments),
				});
				return thread ? sendJson(res, 200, { thread }) : sendJson(res, 404, { error: "No such thread" });
			}
			if (!comments && req.method === "PATCH") {
				const body = await readJson(req);
				if (body.status !== "open" && body.status !== "resolved") {
					return sendJson(res, 400, { error: "status must be open or resolved" });
				}
				const thread = store.setStatus(id, target.name, body.status);
				return thread ? sendJson(res, 200, { thread }) : sendJson(res, 404, { error: "No such thread" });
			}
			if (!comments && req.method === "DELETE") {
				return store.remove(id, target.name) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "No such thread" });
			}
		}

		if (route === "/__xo/api/agent" && req.method === "POST") {
			const body = await readJson(req);
			const element = typeof body.element === "object" && body.element !== null ? body.element : undefined;
			// Agents get file paths, so they can open a screenshot or recording directly.
			const attachments = (await resolveAttachments(target.name, body.attachments, true)) ?? [];
			const logs = Array.isArray(body.logs) ? body.logs.slice(-200).map((entry) => clipJson(entry, 2000)) : undefined;
			const ask = text(body.ask, 4000, "");
			if (!ask && !attachments.length) return sendJson(res, 400, { error: "Say what the agent should do" });
			const entry = store.recordAgentRequest({
				target: target.name,
				// The version the person was looking at, and what served it.
				version: version.name,
				upstream: version.upstream?.origin ?? null,
				ask,
				page: text(body.page ?? element?.page, 2000, ""),
				element,
				attachments,
				logs,
				environment: typeof body.environment === "object" && body.environment !== null ? clipJson(body.environment, 4000) : undefined,
			});
			const extras = [
				attachments.length ? attachments.map((item) => `${item.kind} ${item.path}`).join(", ") : "",
				logs?.length ? `${logs.length} log entries` : "",
			].filter(Boolean);
			log(
				`${describeRoute(where)}: ask the agent${element ? ` about ${firstSelector(element.nodeId)}` : ""} on ${entry.page || "the page"}: ` +
					`${JSON.stringify(ask)}${extras.length ? ` (+ ${extras.join("; ")})` : ""}`,
			);
			return sendJson(res, 202, { id: entry.id });
		}

		return sendJson(res, 404, { error: "Not found" });
	}

	// ------------------------------------------------------------- launcher

	async function handleLauncher(req, res) {
		const url = new URL(req.url, "http://gateway");
		const route = url.pathname;

		if (req.method === "GET" && route === "/") {
			return sendFile(res, path.join(HOME_DIR, "index.html"), { "content-security-policy": PAGE_CSP });
		}
		if (req.method === "GET" && (route === LAUNCHER_PATH || route === `${LAUNCHER_PATH}/`)) {
			return sendFile(res, path.join(LAUNCHER_DIR, "index.html"), { "content-security-policy": PAGE_CSP });
		}
		if (req.method === "GET" && ["/__xo/home/home.js", "/__xo/home/home.css", "/__xo/home/icon.svg"].includes(route)) {
			return sendFile(res, path.join(HOME_DIR, path.basename(route)));
		}
		if (req.method === "GET" && (route === "/__xo/launcher/launcher.js" || route === "/__xo/launcher/launcher.css")) {
			return sendFile(res, path.join(LAUNCHER_DIR, path.basename(route)));
		}
		// The toolbar's design editor, which the launcher mounts to edit any app's design.
		if (req.method === "GET" && route === "/__xo/toolbar/designer.js") {
			return sendBundle(res, "designer.js");
		}
		if (req.method === "GET" && route === "/__xo/health") {
			return sendJson(res, 200, { ok: true, apps: appNames(), roots: folders?.roots ?? [] });
		}
		if (route.startsWith("/__xo/api/")) guardSameOrigin(req);

		if (route === "/__xo/api/targets" && req.method === "GET") {
			return sendJson(res, 200, { targets: await describeTargets(req) });
		}
		// Adds an app, or a version of one: { name, version?, upstream, makeDefault? }.
		if (route === "/__xo/api/targets" && req.method === "POST") {
			requireJson(req);
			const body = await readJson(req);
			const { target, version, isNew } = registry.add({
				name: body.name,
				version: body.version,
				upstream: body.upstream,
				makeDefault: body.makeDefault === true,
			});
			log(`${isNew ? "added" : "updated"} ${target.name} (${version.name}) → ${version.upstream.origin}`);
			return sendJson(res, isNew ? 201 : 200, { target: (await describeTargets(req)).find((item) => item.name === target.name) });
		}
		const appRoute = /^\/__xo\/api\/targets\/([a-z0-9-]+)$/.exec(route);
		if (appRoute && req.method === "DELETE") {
			if (!registry.remove(appRoute[1])) return sendJson(res, 404, { error: "No such app" });
			log(`removed ${appRoute[1]}`);
			return sendJson(res, 200, { ok: true });
		}
		// { defaultVersion }: which version the app's own host serves.
		if (appRoute && req.method === "PATCH") {
			requireJson(req);
			const body = await readJson(req);
			if (!registry.get(appRoute[1])) return sendJson(res, 404, { error: "No such app" });
			if (!registry.setDefault(appRoute[1], String(body.defaultVersion ?? ""))) return sendJson(res, 400, { error: "No such version" });
			log(`${appRoute[1]}: default version is now ${body.defaultVersion}`);
			return sendJson(res, 200, { target: (await describeTargets(req)).find((item) => item.name === appRoute[1]) });
		}
		// A folder app's dev server, started or stopped from the launcher.
		const folderRoute = /^\/__xo\/api\/folders\/([a-z0-9-]+)\/(start|stop)$/.exec(route);
		if (folderRoute && req.method === "POST") {
			const [, name, action] = folderRoute;
			const folder = folders?.get(name);
			if (!folder) return sendJson(res, 404, { error: `No folder called "${name}"` });
			if (action === "start") {
				if (folder.plan.kind !== "run") return sendJson(res, 400, { error: `${name} is served as files, so there is nothing to start` });
				await runner.start(folder);
			} else if (!runner.stop(name)) {
				return sendJson(res, 409, { error: `${name} has no dev server this gateway started` });
			}
			return sendJson(res, 200, { target: (await describeTargets(req)).find((item) => item.name === name) });
		}
		const versionRoute = /^\/__xo\/api\/targets\/([a-z0-9-]+)\/versions\/([a-z0-9-]+)$/.exec(route);
		if (versionRoute && req.method === "DELETE") {
			const [, app, versionName] = versionRoute;
			if (!registry.removeVersion(app, versionName)) return sendJson(res, 404, { error: "No such version" });
			log(`${app}: removed version ${versionName}`);
			return sendJson(res, 200, { target: (await describeTargets(req)).find((item) => item.name === app) });
		}

		// Toolbar designs: the gateway's default, which every app without its own
		// design gets, and each app's own. Only this page can change another
		// app's design; an app's toolbar can only change its own.
		if (route === "/__xo/api/toolbars" && req.method === "GET") {
			const port = portFor(req);
			return sendJson(res, 200, {
				default: store.getDefault(),
				apps: appNames().map((name) => ({ name, url: appUrl(name, port), ...store.getLayout(name) })),
				options: designOptions(),
			});
		}
		const designRoute = /^\/__xo\/api\/toolbars\/(_default|[a-z0-9-]+)$/.exec(route);
		if (designRoute && (req.method === "PUT" || req.method === "DELETE")) {
			const name = designRoute[1];
			const isDefault = name === "_default";
			if (!isDefault && !lookup(name)) return sendJson(res, 404, { error: `No app called "${name}"` });
			if (req.method === "PUT") {
				requireJson(req);
				const body = await readJson(req);
				const layout = isDefault ? store.saveDefault(body) : store.saveLayout(name, body);
				log(`${isDefault ? "default" : name} toolbar design saved from the launcher`);
				return sendJson(res, 200, design({ layout, source: isDefault ? "gateway" : "app" }));
			}
			log(`${isDefault ? "default toolbar design back to built-in" : `${name}: back to the default toolbar design`}`);
			return sendJson(res, 200, design(isDefault ? store.resetDefault() : store.resetLayout(name)));
		}
		return sendJson(res, 404, { error: "Not found" });
	}

	async function sendBundle(res, name) {
		const code = await toolbar.readBundle(name);
		if (code === undefined) return sendJson(res, 404, { error: "Not found" });
		return sendBody(res, 200, "text/javascript; charset=utf-8", code);
	}

	/** Upload ids from a request, checked against this app's own uploads. */
	async function resolveAttachments(app, ids, withPath = false) {
		if (ids === undefined || ids === null) return undefined;
		if (!Array.isArray(ids) || ids.length > 10) throw Object.assign(new Error("attachments must be a list of up to 10 upload ids"), { status: 400 });
		const found = [];
		for (const id of ids) {
			const upload = await uploads.find(app, id);
			if (!upload) throw Object.assign(new Error(`No upload ${String(id).slice(0, 40)} for this app`), { status: 400 });
			found.push(withPath ? { ...publicUpload(upload), path: upload.path } : publicUpload(upload));
		}
		return found;
	}

	/**
	 * Every app with its gateway address, and each of its versions with its own
	 * address and whether its server answers right now. `upstream` and `up` at
	 * the app's level are its default version's. A folder app also says where
	 * it lives, how it is served, and what its dev server is doing.
	 */
	async function describeTargets(req) {
		const port = portFor(req);
		return Promise.all(
			appNames().map(async (name) => {
				const target = lookup(name);
				const versions = await Promise.all(target.versions.map((version) => describeVersion(target, version, port)));
				const main = versions.find((version) => version.default) ?? versions[0];
				const folder = target.folder;
				return {
					name: target.name,
					url: appUrl(target.name, port),
					defaultVersion: main.name,
					upstream: main.upstream,
					up: main.up,
					versions,
					source: registry.get(name) ? (folder ? "added and folder" : "added") : "folder",
					folder: folder
						? {
								dir: folder.dir,
								serves: folder.plan.kind,
								from: folder.plan.source,
								xoProject: folder.xoProject?.name,
								displayName: folder.xoProject?.displayName,
								description: folder.xoProject?.description,
								server: runner.status(name),
							}
						: undefined,
				};
			}),
		);
	}

	async function describeVersion(target, version, port) {
		const base = { name: version.name, url: appUrl(target.name, port, version.name), default: version.name === target.defaultVersion };
		if (!version.folder) return { ...base, upstream: version.upstream.origin, up: await probe(version.upstream) };
		if (version.folder.plan.kind === "files") return { ...base, upstream: "", up: true, state: "files" };
		const current = await runner.resolve(version.folder);
		return { ...base, upstream: current.origin ?? "", up: current.state === "running", state: current.state, external: Boolean(current.external) };
	}

	return {
		server,
		handle,
		upgrade,
		/** Whether a request is the gateway's when it shares a port with another app. */
		owns: (req) => ownsRequest(req.headers.host, req.url),
		store,
		registry,
		/** The folders found in `roots`, or null without roots. */
		folders,
		/** Stops watching the roots and every dev server this gateway started. */
		async close() {
			folders?.close();
			files.closeAll();
			await runner.stopAll();
		},
	};
}

/**
 * A folder as an app with one version: `dev` for a folder that runs, `files`
 * for one served as files. An app added by hand under the same name keeps its
 * own versions and gains the folder's.
 */
function withFolder(target, folder) {
	if (!folder) return target;
	const version = { name: folder.plan.kind === "run" ? "dev" : "files", upstream: null, folder };
	if (!target) return { name: folder.name, defaultVersion: version.name, versions: [version], folder };
	if (target.versions.some((item) => item.name === version.name)) return { ...target, folder };
	return { ...target, versions: [...target.versions, version], folder };
}

/** An app as its pages may see it: a folder's place on disk, with the home folder as `~`, and nothing about its server. */
function forPage(target) {
	if (!target.folder) return target;
	const { dir, serves, from, xoProject, displayName } = target.folder;
	return { ...target, folder: { path: homePath(dir), serves, from, xoProject, displayName } };
}

function homePath(dir) {
	const home = os.homedir();
	return dir === home || dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

function withUpstream(route, upstream) {
	return { ...route, version: { ...route.version, upstream } };
}

/**
 * Only a page you open starts a dev server: a typed address, or a navigation
 * from a page on this machine (the launcher, xo-client, another app). A fetch,
 * an image, or a page on another site never does; nor does a frame another
 * site opens, since its referrer isn't local and it can't pass for a typed one.
 */
export function mayStart(req) {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	const mode = req.headers["sec-fetch-mode"];
	if (mode ? mode !== "navigate" : !acceptsHtml(req)) return false;
	const site = req.headers["sec-fetch-site"];
	if (!site || site === "none" || site === "same-origin") return true;
	try {
		const host = new URL(req.headers.referer).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
	} catch {
		return false;
	}
}

/** Whether anything answers at the app's address, within a short timeout. */
function probe(upstream) {
	return new Promise((resolve) => {
		const secure = upstream.protocol === "https:";
		const req = (secure ? https : http).request(
			{ hostname: upstream.hostname, port: upstreamPort(upstream), method: "HEAD", path: "/", timeout: PROBE_TIMEOUT_MS },
			(res) => {
				res.resume();
				resolve(true);
			},
		);
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(false));
		req.end();
	});
}

function upstreamPort(url) {
	return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}

function appendAtEnd(tail) {
	return new Transform({
		transform(chunk, _encoding, done) {
			done(null, chunk);
		},
		flush(done) {
			done(null, tail);
		},
	});
}

function acceptsHtml(req) {
	return String(req.headers.accept ?? "").includes("text/html");
}

/** Requests from any origin other than this one are refused; tools like curl send no Sec-Fetch-Site and pass. */
function guardSameOrigin(req) {
	const site = req.headers["sec-fetch-site"];
	if (site && site !== "same-origin" && site !== "none") {
		throw Object.assign(new Error("Cross-origin requests are not accepted"), { status: 403 });
	}
}

/** JSON only, so a plain HTML form elsewhere can't post here. */
function requireJson(req) {
	if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
		throw Object.assign(new Error("Send JSON"), { status: 415 });
	}
}

const TYPES = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml" };

async function sendFile(res, file, headers = {}) {
	return sendBody(res, 200, TYPES[path.extname(file)] ?? "application/octet-stream", await readFile(file), headers);
}

function sendBody(res, status, type, body, headers = {}) {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
	res.end(body);
}

function sendJson(res, status, value) {
	if (res.headersSent) return;
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
}

async function readJson(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Body too large"), { status: 413 });
		chunks.push(chunk);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		return typeof value === "object" && value !== null ? value : {};
	} catch {
		return {};
	}
}

/** A trimmed string of at most `max` characters, the fallback when absent, or a 400 when required. */
function text(value, max, fallback) {
	if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, max);
	if (fallback !== undefined) return fallback;
	throw Object.assign(new Error("A required text field is missing"), { status: 400 });
}

function whole(value) {
	return Number.isFinite(value) ? Math.round(value) : undefined;
}

function anchor(value) {
	if (typeof value !== "object" || value === null) return undefined;
	const fraction = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
	return {
		tag: typeof value.tag === "string" ? value.tag.slice(0, 40) : undefined,
		textQuote: typeof value.textQuote === "string" ? value.textQuote.slice(0, 120) : undefined,
		offsetX: fraction(value.offsetX),
		offsetY: fraction(value.offsetY),
	};
}

/** An app, with its version when it has more than one: "acme" or "acme (dev)". */
function describeRoute({ target, version }) {
	return target.versions.length > 1 ? `${target.name} (${version.name})` : target.name;
}

/** A design as both APIs return it: where it comes from, and what the editor may offer. */
function design({ layout, source }) {
	return { layout, source, isDefault: source !== "app", options: designOptions() };
}

function designOptions() {
	return { tools: toolbar.BUILT_IN_TOOLS, positions: toolbar.DOCK_POSITIONS, icons: toolbar.CUSTOM_ICONS };
}

/** What the page may know about an upload: not where it sits on this machine. */
function publicUpload(upload) {
	return { id: upload.id, url: upload.url, type: upload.type, kind: upload.kind, size: upload.size };
}

/** A JSON value cut down to at most `max` characters of serialized text. */
function clipJson(value, max) {
	const json = JSON.stringify(value ?? null);
	if (json.length <= max) return value;
	return { truncated: true, text: json.slice(0, max) };
}

function firstSelector(nodeId) {
	return String(nodeId ?? "").split(/(?<!\\),/)[0] || "element";
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** The folders a gateway serves, as it prints them when it starts. */
export function logFolders(gateway, port, print = console.log) {
	if (!gateway.folders) return;
	const list = gateway.folders.list();
	const runs = list.filter((folder) => folder.plan.kind === "run").length;
	print(`[gateway] ${list.length} folders in ${gateway.folders.roots.join(", ")}: ${runs} start on demand, ${list.length - runs} served as files`);
	print(`[gateway]   http://<folder>.localhost:${port}/, e.g. ${list.slice(0, 4).map((folder) => appUrl(folder.name, port)).join(" ")}`);
}

/** An app's addresses, as the gateway prints them when it starts. */
export function logApp(target, port, print = console.log) {
	const main = target.versions.find((version) => version.name === target.defaultVersion) ?? target.versions[0];
	print(`[gateway] ${appUrl(target.name, port)} → ${main.upstream.origin}${target.versions.length > 1 ? ` (${main.name})` : ""}`);
	if (target.versions.length < 2) return;
	for (const version of target.versions) {
		print(`[gateway]   ${appUrl(target.name, port, version.name)} → ${version.upstream.origin}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	// Settings may sit in .env.local beside the checkout; what the shell sets wins.
	const envFile = path.join(GATEWAY_DIR, ".env.local");
	if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);
	const { values } = parseArgs({
		options: {
			target: { type: "string", multiple: true },
			root: { type: "string", multiple: true },
			idle: { type: "string" },
			upstream: { type: "string" },
			name: { type: "string" },
			port: { type: "string" },
		},
	});
	const targets = (values.target ?? []).map(parseTargetSpec);
	if (values.upstream) targets.push({ name: values.name ?? "app", upstream: values.upstream });
	const port = Number(values.port ?? process.env.PORT ?? 4100);
	// Without --root, every folder of the XO root is an app: XO_PROJECTS_ROOT, as
	// xo-space reads it, less the folders xo-space keeps for itself there.
	const xoRoot = values.root ? null : expandHome(process.env.XO_PROJECTS_ROOT?.trim() || "~/xo-projects");
	const roots = values.root ?? [xoRoot];
	const exclude = xoRoot ? XO_SPACE_FOLDERS.map((name) => path.join(xoRoot, name)) : [];
	const dataDir = process.env.XO_GATEWAY_DATA ? path.resolve(process.env.XO_GATEWAY_DATA) : undefined;
	const gateway = createGateway({ targets, roots, exclude, dataDir, idleMinutes: Number(values.idle ?? 30) });
	gateway.server.on("error", (error) => {
		if (error.code !== "EADDRINUSE") throw error;
		console.error(`[galileo] port ${port} is taken: start it on another with PORT=${port + 1} npm start`);
		process.exit(1);
	});
	gateway.server.listen(port, "127.0.0.1", () => {
		console.log(`[galileo] home: http://localhost:${port}/`);
		console.log(`[galileo] launcher: http://localhost:${port}${LAUNCHER_PATH}`);
		for (const target of gateway.registry.list()) logApp(target, port);
		logFolders(gateway, port);
	});
	// Dev servers the gateway started stop with it.
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => gateway.close().finally(() => process.exit(0)));
	}
}

/** `~/x` as the home folder's `x`, relative paths from where galileo was started. */
function expandHome(dir) {
	return path.resolve(dir === "~" || dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(1)) : dir);
}
