/**
 * Dev servers for folder apps, started when they are first opened.
 *
 * A folder's server is, in order: one this runner already started, one that
 * is already listening from inside the folder (another terminal, an editor,
 * xo-client's own), or a new one. A new one runs the folder's dev command in
 * its own process group with `PORT` set to a free port, and counts as ready
 * when anything in that group answers HTTP, so a tool that ignores `PORT` is
 * found where it did listen. A server this runner started stops after
 * `idleMs` without a request, and all of them stop with the gateway. Servers
 * it merely found are never stopped.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { answers, listListeners, loopbackFor, workingDirectories } from "./processes.mjs";

const OUTPUT_LINES = 200;
const DETECT_CACHE_MS = 2000;

export function createRunner({
	idleMs = 30 * 60 * 1000,
	startTimeoutMs = 120_000,
	log = () => {},
	listeners = listListeners,
	directories = workingDirectories,
	/** The environment dev servers start from; a host passes the one it had before it loaded its own settings. */
	env = process.env,
} = {}) {
	const runs = new Map();
	let detection = { at: 0, promise: null };

	const sweep = setInterval(() => {
		const now = Date.now();
		for (const run of runs.values()) {
			if (run.state === "running" && now - run.lastUsed > idleMs) stop(run.name, "idle");
		}
	}, Math.min(60_000, Math.max(1000, idleMs / 4)));
	sweep.unref?.();

	/** Listening servers with their working directories, cached for a moment. */
	function detect() {
		if (detection.promise && Date.now() - detection.at < DETECT_CACHE_MS) return detection.promise;
		detection = {
			at: Date.now(),
			promise: (async () => {
				const found = (await listListeners_()).filter((item) => item.pid !== process.pid && !ownPids().has(item.pid));
				const cwds = await directories(found.map((item) => item.pid));
				return found.map((item) => ({ ...item, cwd: cwds.get(item.pid) }));
			})(),
		};
		return detection.promise;
	}

	function listListeners_() {
		return listeners().catch(() => []);
	}

	function ownPids() {
		return new Set([...runs.values()].flatMap((run) => (run.child?.pid ? [run.child.pid] : [])));
	}

	/**
	 * A server already listening for the folder `dir` that this runner didn't
	 * start: its origin, or null. Working directories are compared as real
	 * paths, since lsof reports /private/var for /var and the like.
	 *
	 * When the folder's command names a port, only a listener on that port
	 * (run from the folder, or from where the command runs) or one run from
	 * the folder itself counts, so a folder holding other projects never
	 * adopts their servers. Otherwise any listener from inside the folder
	 * does, except one in a nested checkout.
	 */
	async function findRunning(dir, command) {
		const places = [...new Set([dir, realPath(dir)])];
		const listening = (await detect()).filter((item) => item.cwd);
		const byPort = (a, b) => a.port - b.port;
		let candidates;
		if (command?.port) {
			const homes = new Set([...places, command.cwd, realPath(command.cwd)]);
			candidates = [
				...listening.filter((item) => item.port === command.port && (homes.has(item.cwd) || places.some((place) => belongsTo(item.cwd, place)))),
				...listening.filter((item) => places.includes(item.cwd)).sort(byPort),
			];
		} else {
			candidates = listening.filter((item) => places.some((place) => belongsTo(item.cwd, place))).sort(byPort);
		}
		for (const item of candidates) {
			const origin = `http://${loopbackFor(item.host)}:${item.port}`;
			if (await answers(origin)) return { origin, pid: item.pid, port: item.port };
		}
		return null;
	}

	/**
	 * Where a folder app is served right now, starting it when `start` is set.
	 * Resolves to { state: "running", origin, external? } | { state: "starting" | "failed" | "stopped", run? }.
	 */
	async function resolve(folder, { start = false } = {}) {
		let run = runs.get(folder.name);
		// The name now belongs to another folder (a rename, or a renumbered -2): that run isn't this app's.
		if (run && run.dir !== folder.dir) {
			stop(run.name, "moved");
			runs.delete(folder.name);
			run = undefined;
		}
		if (run?.state === "running") {
			run.lastUsed = Date.now();
			return { state: "running", origin: run.origin, run };
		}
		if (run?.state === "starting") return { state: "starting", run };
		const found = await findRunning(folder.dir, folder.plan.kind === "run" ? folder.plan.command : null);
		if (found) return { state: "running", origin: found.origin, external: true };
		if (start && folder.plan.kind === "run") return { state: "starting", run: await launch(folder) };
		if (run?.state === "failed") return { state: "failed", run };
		return { state: "stopped", run };
	}

	async function launch(folder) {
		const existing = runs.get(folder.name);
		if (existing?.state === "starting" || existing?.state === "running") return existing;
		const port = await freePort();
		const { file, args, cwd, port: preferred } = folder.plan.command;
		// A preferred port that already answers is someone else's (xo-client on :3000, say), never this run's.
		const preferredFree = preferred && !(await answersOnLoopback(preferred));
		const run = {
			name: folder.name,
			dir: folder.dir,
			command: [file, ...args].join(" "),
			cwd,
			source: folder.plan.source,
			port,
			state: "starting",
			origin: null,
			output: [],
			error: null,
			startedAt: Date.now(),
			lastUsed: Date.now(),
			child: null,
		};
		runs.set(folder.name, run);
		log(`${folder.name}: starting \`${run.command}\` in ${path.relative(process.cwd(), cwd) || "."} on :${port}`);
		let child;
		try {
			child = spawn(file, args, {
				cwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				// HOST keeps tools that honor it on this machine only; BROWSER=none stops them opening a tab.
				env: { ...childEnv(env), PORT: String(port), HOST: "127.0.0.1", BROWSER: "none", FORCE_COLOR: "0", NO_COLOR: "1" },
			});
		} catch (error) {
			return fail(run, error.message);
		}
		run.child = child;
		const collect = (chunk) => {
			for (const line of String(chunk).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/)) {
				if (line.trim()) run.output.push(line);
			}
			if (run.output.length > OUTPUT_LINES) run.output.splice(0, run.output.length - OUTPUT_LINES);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", (error) => fail(run, error.code === "ENOENT" ? `\`${file}\` isn't installed or isn't on PATH` : error.message));
		child.on("exit", (code, signal) => {
			if (run.state === "starting") fail(run, `exited before it answered (${signal ?? `code ${code}`})`);
			else if (run.state === "running") {
				run.state = "stopped";
				run.error = `exited (${signal ?? `code ${code}`})`;
				log(`${run.name}: stopped, ${run.error}`);
			}
		});
		watchUntilReady(run, preferredFree ? preferred : undefined);
		return run;
	}

	/**
	 * Ready when anything in the run's process group answers: the port it was
	 * given, its preferred one when that was free at launch, or wherever it
	 * listened.
	 */
	async function watchUntilReady(run, preferred) {
		const deadline = run.startedAt + startTimeoutMs;
		let checks = 0;
		while (run.state === "starting" && Date.now() < deadline) {
			await sleep(400);
			if (run.state !== "starting") return;
			const candidates = new Set([run.port, preferred].filter(Boolean));
			if (checks++ % 3 === 2 && run.child?.pid) {
				for (const item of await listListeners({ group: run.child.pid }).catch(() => [])) candidates.add(item.port);
			}
			for (const port of candidates) {
				for (const host of ["127.0.0.1", "[::1]"]) {
					const origin = `http://${host}:${port}`;
					if (run.state === "starting" && (await answers(origin, 400))) {
						run.state = "running";
						run.origin = origin;
						run.port = port;
						log(`${run.name}: ready at ${origin} after ${((Date.now() - run.startedAt) / 1000).toFixed(1)} s`);
						return;
					}
				}
			}
		}
		if (run.state === "starting") {
			fail(run, `didn't answer within ${Math.round(startTimeoutMs / 1000)} s`);
			kill(run);
		}
	}

	function fail(run, message) {
		if (run.state !== "starting") return run;
		run.state = "failed";
		run.error = message;
		log(`${run.name}: failed to start, ${message}`);
		return run;
	}

	function kill(run) {
		const pid = run.child?.pid;
		if (!pid || exited(run.child)) return;
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			return;
		}
		const timer = setTimeout(() => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}, 5000);
		timer.unref?.();
	}

	/** Stops a server this runner started; servers it merely found are left alone. */
	/** Stops a server this runner started. `why`: "stopped" (asked to), "idle", "removed" (its folder is gone) or "moved". */
	function stop(name, why = "stopped") {
		const run = runs.get(name);
		if (!run || (run.state !== "running" && run.state !== "starting")) return false;
		run.state = "stopped";
		run.error = STOP_REASONS[why]?.(idleMs) ?? null;
		kill(run);
		log(`${name}: stopped${why === "stopped" ? "" : `, ${STOP_REASONS[why]?.(idleMs) ?? why}`}`);
		return true;
	}

	return {
		resolve,
		start: launch,
		stop,
		/** The servers this runner has starting or running, and the folder each serves. */
		active: () =>
			[...runs.values()].filter((run) => run.state === "running" || run.state === "starting").map((run) => ({ name: run.name, dir: run.dir })),
		/** What a folder app's own server is doing, for pages and the launcher. */
		status(name) {
			const run = runs.get(name);
			if (!run) return null;
			return {
				state: run.state,
				command: run.command,
				cwd: run.cwd,
				source: run.source,
				port: run.port,
				origin: run.origin,
				pid: run.child?.pid,
				startedAt: run.startedAt,
				lastUsed: run.lastUsed,
				error: run.error,
				output: run.output.slice(-40),
			};
		},
		touch(name) {
			const run = runs.get(name);
			if (run) run.lastUsed = Date.now();
		},
		findRunning,
		/** Stops every server this runner started, and waits up to 3 s for them to exit. */
		async stopAll() {
			clearInterval(sweep);
			const children = [...runs.values()].map((run) => run.child).filter((child) => child && !exited(child));
			for (const name of runs.keys()) stop(name);
			await Promise.race([Promise.all(children.map((child) => new Promise((done) => child.once("exit", done)))), sleep(3000)]);
			for (const child of children) {
				if (exited(child)) continue;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		},
	};
}

