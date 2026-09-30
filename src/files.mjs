/**
 * Folders with nothing to run, served as files: `index.html` when there is
 * one, else a listing to browse. Each folder gets a small server on a
 * loopback port the first time it is asked for, and the gateway proxies to
 * it like any other app, so its pages carry the toolbar too.
 *
 * Hidden files and folders (`.env`, `.git`, `.xo`) are never listed or
 * served, and nothing outside the folder is, symlinks included. Only the
 * gateway calls these servers, always as `127.0.0.1`; a request naming any
 * other host is a page that pointed its own name at this machine, and gets
 * nothing.
 */
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const TYPES = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".jsonl": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".csv": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8",
	".yml": "text/plain; charset=utf-8",
	".yaml": "text/plain; charset=utf-8",
	".toml": "text/plain; charset=utf-8",
	".py": "text/plain; charset=utf-8",
	".ts": "text/plain; charset=utf-8",
	".tsx": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

/** One lazily started file server per folder; `urlFor(dir)` resolves to its origin. */
export function createFolderFiles() {
	const servers = new Map();
	return {
		urlFor(dir) {
			if (!servers.has(dir)) {
				const server = http.createServer(serveFolder(dir));
				const ready = new Promise((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, "127.0.0.1", () => resolve(new URL(`http://127.0.0.1:${server.address().port}`)));
				});
				servers.set(dir, { server, ready });
			}
			return servers.get(dir).ready;
		},
		/** The folders served now. */
		list: () => [...servers.keys()],
		/** Stops serving one folder, one that was removed, say. */
		close(dir) {
			servers.get(dir)?.server.close();
			servers.delete(dir);
		},
		closeAll() {
			for (const { server } of servers.values()) server.close();
			servers.clear();
		},
	};
}

/** A request handler serving one folder. */
export function serveFolder(dir) {
	const rootPromise = realpath(dir);
	return async (req, res) => {
		try {
			if (!LOOPBACK.has(hostnameOf(req.headers.host))) return send(res, 421, "text/plain; charset=utf-8", "Misdirected request\n");
			if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "Only GET and HEAD\n");
			const url = new URL(req.url, "http://folder");
			let segments;
			try {
				segments = decodeURIComponent(url.pathname).split("/").filter(Boolean);
			} catch {
				return notFound(res);
			}
			if (segments.some((segment) => segment.startsWith(".") || segment.includes("\\"))) return notFound(res);
			const root = await rootPromise;
			const full = path.join(root, ...segments);
			let real;
			try {
				real = await realpath(full);
			} catch {
				return notFound(res);
			}
			if (real !== root && !real.startsWith(root + path.sep)) return notFound(res);
			const info = await stat(real);
			if (info.isDirectory()) {
				if (!url.pathname.endsWith("/")) {
					res.writeHead(301, { location: `${url.pathname}/${url.search}` });
					return res.end();
				}
				const index = path.join(real, "index.html");
				const indexInfo = await stat(index).catch(() => null);
				if (indexInfo?.isFile()) return sendFile(req, res, index, indexInfo);
				return sendListing(res, root, real, segments, req.method === "HEAD");
			}
			if (!info.isFile()) return notFound(res);
			return sendFile(req, res, real, info);
		} catch (error) {
			send(res, 500, "text/plain; charset=utf-8", `${error.message}\n`);
		}
	};
}

function sendFile(req, res, file, info) {
	res.writeHead(200, {
		"content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
		"content-length": info.size,
		"cache-control": "no-cache",
		"x-content-type-options": "nosniff",
	});
	if (req.method === "HEAD") return res.end();
	createReadStream(file).pipe(res);
}

async function sendListing(res, root, dir, segments, headOnly) {
	const entries = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const info = await stat(path.join(dir, entry.name)).catch(() => null);
		if (!info) continue;
		entries.push({ name: entry.name, folder: info.isDirectory(), size: info.size, modified: info.mtime });
	}
	entries.sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1));
	const folder = path.basename(root);
	const crumbs = [`<a href="/">${escapeHtml(folder)}</a>`];
	segments.forEach((segment, index) => {
		crumbs.push(`<a href="/${segments.slice(0, index + 1).map(encodeURIComponent).join("/")}/">${escapeHtml(segment)}</a>`);
	});
	const rows = entries
		.map((entry) => {
			const href = encodeURIComponent(entry.name) + (entry.folder ? "/" : "");
			return (
				`<tr><td><a href="${href}">${escapeHtml(entry.name)}${entry.folder ? "/" : ""}</a></td>` +
				`<td class="n">${entry.folder ? "" : size(entry.size)}</td>` +
				`<td class="n">${entry.modified.toISOString().slice(0, 16).replace("T", " ")}</td></tr>`
			);
		})
		.join("");
	const body =
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
		`<title>${escapeHtml([folder, ...segments].join("/"))}</title><style>${LISTING_CSS}</style></head><body><main>` +
		`<p class="crumbs">${crumbs.join(" / ")}</p>` +
		`<h1>${escapeHtml(segments.at(-1) ?? folder)}</h1>` +
		(entries.length
			? `<div class="wrap"><table><thead><tr><th>Name</th><th class="n">Size</th><th class="n">Modified</th></tr></thead><tbody>${rows}</tbody></table></div>`
			: `<p class="empty">This folder is empty.</p>`) +
		`<p class="hint">Served as files by the XO gateway. Hidden files are never shown.</p></main></body></html>`;
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
	res.end(headOnly ? undefined : body);
}

const LISTING_CSS = [
	":root { --bg: #f7f8f4; --fg: #1b2016; --muted: #5f6a57; --line: #dfe4d8; --accent: #3f6e18; color-scheme: light; }",
	"@media (prefers-color-scheme: dark) { :root { --bg: #111410; --fg: #e8ede3; --muted: #9ca693; --line: #262c22; --accent: #83d63a; color-scheme: dark; } }",
	"body { margin: 0; padding-inline: 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }",
	"main { max-width: 880px; margin: 0 auto; padding-block: 32px 64px; }",
	"h1 { margin: 4px 0 18px; font-size: 26px; letter-spacing: -0.01em; }",
	".crumbs { margin: 0; color: var(--muted); font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }",
	"a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }",
	".wrap { overflow-x: auto; }",
	"table { width: 100%; border-collapse: collapse; }",
	"th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; }",
	"th { color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }",
	"td a { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; overflow-wrap: anywhere; }",
	".n { text-align: right; white-space: nowrap; color: var(--muted); font-variant-numeric: tabular-nums; }",
	".empty, .hint { color: var(--muted); } .hint { margin-top: 24px; font-size: 13px; }",
].join("\n");

function size(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostnameOf(host) {
	const value = String(host ?? "").toLowerCase();
	return value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : value.split(":")[0];
}

function notFound(res) {
	send(res, 404, "text/plain; charset=utf-8", "Not found\n");
}

function send(res, status, type, body) {
	if (res.headersSent) return res.end();
	res.writeHead(status, { "content-type": type });
	res.end(body);
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
