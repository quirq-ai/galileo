#!/usr/bin/env node
/**
 * galileo, the XO gateway: a local reverse proxy in front of several apps that
 * carries telescope, XO's in-page bar (in telescope/), into every HTML page it
 * serves, the way Vercel's edge carries its toolbar into preview deployments.
 *
 *   localhost:4100               home: what galileo routes now, and how it works
 *   localhost:4100/launcher      the launcher: apps, versions, telescope designs
 *   acme.localhost:4100      ──▶ acme's default version
 *   dev.acme.localhost:4100  ──▶ http://localhost:5173   (acme's dev version)
 *   live.acme.localhost:4100 ──▶ https://acme.vercel.app (acme's live version)
 *   acme.localhost:4100/dev/…  ─▶ 302 to dev.acme.localhost:4100/…
 *
 * Each app and each version is reached by name, so each is its own origin and
 * they never share cookies, storage or service workers. For an app's hosts:
 *
 *   /__xo/*            answered here: telescope's files and the app's API
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
 * Apps are names for a local port or a URL, added on the command line, in the
 * launcher, or through its API, and kept in `data/targets.json`. galileo
 * starts nothing: it routes to whatever already answers there.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { XO_PREFIX, createTelescope, loaderTag, responseHeaders, shouldInject, upstreamRequestHeaders } from "../telescope/server/index.mjs";
import { appUrl, createRegistry, ownsRequest, parseTargetSpec, portOf, routeForHost, versionPick } from "./targets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = path.join(HERE, "..");
const LAUNCHER_DIR = path.join(HERE, "..", "launcher");
const HOME_DIR = path.join(HERE, "..", "home");
/** Where the launcher is on the bare host; the home page has `/`. */
const LAUNCHER_PATH = "/launcher";
/** Pages of the gateway's own: scripts and styles from this origin only. */
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'";
const MAX_BODY_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 600;