function realPath(dir) {
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
}

function exited(child) {
	return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Whether a server running in `cwd` is the folder `place`'s: `cwd` is the
 * folder or inside it, and not inside a nested checkout (a subfolder with its
 * own `.git` or `.xo/project.json`), whose servers are that checkout's.
 */
function belongsTo(cwd, place) {
	if (cwd === place) return true;
	if (!cwd.startsWith(place + path.sep)) return false;
	let current = place;
	for (const segment of cwd.slice(place.length + 1).split(path.sep)) {
		current = path.join(current, segment);
		if (existsSync(path.join(current, ".git")) || existsSync(path.join(current, ".xo", "project.json"))) return false;
	}
	return true;
}

const STOP_REASONS = {
	idle: (idleMs) => `stopped after ${Math.round(idleMs / 60000)} idle minutes`,
	removed: () => "its folder was removed",
	moved: () => "its name moved to another folder",
};

/**
 * What a dev server inherits: the host's environment without the marks a
 * Next.js host leaves in it. Inherited, `__NEXT_PROCESSED_ENV` makes a child
 * Next.js app skip its own `.env` files and `TURBOPACK` clashes with
 * `next dev --webpack`; `NODE_ENV` and `__NEXT_PRIVATE_*` are the host's own.
 */
export function childEnv(env) {
	const out = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || key === "__NEXT_PROCESSED_ENV" || key === "TURBOPACK" || key === "NODE_ENV" || key === "NEXT_RUNTIME") continue;
		if (key.startsWith("__NEXT_PRIVATE") || key.startsWith("NEXT_PRIVATE_")) continue;
		out[key] = value;
	}
	return out;
}

async function answersOnLoopback(port) {
	return (await answers(`http://127.0.0.1:${port}`, 400)) || answers(`http://[::1]:${port}`, 400);
}

function freePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.unref();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
