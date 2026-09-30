/**
 * Folders as apps. Every folder in a root gets `<name>.localhost:4100` without
 * being registered, named after the folder. How a folder is served:
 *
 *   run    it has a dev command: its own `.claude/launch.json`, an entry in
 *          the root's `.claude/launch.json` that points at it, or a
 *          `package.json` `dev` (else `start`) script. The runner starts it
 *          on a free port the first time it is opened.
 *   files  anything else: its files, with `index.html` or a folder listing.
 *
 * A root given as `{ dir, projectsOnly: true }` is a projects root: only its
 * xo-projects (folders with `.xo/project.json`) become apps.
 *
 * Hidden folders, `node_modules` and the folders in `exclude` (the gateway's
 * own checkout) are skipped. Folders come and go: the root is watched, and a
 * name nobody knows makes the lookup scan again.
 */
import { existsSync, readFileSync, readdirSync, watch } from "node:fs";
import path from "node:path";

import { isValidName } from "./targets.mjs";

/** A folder's name as a DNS label: `Quirq Backgrounds` → `quirq-backgrounds`; `null` when nothing is left. */
export function folderName(dirName) {
	const name = String(dirName)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return isValidName(name) ? name : null;
}

/**
 * How one folder is served. `launchConfigs` are the root's `.claude/launch.json`
 * configurations, which run from the root and name the folder in their arguments.
 */
export function servePlan(dir, root, launchConfigs = []) {
	const own = readLaunchConfigs(dir).find(runsInside);
	if (own) return runPlan(own, dir, `${path.basename(dir)}/.claude/launch.json: ${own.name}`);

	const folder = path.basename(dir);
	const shared = launchConfigs.find((config) => launchTarget(config) === folder);
	if (shared) return runPlan(shared, root, `.claude/launch.json: ${shared.name}`);

	const scripts = readJson(path.join(dir, "package.json"))?.scripts ?? {};
	for (const script of ["dev", "start"]) {
		if (typeof scripts[script] === "string" && scripts[script].trim()) {
			const manager = packageManager(dir);
			return {
				kind: "run",
				command: { file: manager, args: ["run", script], cwd: dir },
				source: `package.json: ${script} (${scripts[script].trim().slice(0, 80)})`,
			};
		}
	}
	return { kind: "files", source: existsSync(path.join(dir, "index.html")) ? "index.html" : "folder listing" };
}

function runPlan(config, cwd, source) {
	const args = Array.isArray(config.runtimeArgs) ? config.runtimeArgs.map(String) : [];
	return {
		kind: "run",
		command: { file: String(config.runtimeExecutable), args, cwd, port: Number(config.port) || undefined },
		source,
	};
}

