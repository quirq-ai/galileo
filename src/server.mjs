#!/usr/bin/env node
/**
 * galileo, the inspector of a space. It keeps a list of sources (apps on
 * ports of this machine, and files or folders on it), gives each its own
 * address, and serves telescope, the bar and router that shows them one at a
 * time.
 *
 *   localhost:4100               telescope: the Sources page, and one source under the bar
 *   localhost:4100/s/acme/…      telescope showing the source acme, at a path
 *   acme.localhost:4100      ──▶ localhost:5173   (a port, proxied)
 *   notes.localhost:4100     ──▶ ~/notes          (files, read only)
 *
 * On a source's own address:
 *
 *   /__xo/bridge.js     telescope's bridge, which each HTML page loads
 *   WebSocket upgrade   tunnelled to a port (dev-server hot reload)
 *   anything else       the source: proxied to its port, or read from disk
 *
 * Only galileo may frame a source, and each HTML page gets the bridge
 * appended, which tells telescope where the page is. galileo starts nothing:
 * whatever serves a port has to be running already.
 *
 *   node src/server.mjs --source acme=5173 --source notes=~/notes --port 4100
 */
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { escapeHtml, serveFiles } from "./files.mjs";
import { BRIDGE_PATH, XO_PREFIX, bridgeTag, framePolicy, responseHeaders, shouldInject, upstreamRequestHeaders } from "./inject.mjs";
import { createSources, describeSource, galileoOrigins, parseLocation, parseSourceSpec, portOf, routeForHost, sourceUrl } from "./sources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TELESCOPE_DIR = path.join(ROOT, "telescope");
/** telescope's own files, served on galileo's host. */
const TELESCOPE_FILES = {
	"telescope.js": "text/javascript; charset=utf-8",
	"telescope.css": "text/css; charset=utf-8",
	"icon.svg": "image/svg+xml",
};
/** The routes telescope answers on galileo's host; anything else there is galileo's own. */
const TELESCOPE_ROUTE = /^\/(?:sources\/?|s\/.*)?$/;
const MAX_BODY_BYTES = 64 * 1024;

