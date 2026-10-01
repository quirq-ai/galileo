/**
 * galileo's sources: what it inspects, by name. A source is one of two kinds:
 *
 *   port   an app answering on a port of this machine     acme=5173
 *   files  a file or a folder on this machine, read only  notes=~/notes
 *
 * Every source is reached at its own address on galileo's port, so each is its
 * own origin and never shares cookies or storage with another:
 *
 *   localhost:4100          galileo itself: telescope and the sources API
 *   acme.localhost:4100     the source called acme
 *
 * Browsers resolve `*.localhost` to this machine without any DNS setup
 * (Chrome and Firefox; Safari from macOS 26). The list is kept in
 * `data/sources.json`, so sources stay across restarts.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const SOURCE_DOMAIN = "localhost";
/** galileo's own hosts: no source is ever served on them. */
export const GALILEO_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const LOCAL_PORT = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})\/?$/i;
const PROBE_TIMEOUT_MS = 600;

/** A DNS label: lowercase letters, digits and inner dashes, at most 40 characters. */
export function isValidName(name) {
	return typeof name === "string" && NAME.test(name);
}

/**
 * Where a source is: a port (`5173`, `localhost:5173` or `http://127.0.0.1:5173/`)
 * or a path (`~/notes`, `/Users/me/notes`, and on the command line `./notes`).
 * Paths from the sources API must be full, since galileo's own folder means
 * nothing to the person typing them.
 */
export function parseLocation(value, { cwd = process.cwd(), home = os.homedir(), relative = true } = {}) {
	const text = String(value ?? "").trim();
	if (!text) throw invalid("Give a port, such as 5173, or a path, such as ~/notes");
	const port = /^\d+$/.test(text) ? text : LOCAL_PORT.exec(text)?.[1];
	if (port !== undefined) {
		const number = Number(port);
		if (!Number.isInteger(number) || number < 1 || number > 65535) throw invalid(`${text} is not a port: use 1 to 65535`);
		return { type: "port", port: number };
	}
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^[^/~.][^/]*:\d+/.test(text)) {
		throw invalid(`"${text}" is not on this machine: give a port, such as 5173, or a path`);
	}
	if (text === "~" || text.startsWith("~/")) return { type: "files", path: path.join(home, text.slice(2)) };
	if (path.isAbsolute(text)) return { type: "files", path: path.normalize(text) };
	if (!relative) throw invalid(`Give a full path, such as ~/${text} or /Users/me/${text}`);
	return { type: "files", path: path.resolve(cwd, text) };
}

/** A command-line source, `name=port` or `name=path`, as the registry takes it. */
export function parseSourceSpec(spec, options) {
	const text = String(spec);
	const at = text.indexOf("=");
	if (at < 1) throw invalid(`Expected name=port or name=path, got "${text}"`);
	const name = text.slice(0, at).trim().toLowerCase();
	if (!isValidName(name)) throw invalid(nameError(name));
	return { name, ...parseLocation(text.slice(at + 1), options) };
}

/**
 * What a Host header points at: galileo's own host, a source, a name nobody
 * added under `.localhost`, or a foreign host. A name that isn't a source never
 * falls through to another. A foreign host is what a page elsewhere sees when
 * it points its own name at this machine (DNS rebinding), and gets nothing.
 */
export function routeForHost(hostHeader, lookup) {
	const hostname = hostnameOf(hostHeader);
	if (!hostname || GALILEO_HOSTS.has(hostname)) return { kind: "galileo" };
	const suffix = `.${SOURCE_DOMAIN}`;
	if (!hostname.endsWith(suffix)) return { kind: "foreign", host: hostname };
	const label = hostname.slice(0, -suffix.length);
	const source = isValidName(label) ? lookup(label) : undefined;
	return source ? { kind: "source", source } : { kind: "unknown", name: label };
}

/** A source's own address on galileo. */
export function sourceUrl(name, port) {
	return `http://${name}.${SOURCE_DOMAIN}:${port}/`;
}

/** The origins galileo itself answers on, for a port: what may frame a source. */
export function galileoOrigins(port) {
	return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

export function portOf(hostHeader, fallback) {
	const match = /:(\d+)$/.exec(String(hostHeader ?? ""));
	return match ? Number(match[1]) : fallback;
}

function hostnameOf(hostHeader) {
	const text = String(hostHeader ?? "").toLowerCase().trim();
	if (text.startsWith("[")) return text.slice(0, text.indexOf("]") + 1);
	return text.split(":")[0];
}

/**
 * The registry: sources given on the command line plus those added on the
 * Sources page, saved to `sources.json` (a temporary file, then a rename). On
 * a clash the command line wins.
 *
 *   { "sources": [{ "name": "acme", "type": "port", "port": 5173 },
 *                 { "name": "notes", "type": "files", "path": "/Users/me/notes" }] }
 */
export function createSources({ dataDir, initial = [] }) {
	mkdirSync(dataDir, { recursive: true });
	const file = path.join(dataDir, "sources.json");
	const sources = new Map();

	for (const saved of load()) {
		try {
			put(saved);
		} catch {
			// A saved source that no longer validates is dropped.
		}
	}
	for (const entry of initial) put(entry);
	save();

	function load() {
		try {
			const data = JSON.parse(readFileSync(file, "utf8"));
			return Array.isArray(data.sources) ? data.sources : [];
		} catch {
			return [];
		}
	}

	function save() {
		const temp = `${file}.tmp`;
		writeFileSync(temp, JSON.stringify({ sources: [...sources.values()] }, null, 2));
		renameSync(temp, file);
	}

	/** Adds a source, or points an existing name somewhere else. */
	function put({ name, type, port, path: where }) {
		const clean = String(name ?? "").trim().toLowerCase();
		if (!isValidName(clean)) throw invalid(nameError(clean));
		let source;
		if (type === "port" && Number.isInteger(port) && port >= 1 && port <= 65535) source = { name: clean, type, port };
		else if (type === "files" && typeof where === "string" && path.isAbsolute(where)) source = { name: clean, type, path: where };
		else throw invalid(`${clean} needs a port or a full path`);
		const isNew = !sources.has(clean);
		sources.set(clean, source);
		return { source, isNew };
	}

	return {
		get: (name) => sources.get(name),
		list: () => [...sources.values()].sort((a, b) => a.name.localeCompare(b.name)),
		add(input) {
			const result = put(input);
			save();
			return result;
		},
		remove(name) {
			const removed = sources.delete(name);
			if (removed) save();
			return removed;
		},
	};
}

/**
 * A source as the sources API shows it, with how it is right now: for a port,
 * whether anything answers there; for files, whether the path is a file, a
 * folder, or gone.
 */
export async function describeSource(source, port) {
	const base = { ...source, url: sourceUrl(source.name, port) };
	if (source.type === "port") return { ...base, up: await probe(source.port) };
	let kind = null;
	try {
		const info = statSync(source.path);
		kind = info.isDirectory() ? "folder" : info.isFile() ? "file" : null;
	} catch {
		kind = null;
	}
	return { ...base, kind, up: kind !== null };
}

/** Whether anything answers on a port of this machine, within a short timeout. */
export function probe(port) {
	return new Promise((resolve) => {
		const req = http.request({ hostname: "localhost", port, method: "HEAD", path: "/", timeout: PROBE_TIMEOUT_MS }, (res) => {
			res.resume();
			resolve(true);
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(false));
		req.end();
	});
}

function nameError(name) {
	return `"${name}" can't be a source name: use lowercase letters, digits and dashes, starting and ending with a letter or digit`;
}

function invalid(message) {
	return Object.assign(new Error(message), { status: 400 });
}
