/**
 * A files source, served read only on its own address. A folder serves its
 * `index.html`, or else a listing galileo makes; a single file serves that
 * file alone, at `/`.
 *
 * When telescope frames a source, every page it shows should tell telescope
 * where it is, so galileo answers a page load of anything that isn't HTML (a
 * text file, an image, a PDF) with a small page that shows it, and serves the
 * file itself to everything else, or with `?raw`.
 *
 * Nothing outside the source is served, symlinks included. Hidden names
 * (`.env`, `.git`) are never listed or served, nor is anything a link leads to
 * through one, and only GET and HEAD are answered.
 */
import { createReadStream } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const TYPES = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".wasm": "application/wasm",
};
/** Text with no type of its own is served as plain text, as is anything else that reads as text. */
const TEXT = "text/plain; charset=utf-8";
const BINARY = "application/octet-stream";
const DOCUMENT_DESTINATIONS = new Set(["document", "iframe", "frame"]);
/** The most of a text file the file page shows; past it, the page links to the file itself. */
const MAX_SHOWN_BYTES = 2 * 1024 * 1024;

/**
 * A request's path as the names it walks through, or `null` for one that
 * tries to leave the source or reach a hidden name.
 */
export function pathSegments(pathname) {
	let decoded;
	try {
		decoded = decodeURIComponent(String(pathname ?? "/"));
	} catch {
		return null;
	}
	const segments = decoded.split("/").filter(Boolean);
	if (segments.some((segment) => segment.startsWith(".") || segment.includes("\\") || segment.includes("\0"))) return null;
	return segments;
}

/**
 * Whether a real path, symlinks already followed, is inside the source and
 * reaches no hidden name on the way: a link called `env` to `.env` is as
 * hidden as `.env`.
 */
export function insideSource(root, real) {
	const relative = path.relative(root, real);
	if (path.isAbsolute(relative)) return false;
	return relative === "" || !relative.split(path.sep).some((part) => part.startsWith("."));
}

/** A path's real place and what is there, when it is inside the source; else `null`. */
async function resolveInside(root, file) {
	try {
		const real = await realpath(file);
		if (!insideSource(root, real)) return null;
		return { real, info: await stat(real) };
	} catch {
		return null;
	}
}

/** A file's type from its name; `undefined` when the name says nothing. */
export function typeOf(file) {
	return TYPES[path.extname(file).toLowerCase()];
}

/** Whether the start of a file reads as text: no NUL bytes. */
export function looksLikeText(buffer) {
	return !buffer.includes(0);
}

/**
 * Answers a request for a files source. `page` wraps galileo's own HTML for a
 * file page or a listing (its head, styles and telescope's bridge), and
 * `tag` is the bridge tag appended to the source's own HTML files.
 */
export async function serveFiles(source, req, res, { page, tag, headers = {} }) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		return send(res, 405, { ...headers, "content-type": TEXT, allow: "GET, HEAD" }, "Only GET and HEAD: files are read only\n");
	}
	const url = new URL(req.url, "http://source");
	const segments = pathSegments(url.pathname);
	if (!segments) return notFound(res, headers);
	const raw = url.searchParams.has("raw");
	const asPage = !raw && isPageLoad(req);

	let root;
	let rootInfo;
	try {
		root = await realpath(source.path);
		rootInfo = await stat(root);
	} catch {
		return send(res, 404, { ...headers, "content-type": TEXT }, `${source.path} isn't there any more\n`);
	}

	// A single file is the whole source: it answers at `/`, and nothing else does.
	if (rootInfo.isFile()) {
		if (segments.length) return notFound(res, headers);
		return sendFile(req, res, root, rootInfo, { asPage, page, tag, headers, label: path.basename(root) });
	}

	const found = await resolveInside(root, path.join(root, ...segments));
	if (!found) return notFound(res, headers);
	const { real, info } = found;

	if (info.isDirectory()) {
		if (!url.pathname.endsWith("/")) {
			return send(res, 301, { ...headers, location: `${url.pathname}/${url.search}` });
		}
		const index = await resolveInside(root, path.join(real, "index.html"));
		if (index?.info.isFile()) return sendFile(req, res, index.real, index.info, { asPage, page, tag, headers, label: "index.html" });
		return sendListing(req, res, { root, dir: real, segments, page, headers, name: source.name });
	}
	if (!info.isFile()) return notFound(res, headers);
	return sendFile(req, res, real, info, { asPage, page, tag, headers, label: segments.join("/") });
}

/** A page load, not a script, image or fetch: what telescope's frame asks for when it shows a path. */
function isPageLoad(req) {
	const destination = req.headers["sec-fetch-dest"];
	if (destination) return DOCUMENT_DESTINATIONS.has(destination);
	return String(req.headers.accept ?? "").includes("text/html");
}

async function sendFile(req, res, file, info, { asPage, page, tag, headers, label }) {
	let type = typeOf(file);
	if (!type) type = looksLikeText(await head(file)) ? TEXT : BINARY;

	// The source's own HTML, loaded as a page: the file as it is, with the bridge appended.
	if (type.startsWith("text/html") && asPage) {
		const extra = `\n${tag}\n`;
		res.writeHead(200, {
			...headers,
			"content-type": type,
			"content-length": info.size + Buffer.byteLength(extra),
			"cache-control": "no-cache",
			"x-content-type-options": "nosniff",
		});
		if (req.method === "HEAD") return res.end();
		const stream = createReadStream(file);
		stream.on("end", () => res.end(extra));
		stream.on("error", (error) => res.destroy(error));
		stream.pipe(res, { end: false });
		return;
	}

	if (asPage) return sendFilePage(req, res, file, info, { type, page, headers, label });
	return sendRaw(req, res, file, info, type, headers);
}