export function createGateway({
	targets = [],
	dataDir = path.join(HERE, "..", "data"),
	/** The port the gateway is reached on, when a host that mounts it listens instead of `server`. */
	port,
	/** Where people add apps, as the 404 pages name it; xo-client passes "Settings › Apps". */
	addAppsIn = "the launcher",
	/** The bare-host path the 404 pages link to for that: the launcher on its own, the host's home when mounted. */
	addAppsAt = addAppsIn === "the launcher" ? LAUNCHER_PATH : "/",
	log = (...parts) => console.log("[gateway]", ...parts),
}) {
	const registry = createRegistry({ dataDir, initial: targets });
	// telescope keeps its threads, designs, agent requests and captures beside the app list.
	const telescope = createTelescope({ dataDir, log });
	const runId = randomBytes(3).toString("hex");
	/** An app by name, as it was added on the command line, in the launcher or through its API. */
	function lookup(name) {
		return registry.get(name);
	}

	/** Every app's name, in order. */
	function appNames() {
		return registry
			.list()
			.map((target) => target.name)
			.sort();
	}

	/** Answers a request: the home page, the launcher and their API on the bare host, an app on each of its hosts. */
	function handle(req, res) {
		const route = routeForHost(req.headers.host, lookup);
		const done = (promise) => promise.catch((error) => sendJson(res, error.status ?? 500, { error: error.message }));
		if (route.kind === "launcher") return done(handleLauncher(req, res));
		if (route.kind === "unknown") return unknownApp(req, res, route.name);
		if (route.kind === "unknown-version") return unknownVersion(req, res, route);
		if (req.url.startsWith(XO_PREFIX)) return done(handleXo(req, res, route));
		// acme.localhost:4100/dev/pricing picks the dev version: dev.acme.localhost:4100/pricing.
		const pick = versionPick(req, route, portFor(req));
		if (pick) {
			res.writeHead(302, { location: pick, "cache-control": "no-store" });
			res.end();
			return;
		}
		proxy(req, res, route);
	}

	/** WebSocket upgrades: tunnelled to the version an app's host names; any other is closed. */
	function upgrade(req, socket, head) {
		const route = routeForHost(req.headers.host, lookup);
		if (route.kind !== "app" || req.url.startsWith(XO_PREFIX)) {
			socket.destroy();
			return;
		}
		tunnel(req, socket, head, route);
	}

	const server = http.createServer(handle);
	server.on("upgrade", upgrade);

	function portFor(req) {
		return portOf(req.headers.host, port ?? server.address()?.port);
	}

	// ------------------------------------------------------------------ apps

	/** Forwards a request to the version the host names, and carries telescope into pages. */
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

	/** The version is down: a page that says so, still carrying telescope, and retries by itself. */
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

	/** An app's `/__xo/*`: its health and the app list are galileo's; everything else is telescope's. */
	async function handleXo(req, res, route) {
		const { target, version } = route;
		const path = new URL(req.url, "http://gateway").pathname;

		if (req.method === "GET" && path === "/__xo/health") {
			return sendJson(res, 200, { ok: true, app: target.name, version: version.name, upstream: version.upstream?.origin ?? null });
		}
		// The navbar's switcher reads the list; changing it is left to the launcher.
		if (req.method === "GET" && path === "/__xo/api/targets") {
			guardSameOrigin(req);
			const targets = await describeTargets(req);
			return sendJson(res, 200, { current: target.name, currentVersion: version.name, manageIn: addAppsIn, manageAt: addAppsAt, targets });
		}
		const app = { name: target.name, version: version.name, upstream: version.upstream?.origin ?? null, label: describeRoute(route) };
		if (await telescope.handleApp(req, res, app)) return;
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
		// telescope's design editor and every app's design.
		const port = portFor(req);
		if (await telescope.handleGateway(req, res, { apps: appNames().map((name) => ({ name, url: appUrl(name, port) })) })) return;
		if (req.method === "GET" && route === "/__xo/health") {
			return sendJson(res, 200, { ok: true, apps: appNames() });
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
		const versionRoute = /^\/__xo\/api\/targets\/([a-z0-9-]+)\/versions\/([a-z0-9-]+)$/.exec(route);
		if (versionRoute && req.method === "DELETE") {
			const [, app, versionName] = versionRoute;
			if (!registry.removeVersion(app, versionName)) return sendJson(res, 404, { error: "No such version" });
			log(`${app}: removed version ${versionName}`);
			return sendJson(res, 200, { target: (await describeTargets(req)).find((item) => item.name === app) });
		}

		return sendJson(res, 404, { error: "Not found" });
	}

	/**
	 * Every app with its gateway address, and each of its versions with its own
	 * address and whether its server answers right now. `upstream` and `up` at
	 * the app's level are its default version's.
	 */
	async function describeTargets(req) {
		const port = portFor(req);
		return Promise.all(
			appNames().map(async (name) => {
				const target = lookup(name);
				const versions = await Promise.all(target.versions.map((version) => describeVersion(target, version, port)));
				const main = versions.find((version) => version.default) ?? versions[0];
				return {
					name: target.name,
					url: appUrl(target.name, port),
					defaultVersion: main.name,
					upstream: main.upstream,
					up: main.up,
					versions,
				};
			}),
		);
	}

	async function describeVersion(target, version, port) {
		const base = { name: version.name, url: appUrl(target.name, port, version.name), default: version.name === target.defaultVersion };
		return { ...base, upstream: version.upstream.origin, up: await probe(version.upstream) };
	}

	return {
		server,
		handle,
		upgrade,
		/** Whether a request is the gateway's when it shares a port with another app. */
		owns: (req) => ownsRequest(req.headers.host, req.url),
		/** telescope's store: threads, agent requests and designs. */
		store: telescope.store,
		registry,
		/** Nothing to stop: galileo runs no servers but its own. Kept so hosts can await it on exit. */
		async close() {},
	};
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

/** An app, with its version when it has more than one: "acme" or "acme (dev)". */
function describeRoute({ target, version }) {
	return target.versions.length > 1 ? `${target.name} (${version.name})` : target.name;
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
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
			upstream: { type: "string" },
			name: { type: "string" },
			port: { type: "string" },
		},
	});
	const targets = (values.target ?? []).map(parseTargetSpec);
	if (values.upstream) targets.push({ name: values.name ?? "app", upstream: values.upstream });
	const port = Number(values.port ?? process.env.PORT ?? 4100);
	const dataDir = process.env.XO_GATEWAY_DATA ? path.resolve(process.env.XO_GATEWAY_DATA) : undefined;
	const gateway = createGateway({ targets, dataDir });
	gateway.server.on("error", (error) => {
		if (error.code !== "EADDRINUSE") throw error;
		console.error(`[galileo] port ${port} is taken: start it on another with PORT=${port + 1} npm start`);
		process.exit(1);
	});
	gateway.server.listen(port, "127.0.0.1", () => {
		console.log(`[galileo] home: http://localhost:${port}/`);
		console.log(`[galileo] launcher: http://localhost:${port}${LAUNCHER_PATH}`);
		for (const target of gateway.registry.list()) logApp(target, port);
	});
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => gateway.close().finally(() => process.exit(0)));
	}
}