/** Which folder a root launch configuration runs: `--prefix web`, `--dir web`, `--directory web`, `-C web` or `web/server.mjs`. */
export function launchTarget(config) {
	const args = Array.isArray(config?.runtimeArgs) ? config.runtimeArgs.map(String) : [];
	for (let i = 0; i < args.length - 1; i++) {
		if (["--prefix", "--dir", "--directory", "-C", "--cwd"].includes(args[i])) return firstSegment(args[i + 1]);
	}
	for (const arg of args) {
		// A shell line: `sh -c "cd web && pnpm dev"`.
		const cd = /(?:^|[\s;&|])cd\s+(["']?)([^\s"';&|]+)\1/.exec(arg);
		if (cd) return firstSegment(cd[2]);
	}
	for (const arg of args) {
		if (!arg.startsWith("-") && arg.includes("/") && !/\s/.test(arg)) return firstSegment(arg);
	}
	return null;
}

/**
 * Whether a folder's own launch configuration runs that folder, not a
 * neighbour it reaches through `..` or an absolute `cd` (xo-swarm's runs the
 * PR checkout next door, for one).
 */
function runsInside(config) {
	const args = Array.isArray(config.runtimeArgs) ? config.runtimeArgs.map(String) : [];
	return !args.some((arg) => /(?:^|[\s"'=/])\.\.(?:[\s"'/]|$)/.test(arg) || /(?:^|[\s;&|])cd\s+["']?\//.test(arg));
}

function firstSegment(value) {
	const segment = String(value).replace(/^\.\//, "").split("/")[0];
	return segment && segment !== "." && segment !== ".." ? segment : null;
}

function readLaunchConfigs(dir) {
	const configs = readJson(path.join(dir, ".claude", "launch.json"))?.configurations;
	return Array.isArray(configs) ? configs.filter((config) => config && typeof config.runtimeExecutable === "string") : [];
}

function packageManager(dir) {
	if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
	if (existsSync(path.join(dir, "bun.lock")) || existsSync(path.join(dir, "bun.lockb"))) return "bun";
	return "npm";
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** A root as given: a folder's path, or `{ dir, projectsOnly }`. */
function rootEntry(root) {
	return typeof root === "string"
		? { dir: path.resolve(root), projectsOnly: false }
		: { dir: path.resolve(root.dir), projectsOnly: Boolean(root.projectsOnly) };
}

/**
 * Every servable folder in the roots, by name, in root order. Within a root a
 * folder already named like an address keeps that name, and the others are
 * named after theirs; a name taken already gets `-2`, `-3`, so an earlier
 * root's folder keeps a name over a later root's. `onSkip` hears of folders
 * whose name gives no address at all.
 */
export function scanRoots(roots, { exclude = [], onSkip = () => {} } = {}) {
	const skip = new Set(exclude.map((dir) => path.resolve(dir)));
	const found = new Map();
	const taken = new Set();
	for (const { dir: root, projectsOnly } of roots.map(rootEntry)) {
		const launchConfigs = readLaunchConfigs(root);
		let entries;
		try {
			entries = readdirSync(root, { withFileTypes: true });
		} catch {
			continue;
		}
		const candidates = [];
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const dir = path.join(root, entry.name);
			if (skip.has(dir)) continue;
			const project = readJson(path.join(dir, ".xo", "project.json"));
			// A projects root makes apps of its xo-projects only.
			if (projectsOnly && !project) continue;
			const base = folderName(entry.name);
			if (!base) {
				onSkip(dir);
				continue;
			}
			candidates.push({ base, exact: base === entry.name, dir, project, name: null });
		}
		// Two passes: `git-and-its-history` keeps its name beside `git and its history`.
		for (const exact of [true, false]) {
			for (const item of candidates) {
				if (item.exact !== exact) continue;
				let name = item.base;
				for (let n = 2; taken.has(name); n += 1) name = `${item.base.slice(0, 37)}-${n}`;
				taken.add(name);
				item.name = name;
			}
		}
		for (const item of candidates) {
			found.set(item.name, {
				name: item.name,
				dir: item.dir,
				root,
				plan: servePlan(item.dir, root, launchConfigs),
				xoProject: projectInfo(item.project),
			});
		}
	}
	return found;
}

/** What a folder's `.xo/project.json` says about it: its name and id, and how it is shown. */
function projectInfo(project) {
	if (!project || typeof project !== "object") return undefined;
	const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
	const info = {
		name: typeof project.name === "string" ? project.name : undefined,
		pid: typeof project.pid === "string" ? project.pid : undefined,
		displayName: text(project.display_name, 80),
		description: text(project.description, 280),
	};
	return info.name || info.displayName || info.description ? info : undefined;
}

/**
 * The roots, kept current: rescanned when a root changes (debounced), every
 * `intervalMs` as a fallback, and whenever a lookup misses. `onChange` hears
 * the new folders whenever a scan finds one added, removed or moved. A root
 * that doesn't exist yet is watched as soon as it does.
 */
export function createDiscovery({ roots = [], exclude = [], intervalMs = 10_000, log = () => {}, onChange = () => {} } = {}) {
	const dirs = roots.map((root) => rootEntry(root).dir);
	const unnamed = new Set();
	const scan = () =>
		scanRoots(roots, {
			exclude,
			onSkip(dir) {
				if (unnamed.has(dir)) return;
				unnamed.add(dir);
				log(`folders: skipped ${dir}, its name has no letters or digits to make an address of`);
			},
		});
	let folders = scan();
	let signature = signatureOf(folders);
	let scannedAt = Date.now();
	let debounce = null;
	let closed = false;
	const watchers = new Map();

	function refresh() {
		scannedAt = Date.now();
		folders = scan();
		const next = signatureOf(folders);
		if (next !== signature) {
			signature = next;
			log(`folders: ${folders.size} (${[...folders.keys()].join(",")})`);
			try {
				onChange(folders);
			} catch (error) {
				log(`folders: a change listener failed: ${error.message}`);
			}
		}
		watchRoots();
		return folders;
	}

	/** Watches each root that exists; one that is missing is watched again once it is back. */
	function watchRoots() {
		if (closed) return;
		for (const root of dirs) {
			if (!existsSync(root)) {
				watchers.get(root)?.close();
				watchers.delete(root);
				continue;
			}
			if (watchers.has(root)) continue;
			try {
				const watcher = watch(root, () => {
					clearTimeout(debounce);
					debounce = setTimeout(refresh, 300);
				});
				watcher.on("error", () => {
					watcher.close();
					watchers.delete(root);
				});
				watchers.set(root, watcher);
			} catch {
				// A root that can't be watched is still rescanned on the interval.
			}
		}
	}

	watchRoots();
	const timer = roots.length ? setInterval(refresh, intervalMs) : null;
	timer?.unref?.();

	return {
		roots: dirs,
		/** A folder by name; a miss scans again, at most every 2 seconds, so a new folder answers at once. */
		get(name) {
			const hit = folders.get(name);
			if (hit || Date.now() - scannedAt < 2000) return hit;
			return refresh().get(name);
		},
		list: () => [...folders.values()],
		refresh,
		close() {
			closed = true;
			clearTimeout(debounce);
			if (timer) clearInterval(timer);
			for (const watcher of watchers.values()) watcher.close();
			watchers.clear();
		},
	};
}

/** Which folders there are and where: what a change is. */
function signatureOf(folders) {
	return [...folders.values()].map((folder) => `${folder.name}=${folder.dir}`).join("\n");
}
