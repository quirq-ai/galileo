/**
 * The apps a gateway fronts, their versions, and which one a request is for.
 *
 * Every app gets its own hostname on the gateway's port, and every version of
 * an app its own hostname under that:
 *
 *   acme.localhost:4100        acme's default version
 *   dev.acme.localhost:4100    acme's dev version
 *   live.acme.localhost:4100   acme's live version
 *
 * Each is its own origin, so apps and versions never share cookies, storage,
 * service workers or cache, and everything a page loads (links, assets, API
 * calls, redirects, hot-reload sockets) stays on the version it came from.
 * Browsers resolve `*.localhost` to this machine without any DNS setup
 * (Chrome and Firefox; Safari from macOS 26).
 *
 * On an app's own host, a page address that starts with a version's name picks
 * that version: `acme.localhost:4100/dev/pricing` goes to
 * `dev.acme.localhost:4100/pricing` (see `versionPick`).
 *
 * The bare host, `localhost:4100`, is galileo's own: its home page and the launcher. No app
 * code ever runs there, which is why it is the only place allowed to add or
 * remove apps and versions.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { XO_PREFIX } from "./inject.mjs";

export const APP_DOMAIN = "localhost";
/** The version an app gets when none is named. */
export const DEFAULT_VERSION = "main";

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const LAUNCHER_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A DNS label: lowercase letters, digits and inner dashes, at most 40 characters. */
export function isValidName(name) {
	return typeof name === "string" && NAME.test(name);
}