/** The file itself, with byte ranges so media can seek. */
function sendRaw(req, res, file, info, type, headers) {
	const base = {
		...headers,
		"content-type": type,
		"accept-ranges": "bytes",
		"cache-control": "no-cache",
		"x-content-type-options": "nosniff",
	};
	const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
	if (!range || (range[1] === "" && range[2] === "")) {
		res.writeHead(200, { ...base, "content-length": info.size });
		if (req.method === "HEAD") return res.end();
		createReadStream(file).pipe(res);
		return;
	}
	const start = range[1] === "" ? Math.max(0, info.size - Number(range[2])) : Number(range[1]);
	const end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
	if (start > end || start >= info.size) {
		res.writeHead(416, { ...headers, "content-range": `bytes */${info.size}` });
		return res.end();
	}
	res.writeHead(206, { ...base, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}` });
	if (req.method === "HEAD") return res.end();
	createReadStream(file, { start, end }).pipe(res);
}

/** A page that shows one file: text as text, media in its own element, anything else as a link to it. */
async function sendFilePage(req, res, file, info, { type, page, headers, label }) {
	const rawUrl = "?raw";
	let body;
	if (type === TEXT || type.startsWith("text/") || type.startsWith("application/json")) {
		if (info.size > MAX_SHOWN_BYTES) {
			body = `<p class="note">This file is ${size(info.size)}, too large to show here. <a href="${rawUrl}">Open it as it is</a>.</p>`;
		} else {
			const text = (await readAll(file)).toString("utf8");
			body = `<pre class="text">${escapeHtml(text)}</pre>`;
		}
	} else if (type.startsWith("image/")) {
		body = `<div class="media"><img src="${rawUrl}" alt="${escapeHtml(label)}"></div>`;
	} else if (type.startsWith("video/")) {
		body = `<div class="media"><video src="${rawUrl}" controls></video></div>`;
	} else if (type.startsWith("audio/")) {
		body = `<div class="media"><audio src="${rawUrl}" controls></audio></div>`;
	} else if (type === "application/pdf") {
		body = `<iframe class="pdf" src="${rawUrl}" title="${escapeHtml(label)}"></iframe>`;
	} else {
		body = `<p class="note">galileo can't show this kind of file. <a href="${rawUrl}" download>Download it</a>.</p>`;
	}
	const head = `<p class="file-head"><span class="mono">${escapeHtml(label)}</span><span class="muted">${size(info.size)} · ${escapeHtml(modified(info))}</span><a href="${rawUrl}">Raw</a></p>`;
	sendPage(req, res, page({ title: label, body: head + body }), headers);
}

async function sendListing(req, res, { root, dir, segments, page, headers, name }) {
	const entries = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		// A link that leads outside the source, or to a hidden name, isn't served, so it isn't listed either.
		const found = await resolveInside(root, path.join(dir, entry.name));
		if (!found) continue;
		entries.push({ name: entry.name, folder: found.info.isDirectory(), size: found.info.size, info: found.info });
	}
	entries.sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1));
	const crumbs = [`<a href="/">${escapeHtml(name)}</a>`];
	segments.forEach((segment, index) => {
		crumbs.push(`<a href="/${segments.slice(0, index + 1).map(encodeURIComponent).join("/")}/">${escapeHtml(segment)}</a>`);
	});
	const rows = entries
		.map((entry) => {
			const href = encodeURIComponent(entry.name) + (entry.folder ? "/" : "");
			return (
				`<tr><td><a href="${href}">${escapeHtml(entry.name)}${entry.folder ? "/" : ""}</a></td>` +
				`<td class="n">${entry.folder ? "" : size(entry.size)}</td>` +
				`<td class="n">${escapeHtml(modified(entry.info))}</td></tr>`
			);
		})
		.join("");
	const body =
		`<p class="crumbs mono">${crumbs.join(" / ")}</p>` +
		(entries.length
			? `<table><thead><tr><th>Name</th><th class="n">Size</th><th class="n">Modified</th></tr></thead><tbody>${rows}</tbody></table>`
			: `<p class="note">This folder is empty.</p>`) +
		`<p class="note">Hidden files are never shown, and node_modules isn't listed. ${escapeHtml(path.basename(root) || root)} is read only.</p>`;
	sendPage(req, res, page({ title: [name, ...segments].join("/"), body }), headers);
}

function sendPage(req, res, { html, headers: pageHeaders }, headers) {
	res.writeHead(200, {
		...headers,
		...pageHeaders,
		"content-type": "text/html; charset=utf-8",
		"content-length": Buffer.byteLength(html),
		"cache-control": "no-cache",
		"x-content-type-options": "nosniff",
	});
	res.end(req.method === "HEAD" ? undefined : html);
}

/** The first few kilobytes of a file, to tell text from binary. */
async function head(file) {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function readAll(file) {
	const chunks = [];
	for await (const chunk of createReadStream(file)) chunks.push(chunk);
	return Buffer.concat(chunks);
}

function size(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function modified(info) {
	return info.mtime.toISOString().slice(0, 16).replace("T", " ");
}

function notFound(res, headers) {
	send(res, 404, { ...headers, "content-type": TEXT }, "Not found\n");
}

function send(res, status, headers, body) {
	if (res.headersSent) return res.end();
	res.writeHead(status, headers);
	res.end(body);
}

export function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