export function createGalileo({
	sources = [],
	dataDir = path.join(ROOT, "data"),
	/** The port galileo is reached on, when something other than `server` listens. */
	port,
	log = (...parts) => console.log("[galileo]", ...parts),
} = {}) {
	const registry = createSources({ dataDir, initial: sources });

	/** Answers a request: telescope and the sources API on galileo's host, a source on its own. */
	function handle(req, res) {
		const where = routeForHost(req.headers.host, registry.get);
		if (where.kind === "galileo") return handleGalileo(req, res).catch((error) => fail(res, error));
		if (where.kind === "foreign") return misdirected(res);
		// Every response on a source's address, errors included, may be framed by galileo alone.
		const done = (promise) => promise.catch((error) => fail(res, error, frameHeaders(req)));
		if (where.kind === "unknown") return unknownSource(req, res, where.name);
		if (req.url.startsWith(XO_PREFIX)) return done(handleSourceXo(req, res));
		if (where.source.type === "files") {
			return done(serveFiles(where.source, req, res, { tag: bridgeTag(), headers: frameHeaders(req), page: (content) => galileoPage(req, content) }));
		}
		proxy(req, res, where.source);
	}

	/**
	 * WebSocket upgrades: tunnelled to a port source, when they come from that
	 * source's own pages, galileo's, or no page at all; any other is refused.
	 */
	function upgrade(req, socket, head) {
		const where = routeForHost(req.headers.host, registry.get);
		if (where.kind !== "source" || where.source.type !== "port" || req.url.startsWith(XO_PREFIX)) {
			socket.destroy();
			return;
		}
		const origin = req.headers.origin;
		if (origin && origin !== `http://${req.headers.host}` && !galileoOrigins(portFor(req)).includes(origin)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		tunnel(req, socket, head, where.source);
	}

	const server = http.createServer(handle);
	server.on("upgrade", upgrade);

	function portFor(req) {
		return portOf(req.headers.host, port ?? server.address()?.port);
	}

	/** What every response of a source carries: galileo, and the source itself, may frame it. */
	function frameHeaders(req) {
		return { "content-security-policy": framePolicy(galileoOrigins(portFor(req))) };
	}

	// ------------------------------------------------------------ galileo's host

	async function handleGalileo(req, res) {
		const route = new URL(req.url, "http://galileo").pathname;
		// Node sends no body for HEAD, so a page or a file answers HEAD as it answers GET.
		const reading = req.method === "GET" || req.method === "HEAD";

		if (reading && TELESCOPE_ROUTE.test(route)) return sendTelescope(req, res);
		if (reading && route.startsWith("/__xo/telescope/")) {
			const name = route.slice("/__xo/telescope/".length);
			if (!Object.hasOwn(TELESCOPE_FILES, name)) return sendJson(res, 404, { error: "Not found" });
			return sendBody(res, 200, TELESCOPE_FILES[name], await readFile(path.join(TELESCOPE_DIR, name)));
		}
		if (reading && route === "/__xo/health") {
			return sendJson(res, 200, { ok: true, sources: registry.list().map((source) => source.name) });
		}
		if (!route.startsWith("/__xo/api/")) return sendJson(res, 404, { error: "Not found" });

		// Only telescope, on galileo's own host, may read or change the sources.
		guardSameOrigin(req);
		if (route === "/__xo/api/sources" && req.method === "GET") {
			return sendJson(res, 200, { sources: await describeAll(req) });
		}
		// Adds a source, or points a name somewhere else: { name, location }.
		if (route === "/__xo/api/sources" && req.method === "POST") {
			requireJson(req);
			const body = await readJson(req);
			const location = parseLocation(body.location, { relative: false });
			if (location.type === "port" && location.port === portFor(req)) {
				throw Object.assign(new Error(`${location.port} is galileo's own port`), { status: 400 });
			}
			const { source, isNew } = registry.add({ name: body.name, ...location });
			log(`${isNew ? "added" : "changed"} ${source.name} → ${where(source)}`);
			return sendJson(res, isNew ? 201 : 200, { source: await describeSource(source, portFor(req)) });
		}
		const one = /^\/__xo\/api\/sources\/([a-z0-9-]+)$/.exec(route);
		if (one && req.method === "DELETE") {
			if (!registry.remove(one[1])) return sendJson(res, 404, { error: "No such source" });
			log(`removed ${one[1]}`);
			return sendJson(res, 200, { ok: true });
		}
		return sendJson(res, 404, { error: "Not found" });
	}

	/** telescope's one page. It frames sources, and nothing frames it. */
	async function sendTelescope(req, res) {
		const port = portFor(req);
		const policy = [
			"default-src 'self'",
			"script-src 'self'",
			"style-src 'self'",
			"img-src 'self' data:",
			"connect-src 'self'",
			`frame-src http://*.localhost:${port}`,
			"base-uri 'none'",
			"form-action 'self'",
			"frame-ancestors 'none'",
		].join("; ");
		return sendBody(res, 200, "text/html; charset=utf-8", await readFile(path.join(TELESCOPE_DIR, "index.html")), {
			"content-security-policy": policy,
		});
	}

	async function describeAll(req) {
		return Promise.all(registry.list().map((source) => describeSource(source, portFor(req))));
	}

	// ------------------------------------------------------------ a source's host

	async function handleSourceXo(req, res) {
		const route = new URL(req.url, "http://source").pathname;
		if (req.method === "GET" && route === BRIDGE_PATH) {
			return sendBody(res, 200, "text/javascript; charset=utf-8", await readFile(path.join(TELESCOPE_DIR, "bridge.js")), frameHeaders(req));
		}
		return sendJson(res, 404, { error: "Not found" }, frameHeaders(req));
	}

	/** Forwards a request to a port source, framed by galileo alone, with the bridge appended to pages. */
	function proxy(req, res, source) {
		const upstreamHost = `localhost:${source.port}`;
		const upstreamReq = http.request(
			{ hostname: "localhost", port: source.port, method: req.method, path: req.url, headers: upstreamRequestHeaders(req.headers, upstreamHost) },
			(up) => {
				const inject = shouldInject(req, up);
				const nonce = inject ? randomBytes(16).toString("base64") : undefined;
				res.writeHead(
					up.statusCode ?? 502,
					up.statusMessage,
					responseHeaders(up.headers, {
						inject,
						nonce,
						upstreamOrigins: [`http://localhost:${source.port}`, `http://127.0.0.1:${source.port}`, `http://[::1]:${source.port}`],
						sourceOrigin: `http://${req.headers.host}`,
						frameOrigins: galileoOrigins(portFor(req)),
					}),
				);
				if (!inject) {
					up.pipe(res);
					return;
				}
				up.pipe(appendAtEnd(`\n${bridgeTag({ nonce })}\n`)).pipe(res);
			},
		);
		upstreamReq.on("error", (error) => {
			if (res.headersSent) {
				res.destroy(error);
				return;
			}
			waiting(req, res, source, error);
		});
		req.pipe(upstreamReq);
	}

	/** WebSocket upgrades (dev-server hot reload) are piped straight through to the port. */
	function tunnel(req, socket, head, source) {
		const upstreamSocket = net.connect({ host: "localhost", port: source.port });
		upstreamSocket.once("connect", () => {
			const lines = [`${req.method} ${req.url} HTTP/1.1`];
			for (let i = 0; i < req.rawHeaders.length; i += 2) {
				const name = req.rawHeaders[i];
				lines.push(`${name}: ${name.toLowerCase() === "host" ? `localhost:${source.port}` : req.rawHeaders[i + 1]}`);
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

	/** Nothing answers on the port yet: a page that says so and tries again every 2 seconds. */
	function waiting(req, res, source, error) {
		const reason = error.code ?? error.message;
		if (!acceptsHtml(req)) {
			res.writeHead(502, { ...frameHeaders(req), "content-type": "text/plain; charset=utf-8" });
			res.end(`Nothing answers on port ${source.port} for ${source.name} (${reason})\n`);
			return;
		}
		const { html, headers } = galileoPage(req, {
			title: `Waiting for ${source.name}`,
			refresh: 2,
			body:
				`<h1>Waiting for ${escapeHtml(source.name)}</h1>` +
				`<p>Nothing answers on port ${source.port} yet (${escapeHtml(reason)}). galileo starts nothing: start the app, and this page tries again every 2 seconds.</p>`,
		});
		res.writeHead(502, { ...headers, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(html);
	}

	/** A name nobody added: say so, and list the sources there are. */
	function unknownSource(req, res, name) {
		if (!acceptsHtml(req)) return sendJson(res, 404, { error: `No source called "${name}"` }, frameHeaders(req));
		const port = portFor(req);
		const links = registry
			.list()
			.map((source) => `<li><a href="http://localhost:${port}/s/${source.name}/" target="_top">${escapeHtml(source.name)}</a></li>`)
			.join("");
		const { html, headers } = galileoPage(req, {
			title: `No source called ${name}`,
			bridge: false,
			body:
				`<h1>No source called “${escapeHtml(name)}”</h1>` +
				`<p>Sources on this galileo:</p><ul>${links || "<li>none yet</li>"}</ul>` +
				`<p><a href="http://localhost:${port}/sources" target="_top">Add one on the Sources page</a></p>`,
		});
		res.writeHead(404, { ...headers, "content-type": "text/html; charset=utf-8" });
		res.end(html);
	}

	/**
	 * A page galileo makes on a source's address (a listing, a file, the
	 * waiting and missing pages): its own styles, the bridge unless told not
	 * to, and a policy that allows those and nothing else.
	 */
	function galileoPage(req, { title, body, refresh, bridge = true }) {
		const nonce = randomBytes(16).toString("base64");
		const policy = [
			"default-src 'none'",
			`script-src 'nonce-${nonce}'`,
			`style-src 'nonce-${nonce}'`,
			"img-src 'self' data:",
			"media-src 'self'",
			"frame-src 'self'",
			"base-uri 'none'",
			framePolicy(galileoOrigins(portFor(req))),
		].join("; ");
		const html =
			`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
			(refresh ? `<meta http-equiv="refresh" content="${refresh}">` : "") +
			`<title>${escapeHtml(title)}</title><style nonce="${nonce}">${PAGE_CSS}</style></head>` +
			`<body><main>${body}</main>${bridge ? bridgeTag({ nonce }) : ""}</body></html>`;
		return { html, headers: { "content-security-policy": policy } };
	}

	return {
		server,
		handle,
		upgrade,
		sources: registry,
		/** Nothing to stop but the server itself. */
		async close() {
			await new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
		},
	};
}

/** Styles for the pages galileo makes on a source's address: plain, readable, light and dark. */
const PAGE_CSS = [
	":root { --bg: #f7f8f4; --fg: #1b2016; --muted: #5f6a57; --line: #dfe4d8; --accent: #3f6e18; --code: #eef1ea; color-scheme: light; }",
	"@media (prefers-color-scheme: dark) { :root { --bg: #111410; --fg: #e8ede3; --muted: #9ca693; --line: #262c22; --accent: #83d63a; --code: #171b15; color-scheme: dark; } }",
	"* { box-sizing: border-box; }",
	"body { margin: 0; padding: 0 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }",
	"main { max-width: 980px; margin: 0 auto; padding: 24px 0 64px; }",
	"h1 { margin: 8px 0 12px; font-size: 22px; letter-spacing: -0.01em; }",
	"a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }",
	".mono, td a, .crumbs { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }",
	".crumbs { margin: 0 0 16px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }",
	"table { width: 100%; border-collapse: collapse; }",
	"th, td { padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: left; }",
	"th { color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }",
	"td a { font-size: 14px; overflow-wrap: anywhere; }",
	".n { text-align: right; white-space: nowrap; color: var(--muted); font-variant-numeric: tabular-nums; }",
	".note, .muted { color: var(--muted); } .note { font-size: 14px; margin-top: 20px; }",
	".file-head { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; margin: 0 0 12px; font-size: 13px; }",
	".file-head .mono { font-size: 14px; overflow-wrap: anywhere; }",
	".text { margin: 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--code); font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; }",
	".media img, .media video { display: block; max-width: 100%; height: auto; border-radius: 6px; }",
	".pdf { width: 100%; height: calc(100vh - 120px); border: 1px solid var(--line); border-radius: 8px; }",
].join("\n");

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

/** A host that is neither galileo's nor under `.localhost`: nothing to say to it, not even the names of the sources. */
function misdirected(res) {
	res.writeHead(421, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
	res.end("Misdirected request\n");
}

function acceptsHtml(req) {
	return String(req.headers.accept ?? "").includes("text/html");
}

/** Requests from any origin other than galileo's own are refused; tools like curl send no Sec-Fetch-Site and pass. */
function guardSameOrigin(req) {
	const site = req.headers["sec-fetch-site"];
	if (site && site !== "same-origin" && site !== "none") {
		throw Object.assign(new Error("Only galileo's own pages may use this"), { status: 403 });
	}
}

/** JSON only, so a plain HTML form elsewhere can't post here. */
function requireJson(req) {
	if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
		throw Object.assign(new Error("Send JSON"), { status: 415 });
	}
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

function sendBody(res, status, type, body, headers = {}) {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
	res.end(body);
}

function sendJson(res, status, value, headers = {}) {
	if (res.headersSent) return res.end();
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
	res.end(JSON.stringify(value));
}

function fail(res, error, headers) {
	if (res.headersSent) return res.destroy(error);
	sendJson(res, error.status ?? 500, { error: error.message }, headers);
}

/** Where a source points, as galileo reports it. */
function where(source) {
	return source.type === "port" ? `localhost:${source.port}` : source.path;
}

/** A source's address, as galileo prints it when it starts. */
export function logSource(source, port, print = console.log) {
	print(`[galileo] ${sourceUrl(source.name, port)} → ${where(source)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	// Settings may sit in .env.local beside the checkout; what the shell sets wins.
	const envFile = path.join(ROOT, ".env.local");
	if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);
	const { values } = parseArgs({ options: { source: { type: "string", multiple: true }, port: { type: "string" } } });
	let sources;
	try {
		sources = (values.source ?? []).map((spec) => parseSourceSpec(spec));
	} catch (error) {
		console.error(`[galileo] ${error.message}`);
		process.exit(1);
	}
	const port = Number(values.port ?? process.env.PORT ?? 4100);
	const dataDir = process.env.GALILEO_DATA ? path.resolve(process.env.GALILEO_DATA) : undefined;
	const galileo = createGalileo({ sources, dataDir });
	galileo.server.on("error", (error) => {
		if (error.code !== "EADDRINUSE") throw error;
		console.error(`[galileo] port ${port} is taken: start it on another with PORT=${port + 1} npm start`);
		process.exit(1);
	});
	galileo.server.listen(port, "127.0.0.1", () => {
		console.log(`[galileo] http://localhost:${port}/ telescope: the Sources page, and every source under its bar`);
		for (const source of galileo.sources.list()) logSource(source, port);
	});
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => galileo.close().finally(() => process.exit(0)));
	}
}