/** A port (`3000`), a host and port (`localhost:3000`) or an http(s) URL, as an origin. */
export function normalizeUpstream(value) {
	const text = String(value ?? "").trim();
	let candidate = text;
	if (/^\d{1,5}$/.test(text)) candidate = `http://localhost:${text}`;
	// A value with its own scheme keeps it, so `ftp://…` is refused below rather than read as a host called "ftp".
	else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) candidate = `http://${text}`;
	let url;
	try {
		url = new URL(candidate);
	} catch {
		throw invalid(`"${text}" is not a port or an http(s) address`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid(`"${text}" is not an http(s) address`);
	return url.origin;
}

/**
 * A command-line spec. The left side reads like the address it creates:
 * `acme=4173`, `dev.acme=5173`, `live.acme=https://acme.vercel.app`.
 */
export function parseTargetSpec(spec) {
	const text = String(spec);
	const at = text.indexOf("=");
	if (at < 1) throw invalid(`Expected name=port, name=url or version.name=url, got "${text}"`);
	const labels = text.slice(0, at).trim().toLowerCase().split(".");
	if (labels.length > 2) throw invalid(`"${text.slice(0, at)}" has too many parts: use name or version.name`);
	const name = labels[labels.length - 1];
	if (!isValidName(name)) throw invalid(nameError(name));
	const parsed = { name, upstream: normalizeUpstream(text.slice(at + 1)) };
	if (labels.length === 2) {
		if (!isValidName(labels[0])) throw invalid(versionError(labels[0]));
		parsed.version = labels[0];
	}
	return parsed;
}

/**
 * What a Host header points at: galileo's own pages, a version of a registered app
 * (its default version on the app's own host), or a name nobody registered.
 * A name that isn't registered never falls through to another app or version.
 */
export function routeForHost(hostHeader, lookup) {
	const hostname = hostnameOf(hostHeader);
	if (!hostname || LAUNCHER_HOSTS.has(hostname)) return { kind: "launcher" };
	const suffix = `.${APP_DOMAIN}`;
	if (!hostname.endsWith(suffix)) return { kind: "unknown", name: hostname };
	const labels = hostname.slice(0, -suffix.length).split(".");
	if (labels.length > 2 || !labels.every(isValidName)) return { kind: "unknown", name: labels.join(".") };
	const target = lookup(labels[labels.length - 1]);
	if (!target) return { kind: "unknown", name: labels[labels.length - 1] };
	if (labels.length === 1) return { kind: "app", target, version: defaultVersionOf(target), versionHost: false };
	const version = target.versions.find((item) => item.name === labels[0]);
	return version ? { kind: "app", target, version, versionHost: true } : { kind: "unknown-version", target, name: labels[0] };
}

/**
 * Whether a request is the gateway's when the gateway shares its port with
 * another app, as it does inside xo-client: every `*.localhost` host (apps,
 * versions, and names nobody registered, which get the gateway's own 404), and
 * `/__xo/*` on the bare host (the launcher's API and the toolbar's files).
 * Everything else on the bare host, and any other hostname, is the other app's.
 */
export function ownsRequest(hostHeader, url) {
	const hostname = hostnameOf(hostHeader);
	if (hostname.endsWith(`.${APP_DOMAIN}`)) return true;
	return LAUNCHER_HOSTS.has(hostname) && String(url ?? "").startsWith(XO_PREFIX);
}

/**
 * On an app's own host, a page (not a fetch) whose address starts with one of
 * the app's version names: where that version shows the rest of the address.
 * Version hosts are never rewritten, so an app's own `/dev` page stays
 * reachable there.
 */
export function versionPick({ method, url, headers }, route, port) {
	if (route.kind !== "app" || route.versionHost) return null;
	if (method !== "GET" && method !== "HEAD") return null;
	const mode = headers["sec-fetch-mode"];
	if (mode ? mode !== "navigate" : !String(headers.accept ?? "").includes("text/html")) return null;
	const parsed = new URL(url, "http://gateway");
	const [, first, ...rest] = parsed.pathname.split("/");
	const version = route.target.versions.find((item) => item.name === first);
	if (!version) return null;
	return `${appUrl(route.target.name, port, version.name)}${rest.join("/")}${parsed.search}`;
}

/** The address an app, or one of its versions, is reached at through the gateway. */
export function appUrl(name, port, version) {
	return `http://${version ? `${version}.` : ""}${name}.${APP_DOMAIN}:${port}/`;
}

export function portOf(hostHeader, fallback) {
	const match = /:(\d+)$/.exec(String(hostHeader ?? ""));
	return match ? Number(match[1]) : fallback;
}

export function defaultVersionOf(target) {
	return target.versions.find((version) => version.name === target.defaultVersion) ?? target.versions[0];
}

function hostnameOf(hostHeader) {
	const text = String(hostHeader ?? "").toLowerCase().trim();
	if (text.startsWith("[")) return text.slice(0, text.indexOf("]") + 1);
	return text.split(":")[0];
}

/**
 * The registry: apps and versions given on the command line plus those added
 * from the launcher, saved to `targets.json` so additions survive a restart.
 * On a clash, the command line wins; a default chosen in the launcher is kept.
 *
 *   { "name": "acme", "defaultVersion": "dev",
 *     "versions": [{ "name": "dev", "upstream": "http://localhost:5173" },
 *                  { "name": "live", "upstream": "https://acme.vercel.app" }] }
 */
export function createRegistry({ dataDir, initial = [] }) {
	mkdirSync(dataDir, { recursive: true });
	const file = path.join(dataDir, "targets.json");
	const targets = new Map();

	for (const saved of load()) {
		try {
			restore(saved);
		} catch {
			// A saved entry that no longer validates is dropped.
		}
	}
	for (const entry of initial) put(entry);
	save();

	function load() {
		try {
			const data = JSON.parse(readFileSync(file, "utf8"));
			return Array.isArray(data.targets) ? data.targets : [];
		} catch {
			return [];
		}
	}

	/** A saved app; the single-upstream shape of earlier versions becomes one "main" version. */
	function restore(saved) {
		const versions = Array.isArray(saved.versions) ? saved.versions : [{ name: DEFAULT_VERSION, upstream: saved.upstream }];
		for (const version of versions) put({ name: saved.name, version: version.name, upstream: version.upstream });
		const target = targets.get(cleanName(saved.name));
		if (target && target.versions.some((version) => version.name === saved.defaultVersion)) target.defaultVersion = saved.defaultVersion;
	}

	function save() {
		const temp = `${file}.tmp`;
		const out = [...targets.values()].map((target) => ({
			name: target.name,
			defaultVersion: target.defaultVersion,
			versions: target.versions.map((version) => ({ name: version.name, upstream: version.upstream.origin })),
		}));
		writeFileSync(temp, JSON.stringify({ targets: out }, null, 2));
		renameSync(temp, file);
	}

	/**
	 * Adds an app, or a version to an app, or points a version somewhere else.
	 * Without a version name, a new app gets "main" and an existing app's
	 * default version is updated.
	 */
	function put({ name, version, upstream, makeDefault = false }) {
		const appName = cleanName(name);
		if (!isValidName(appName)) throw invalid(nameError(appName));
		const origin = new URL(normalizeUpstream(upstream));
		let target = targets.get(appName);
		const versionName = version === undefined || version === null || String(version).trim() === ""
			? (target ? target.defaultVersion : DEFAULT_VERSION)
			: cleanName(version);
		if (!isValidName(versionName)) throw invalid(versionError(versionName));
		if (!target) {
			target = { name: appName, defaultVersion: versionName, versions: [] };
			targets.set(appName, target);
		}
		const existing = target.versions.find((item) => item.name === versionName);
		if (existing) existing.upstream = origin;
		else target.versions.push({ name: versionName, upstream: origin });
		if (makeDefault) target.defaultVersion = versionName;
		return { target, version: target.versions.find((item) => item.name === versionName), isNew: !existing };
	}

	return {
		get: (name) => targets.get(name),
		list: () => [...targets.values()].sort((a, b) => a.name.localeCompare(b.name)),
		add(input) {
			const result = put(input);
			save();
			return result;
		},
		/** Makes a version the one the app's own host serves. */
		setDefault(name, version) {
			const target = targets.get(name);
			if (!target || !target.versions.some((item) => item.name === version)) return false;
			target.defaultVersion = version;
			save();
			return true;
		},
		remove(name) {
			const removed = targets.delete(name);
			if (removed) save();
			return removed;
		},
		/** Removes one version; an app keeps at least one, and loses its default only to the next one. */
		removeVersion(name, version) {
			const target = targets.get(name);
			if (!target || !target.versions.some((item) => item.name === version)) return false;
			if (target.versions.length === 1) throw invalid(`${name} needs at least one version: remove the app instead`);
			target.versions = target.versions.filter((item) => item.name !== version);
			if (target.defaultVersion === version) target.defaultVersion = target.versions[0].name;
			save();
			return true;
		},
	};
}

function cleanName(value) {
	return String(value ?? "").trim().toLowerCase();
}

function nameError(name) {
	return `"${name}" can't be an app name: use lowercase letters, digits and dashes, starting and ending with a letter or digit`;
}

function versionError(name) {
	return `"${name}" can't be a version name: use lowercase letters, digits and dashes, starting and ending with a letter or digit`;
}

function invalid(message) {
	return Object.assign(new Error(message), { status: 400 });
}
