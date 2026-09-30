/**
 * Folders as apps: naming and how each folder is served, files and what they
 * never show, dev servers started on demand and stopped, and the gateway end
 * to end, including who may start a server. Real folders and real processes.
 * `npm test`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { folderName, launchTarget, scanRoots, servePlan } from "../src/discover.mjs";
import { serveFolder } from "../src/files.mjs";
import { childEnv, createRunner } from "../src/runner.mjs";
import { createGateway, mayStart } from "../src/server.mjs";

/** A tiny dev server: answers every request with its name, on PORT (or on FIXED_PORT, ignoring PORT). */
const SERVER = `
const http = require("node:http");
const port = Number(process.env.FIXED_PORT || process.env.PORT);
http.createServer((req, res) => {
	res.writeHead(200, { "content-type": req.url === "/data" ? "application/json" : "text/html" });
	res.end(req.url === "/data" ? JSON.stringify({ app: process.env.APP_NAME, host: req.headers.host }) : "<!doctype html><title>" + process.env.APP_NAME + "</title><h1>" + process.env.APP_NAME + " dev</h1>");
}).listen(port, "127.0.0.1", () => console.log("ready on " + port));
`;

function project(root, name, { script = "node server.cjs", files = {}, env } = {}) {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "server.cjs"), SERVER);
	const dev = env ? `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join(" ")} ${script}` : script;
	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { dev } }));
	for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
	return dir;
}

function freePort() {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A dev server that shows the environment it was started with. */
const ENV_SERVER = `
const http = require("node:http");
const keys = ["__NEXT_PROCESSED_ENV", "TURBOPACK", "NODE_ENV", "__NEXT_PRIVATE_ORIGIN", "KEEP_ME", "PORT", "HOST"];
http.createServer((req, res) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))));
}).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
`;

async function until(check, ms = 20000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await check();
		if (value) return value;
		await sleep(150);
	}
	throw new Error("timed out");
}

describe("naming and serving folders", () => {
	let root;
	before(() => {
		root = mkdtempSync(path.join(tmpdir(), "xo-folders-"));
		project(root, "web", { files: { "pnpm-lock.yaml": "" } });
		mkdirSync(path.join(root, "site"));
		writeFileSync(path.join(root, "site", "index.html"), "<h1>site</h1>");
		mkdirSync(path.join(root, "docs"));
		mkdirSync(path.join(root, "My Notes_2026"));
		mkdirSync(path.join(root, ".hidden"));
		mkdirSync(path.join(root, "node_modules"));
		mkdirSync(path.join(root, "gateway"));
		mkdirSync(path.join(root, "space-drift", ".xo"), { recursive: true });
		writeFileSync(path.join(root, "space-drift", ".xo", "project.json"), JSON.stringify({ name: "data-drift", pid: "p1" }));
		mkdirSync(path.join(root, ".claude"));
		writeFileSync(path.join(root, ".claude", "launch.json"), JSON.stringify({
			configurations: [{ name: "docs", runtimeExecutable: "python3", runtimeArgs: ["-m", "http.server", "8461", "--directory", "docs"], port: 8461 }],
		}));
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	test("a folder's name becomes a DNS label", () => {
		assert.equal(folderName("web"), "web");
		assert.equal(folderName("My Notes_2026"), "my-notes-2026");
		assert.equal(folderName("xo-swarm-pr-131"), "xo-swarm-pr-131");
		assert.equal(folderName("___"), null);
		assert.equal(folderName("x".repeat(60)).length, 40);
	});

	test("launch configurations name the folder they run", () => {
		assert.equal(launchTarget({ runtimeArgs: ["--prefix", "xo-client", "run", "dev"] }), "xo-client");
		assert.equal(launchTarget({ runtimeArgs: ["--dir", "web", "dev"] }), "web");
		assert.equal(launchTarget({ runtimeArgs: ["xo-gateway/demo.mjs"] }), "xo-gateway");
		assert.equal(launchTarget({ runtimeArgs: ["run", "dev"] }), null);
		assert.equal(launchTarget({ runtimeArgs: ["-c", "cd web && pnpm dev"] }), "web");
		assert.equal(launchTarget({ runtimeArgs: ["-c", "cd ../xo-swarm-pr-131 && next dev -p 3001"] }), null);
	});

	test("every visible folder is an app: its own dev command, a root launch entry, or its files", () => {
		const found = scanRoots([root], { exclude: [path.join(root, "gateway")] });
		assert.deepEqual([...found.keys()], ["docs", "my-notes-2026", "site", "space-drift", "web"]);
		assert.deepEqual(found.get("web").plan.command, { file: "pnpm", args: ["run", "dev"], cwd: path.join(root, "web") });
		assert.equal(found.get("docs").plan.kind, "run", "the root's launch.json runs it");
		assert.equal(found.get("docs").plan.command.cwd, root);
		assert.equal(found.get("site").plan.source, "index.html");
		assert.equal(found.get("my-notes-2026").plan.kind, "files");
		assert.equal(found.get("space-drift").xoProject.name, "data-drift");
	});

	test("a projects root makes apps of its xo-projects only, beside a root of every folder", () => {
		const exclude = [path.join(root, "gateway")];
		const projects = scanRoots([{ dir: root, projectsOnly: true }], { exclude });
		assert.deepEqual([...projects.keys()], ["space-drift"]);
		assert.equal(projects.get("space-drift").xoProject.name, "data-drift");
		const second = mkdtempSync(path.join(tmpdir(), "xo-folders-p-"));
		try {
			mkdirSync(path.join(second, "notes"));
			const both = scanRoots([{ dir: root, projectsOnly: true }, second], { exclude });
			assert.deepEqual([...both.keys()], ["space-drift", "notes"]);
		} finally {
			rmSync(second, { recursive: true, force: true });
		}
	});

	test("the same name in a second root gets a number", () => {
		const second = mkdtempSync(path.join(tmpdir(), "xo-folders-b-"));
		try {
			mkdirSync(path.join(second, "web"));
			const found = scanRoots([root, second]);
			assert.equal(found.get("web").dir, path.join(root, "web"));
			assert.equal(found.get("web-2").dir, path.join(second, "web"));
		} finally {
			rmSync(second, { recursive: true, force: true });
		}
	});

	test("a folder already named like an address keeps it; a folder named after it gets a number", () => {
		const own = mkdtempSync(path.join(tmpdir(), "xo-folders-n-"));
		try {
			mkdirSync(path.join(own, "git and its history"));
			mkdirSync(path.join(own, "git-and-its-history"));
			const found = scanRoots([own]);
			assert.equal(found.get("git-and-its-history").dir, path.join(own, "git-and-its-history"));
			assert.equal(found.get("git-and-its-history-2").dir, path.join(own, "git and its history"));
			assert.deepEqual([...found.keys()], ["git-and-its-history-2", "git-and-its-history"], "still in folder order");
		} finally {
			rmSync(own, { recursive: true, force: true });
		}
	});

	test("an xo-project's display name and description come from its .xo/project.json", () => {
		const own = mkdtempSync(path.join(tmpdir(), "xo-folders-d-"));
		try {
			mkdirSync(path.join(own, "acme", ".xo"), { recursive: true });
			writeFileSync(path.join(own, "acme", ".xo", "project.json"), JSON.stringify({
				schema: 1, pid: "p-acme", name: "old-name", display_name: "  Acme Notes ", description: "Notes for the Acme team",
			}));
			mkdirSync(path.join(own, "plain"));
			const found = scanRoots([own]);
			assert.deepEqual(found.get("acme").xoProject, { name: "old-name", pid: "p-acme", displayName: "Acme Notes", description: "Notes for the Acme team" });
			assert.equal(found.get("plain").xoProject, undefined);
		} finally {
			rmSync(own, { recursive: true, force: true });
		}
	});

	test("a dev server's environment leaves out what a Next.js host set for itself", () => {
		assert.deepEqual(childEnv({
			__NEXT_PROCESSED_ENV: "true", TURBOPACK: "auto", NODE_ENV: "production", NEXT_RUNTIME: "nodejs",
			__NEXT_PRIVATE_ORIGIN: "http://localhost:3000", NEXT_PRIVATE_WORKER: "1", NEXT_TELEMETRY_DISABLED: "1", KEEP_ME: "yes",
		}), { NEXT_TELEMETRY_DISABLED: "1", KEEP_ME: "yes" });
	});

	test("a folder's own launch.json wins over its package.json", () => {
		const dir = project(root, "own-launch");
		mkdirSync(path.join(dir, ".claude"));
		writeFileSync(path.join(dir, ".claude", "launch.json"), JSON.stringify({ configurations: [{ name: "app", runtimeExecutable: "node", runtimeArgs: ["server.cjs"], port: 5000 }] }));
		assert.deepEqual(servePlan(dir, root).command, { file: "node", args: ["server.cjs"], cwd: dir, port: 5000 });
	});

	test("a folder's own launch entry that runs a neighbour is skipped", () => {
		const dir = project(root, "swarm");
		mkdirSync(path.join(dir, ".claude"));
		writeFileSync(path.join(dir, ".claude", "launch.json"), JSON.stringify({
			configurations: [
				{ name: "pr-131", runtimeExecutable: "sh", runtimeArgs: ["-c", "cd ../swarm-pr-131 && next dev -p 3001"], port: 3001 },
				{ name: "vault", runtimeExecutable: "sh", runtimeArgs: ["-c", "cd /elsewhere/server && next dev"], port: 3100 },
			],
		}));
		const plan = servePlan(dir, root);
		assert.equal(plan.source, "package.json: dev (node server.cjs)");
		assert.equal(plan.command.cwd, dir);
	});
});

describe("serving a folder as files", () => {
	let dir;
	let outside;
	let server;
	let base;
	before(async () => {
		dir = mkdtempSync(path.join(tmpdir(), "xo-files-"));
		outside = mkdtempSync(path.join(tmpdir(), "xo-outside-"));
		mkdirSync(path.join(dir, "reports"));
		writeFileSync(path.join(dir, "reports", "q3.md"), "# Q3\n");
		writeFileSync(path.join(dir, "reports", "chart.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
		writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
		mkdirSync(path.join(dir, ".git"));
		writeFileSync(path.join(dir, ".git", "config"), "[core]\n");
		writeFileSync(path.join(outside, "private.txt"), "not yours\n");
		symlinkSync(outside, path.join(dir, "escape"));
		server = http.createServer(serveFolder(dir));
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${server.address().port}`;
	});
	after(() => {
		server.close();
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	test("lists a folder, folders first, and never hidden entries", async () => {
		const listing = await (await fetch(`${base}/`)).text();
		assert.match(listing, /href="reports\/"/);
		assert.doesNotMatch(listing, /\.env|\.git/);
		const inner = await (await fetch(`${base}/reports/`)).text();
		assert.match(inner, /q3\.md/);
	});

	test("serves files with their types, and adds the slash a folder needs", async () => {
		const md = await fetch(`${base}/reports/q3.md`);
		assert.equal(md.headers.get("content-type"), "text/plain; charset=utf-8");
		assert.equal(await md.text(), "# Q3\n");
		const redirect = await fetch(`${base}/reports`, { redirect: "manual" });
		assert.equal(redirect.status, 301);
		assert.equal(redirect.headers.get("location"), "/reports/");
	});

	test("never serves hidden files, anything outside the folder, or a symlink out of it", async () => {
		for (const route of ["/.env", "/.git/config", "/%2e%2e/secret", "/..%2f..%2fetc/passwd", "/escape/private.txt"]) {
			assert.equal((await fetch(`${base}${route}`)).status, 404, route);
		}
	});

	test("answers only requests addressed to this machine", async () => {
		const statusFor = (host) =>
			new Promise((resolve, reject) => {
				http.get(`${base}/reports/q3.md`, { headers: { host } }, (res) => {
					res.resume();
					resolve(res.statusCode);
				}).on("error", reject);
			});
		assert.equal(await statusFor("evil.example:8080"), 421, "a rebound name gets nothing");
		assert.equal(await statusFor("localhost"), 200);
		assert.equal(await statusFor("[::1]:9"), 200);
	});
});

describe("dev servers on demand", () => {
	let root;
	let runner;
	before(() => {
		root = mkdtempSync(path.join(tmpdir(), "xo-runner-"));
		runner = createRunner({ idleMs: 60_000, startTimeoutMs: 20_000 });
	});
	after(async () => {
		await runner.stopAll();
		rmSync(root, { recursive: true, force: true });
	});

	test("starts a folder's dev command on a free port, and stops it", async () => {
		const dir = project(root, "api", { env: { APP_NAME: "api" } });
		const folder = { name: "api", dir, plan: servePlan(dir, root) };
		assert.equal((await runner.resolve(folder)).state, "stopped", "nothing starts without being asked");
		assert.equal((await runner.resolve(folder, { start: true })).state, "starting");
		const running = await until(async () => {
			const current = await runner.resolve(folder);
			return current.state === "running" && current;
		});
		assert.match(await (await fetch(`${running.origin}/`)).text(), /api dev/);
		assert.match(runner.status("api").output.join("\n"), /ready on/);
		assert.equal(runner.stop("api"), true);
		await until(async () => !(await fetch(running.origin).then(() => true, () => false)));
	});

	test("finds where a server listens when it ignores PORT", async () => {
		const fixed = await freePort();
		const dir = project(root, "fixed", { env: { APP_NAME: "fixed", FIXED_PORT: fixed } });
		const folder = { name: "fixed", dir, plan: servePlan(dir, root) };
		await runner.resolve(folder, { start: true });
		const running = await until(async () => {
			const current = await runner.resolve(folder);
			return current.state === "running" && current;
		});
		assert.equal(new URL(running.origin).port, String(fixed));
		runner.stop("fixed");
	});

	test("never takes a server someone else runs on its preferred port for its own", async () => {
		const busy = http.createServer((req, res) => res.end("someone else"));
		await new Promise((resolve) => busy.listen(0, "127.0.0.1", resolve));
		const quick = createRunner({ startTimeoutMs: 1500 });
		try {
			const dir = project(root, "quiet", { script: "node -e \"setTimeout(() => {}, 60000)\"" });
			const plan = servePlan(dir, root);
			plan.command.port = busy.address().port;
			const folder = { name: "quiet", dir, plan };
			await quick.resolve(folder, { start: true });
			const settled = await until(async () => {
				const current = await quick.resolve(folder);
				return current.state !== "starting" && current;
			});
			assert.equal(settled.state, "failed", "the busy port was not mistaken for it");
			assert.match(settled.run.error, /didn't answer/);
		} finally {
			await quick.stopAll();
			busy.close();
		}
	});

	test("uses a server already running from the folder instead of starting another", async () => {
		const port = await freePort();
		const dir = project(root, "outside", {});
		const child = spawn(process.execPath, ["server.cjs"], { cwd: dir, env: { ...process.env, PORT: String(port), APP_NAME: "outside" }, stdio: "ignore" });
		try {
			await until(() => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false));
			const current = await until(async () => {
				const found = await runner.resolve({ name: "outside", dir, plan: servePlan(dir, root) }, { start: true });
				return found.state === "running" && found;
			});
			assert.equal(current.external, true);
			assert.equal(current.origin, `http://127.0.0.1:${port}`);
			assert.equal(runner.status("outside"), null, "nothing was started");
			assert.equal(runner.stop("outside"), false, "a server it found is never stopped");
		} finally {
			child.kill();
		}
	});

	test("reports a command that fails, with its output", async () => {
		const dir = project(root, "broken", { script: "node -e \"console.error('cannot find module next'); process.exit(1)\"" });
		const folder = { name: "broken", dir, plan: servePlan(dir, root) };
		await runner.resolve(folder, { start: true });
		const failed = await until(async () => {
			const current = await runner.resolve(folder);
			return current.state === "failed" && current;
		});
		assert.match(failed.run.error, /exited before it answered/);
		assert.match(runner.status("broken").output.join("\n"), /cannot find module next/);
	});

	test("a folder whose command names a port claims only that port, or a server run from the folder itself", async () => {
		const outer = project(root, "workspace", {});
		mkdirSync(path.join(outer, ".claude"));
		writeFileSync(path.join(outer, ".claude", "launch.json"), JSON.stringify({
			configurations: [{ name: "site", runtimeExecutable: "node", runtimeArgs: ["server.cjs"], port: await freePort() }],
		}));
		const tools = project(outer, "tools", {});
		const strayPort = await freePort();
		const stray = spawn(process.execPath, ["server.cjs"], { cwd: tools, env: { ...process.env, PORT: String(strayPort), APP_NAME: "tools" }, stdio: "ignore" });
		const folder = { name: "workspace", dir: outer, plan: servePlan(outer, root) };
		try {
			// Once the runner sees the subfolder's server as the subfolder's own, it is on the runner's list.
			await until(async () => (await runner.resolve({ name: "tools", dir: tools, plan: servePlan(tools, outer) })).state === "running");
			assert.equal((await runner.resolve(folder)).state, "stopped", "a subfolder's server on another port isn't the folder's");
			const ownPort = await freePort();
			const own = spawn(process.execPath, ["server.cjs"], { cwd: outer, env: { ...process.env, PORT: String(ownPort), APP_NAME: "workspace" }, stdio: "ignore" });
			try {
				const found = await until(async () => {
					const current = await runner.resolve(folder);
					return current.state === "running" && current;
				});
				assert.equal(found.origin, `http://127.0.0.1:${ownPort}`, "one run from the folder itself counts on any port");
			} finally {
				own.kill();
			}
		} finally {
			stray.kill();
		}
	});

	test("a dev server starts from the host's environment, cleaned of Next.js markers", async () => {
		const clean = createRunner({
			startTimeoutMs: 20_000,
			env: { ...process.env, __NEXT_PROCESSED_ENV: "true", TURBOPACK: "auto", NODE_ENV: "production", __NEXT_PRIVATE_ORIGIN: "x", KEEP_ME: "yes" },
		});
		try {
			const dir = project(root, "envy", { script: "node env.cjs", files: { "env.cjs": ENV_SERVER } });
			const folder = { name: "envy", dir, plan: servePlan(dir, root) };
			await clean.resolve(folder, { start: true });
			const running = await until(async () => {
				const current = await clean.resolve(folder);
				return current.state === "running" && current;
			});
			const seen = await (await fetch(`${running.origin}/`)).json();
			assert.equal(seen.__NEXT_PROCESSED_ENV, null);
			assert.equal(seen.TURBOPACK, null);
			assert.equal(seen.NODE_ENV, null);
			assert.equal(seen.__NEXT_PRIVATE_ORIGIN, null);
			assert.equal(seen.KEEP_ME, "yes");
			assert.equal(seen.HOST, "127.0.0.1");
			assert.equal(seen.PORT, new URL(running.origin).port);
		} finally {
			await clean.stopAll();
		}
	});

	test("a server running from a nested checkout is that checkout's, not the folder around it", async () => {
		const port = await freePort();
		const outer = project(root, "outer", {});
		const inner = project(outer, "inner", {});
		mkdirSync(path.join(inner, ".git"));
		const child = spawn(process.execPath, ["server.cjs"], { cwd: inner, env: { ...process.env, PORT: String(port), APP_NAME: "inner" }, stdio: "ignore" });
		try {
			await until(() => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false));
			const found = await until(async () => {
				const current = await runner.resolve({ name: "inner", dir: inner, plan: servePlan(inner, outer) });
				return current.state === "running" && current;
			});
			assert.equal(found.origin, `http://127.0.0.1:${port}`);
			const around = await runner.resolve({ name: "outer", dir: outer, plan: servePlan(outer, root) });
			assert.equal(around.state, "stopped", "the folder around it isn't running");
		} finally {
			child.kill();
		}
	});
});

describe("the gateway serves every folder", () => {
	let root;
	let dataDir;
	let gateway;
	let port;

	before(async () => {
		root = mkdtempSync(path.join(tmpdir(), "galileo-folders-"));
		dataDir = mkdtempSync(path.join(tmpdir(), "galileo-data-"));
		mkdirSync(path.join(root, "notes"));
		writeFileSync(path.join(root, "notes", "index.html"), "<!doctype html><title>Notes</title><h1>Notes</h1>");
		project(root, "api", { env: { APP_NAME: "api" } });
		gateway = createGateway({ roots: [root], dataDir, log: () => {} });
		await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
		port = gateway.server.address().port;
	});
	after(async () => {
		await gateway.close();
		gateway.server.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
	});

	const PAGE = { accept: "text/html", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" };

	function get(host, route, headers = {}) {
		return new Promise((resolve, reject) => {
			const req = http.request(`http://127.0.0.1:${port}${route}`, { headers: { host: `${host}:${port}`, ...headers } }, (res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
			});
			req.on("error", reject);
			req.end();
		});
	}

	test("pages see each folder's place on disk and where apps are managed, never its server's output", async () => {
		const response = await get("api.localhost", "/__xo/api/targets", { "sec-fetch-site": "same-origin" });
		const body = JSON.parse(response.body);
		assert.equal(body.current, "api");
		assert.equal(body.manageIn, "the launcher");
		const api = body.targets.find((target) => target.name === "api");
		assert.ok(api.folder.path.endsWith(`${path.sep}api`), api.folder.path);
		assert.equal(api.folder.serves, "run");
		assert.equal(api.folder.dir, undefined);
		assert.equal(api.folder.server, undefined);
	});

	function post(host, route, headers = {}) {
		return new Promise((resolve, reject) => {
			const req = http.request(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { host: `${host}:${port}`, "sec-fetch-site": "same-origin", ...headers } }, (res) => {
				res.resume();
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
			});
			req.on("error", reject);
			req.end();
		});
	}

	test("a folder with files is served at its name, with the toolbar", async () => {
		const page = await get("notes.localhost", "/", PAGE);
		assert.equal(page.status, 200);
		assert.match(page.body, /<h1>Notes<\/h1>/);
		assert.match(page.body, /data-project="notes" data-app-version="files"/);
	});

	test("a new folder is an app as soon as it exists", async () => {
		mkdirSync(path.join(root, "fresh"));
		writeFileSync(path.join(root, "fresh", "hello.txt"), "hi\n");
		await sleep(2100);
		const listing = await get("fresh.localhost", "/", PAGE);
		assert.equal(listing.status, 200);
		assert.match(listing.body, /hello\.txt/);
	});

	test("a fetch or another site's frame never starts a server; your own page load does", async () => {
		const fetched = await get("api.localhost", "/data", { accept: "*/*", "sec-fetch-mode": "cors", "sec-fetch-site": "cross-site" });
		assert.equal(fetched.status, 503);
		const framed = await get("api.localhost", "/", { ...PAGE, "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site", referer: "https://evil.example/" });
		assert.equal(framed.status, 503);
		assert.match(framed.body, /api isn(’|')t running/);
		assert.match(framed.body, /action="\/__xo\/api\/start\?next=%2F"/);

		const opened = await get("api.localhost", "/", { ...PAGE, "sec-fetch-site": "cross-site", referer: "http://localhost:3000/" });
		assert.equal(opened.status, 503);
		assert.match(opened.body, /Starting api/);
		assert.match(opened.body, /http-equiv="refresh"/);
		const ready = await until(async () => {
			const page = await get("api.localhost", "/", PAGE);
			return page.status === 200 && page;
		});
		assert.match(ready.body, /<h1>api dev<\/h1>/);
		assert.match(ready.body, /data-project="api" data-app-version="dev"/);
		const data = JSON.parse((await get("api.localhost", "/data", { accept: "application/json" })).body);
		assert.match(data.host, /^127\.0\.0\.1:\d+$/, "the dev server sees its own host");
	});

	test("the launcher lists folders with what they serve, and stops and starts a dev server", async () => {
		const listed = JSON.parse((await get("localhost", "/__xo/api/targets", { "sec-fetch-site": "same-origin" })).body).targets;
		const byName = Object.fromEntries(listed.map((target) => [target.name, target]));
		assert.equal(byName.notes.source, "folder");
		assert.equal(byName.notes.folder.serves, "files");
		assert.equal(byName.api.folder.serves, "run");
		assert.equal(byName.api.up, true);
		assert.equal(byName.api.versions[0].state, "running");

		assert.equal((await post("localhost", "/__xo/api/folders/api/stop")).status, 200);
		const stopped = await until(async () => {
			const page = await get("api.localhost", "/data", { accept: "application/json" });
			return page.status === 503 && page;
		});
		assert.match(stopped.body, /not running/);
		assert.equal((await post("localhost", "/__xo/api/folders/notes/start")).status, 400, "files have nothing to start");
		assert.equal((await post("localhost", "/__xo/api/folders/api/start", { "sec-fetch-site": "cross-site" })).status, 403);
	});

	test("the Start button on an app's own page starts it and comes back", async () => {
		const started = await post("api.localhost", "/__xo/api/start?next=%2Fdata");
		assert.equal(started.status, 303);
		assert.equal(started.headers.location, "/data");
		await until(async () => (await get("api.localhost", "/data", { accept: "application/json" })).status === 200);
	});

	test("who may start a server", () => {
		const page = (headers) => ({ method: "GET", headers: { accept: "text/html", ...headers } });
		assert.equal(mayStart(page({ "sec-fetch-mode": "navigate", "sec-fetch-site": "none" })), true, "a typed address");
		assert.equal(mayStart(page({ "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site", referer: "http://localhost:4100/" })), true, "the launcher");
		assert.equal(mayStart(page({ "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site", referer: "http://acme.localhost:4100/x" })), true, "another app");
		assert.equal(mayStart(page({ "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" })), false, "another site, referrer hidden");
		assert.equal(mayStart(page({ "sec-fetch-mode": "no-cors", "sec-fetch-site": "none" })), false, "an image");
		assert.equal(mayStart({ method: "POST", headers: { "sec-fetch-mode": "navigate", "sec-fetch-site": "none" } }), false);
	});
});

describe("folders come and go", () => {
	let dataDir;
	const gateways = [];
	const roots = [];
	before(() => {
		dataDir = mkdtempSync(path.join(tmpdir(), "galileo-live-data-"));
	});
	after(async () => {
		for (const gateway of gateways) {
			await gateway.close();
			gateway.server.close();
		}
		for (const dir of [dataDir, ...roots]) rmSync(dir, { recursive: true, force: true });
	});

	async function start(options) {
		const gateway = createGateway({ dataDir, log: () => {}, ...options });
		await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
		gateways.push(gateway);
		return { gateway, port: gateway.server.address().port };
	}

	function get(port, host, route, headers = {}) {
		return new Promise((resolve, reject) => {
			const req = http.request(`http://127.0.0.1:${port}${route}`, { headers: { host: `${host}:${port}`, ...headers } }, (res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
			});
			req.on("error", reject);
			req.end();
		});
	}

	const PAGE = { accept: "text/html", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" };

	test("deleting a folder while its dev server runs stops the server", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "xo-live-"));
		roots.push(root);
		const dir = project(root, "doomed", { env: { APP_NAME: "doomed" } });
		const { port } = await start({ roots: [root] });
		await until(async () => (await get(port, "doomed.localhost", "/", PAGE)).body.includes("doomed dev"));
		const targets = JSON.parse((await get(port, "localhost", "/__xo/api/targets")).body).targets;
		const origin = targets.find((target) => target.name === "doomed").versions[0].upstream;
		assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
		rmSync(dir, { recursive: true, force: true });
		await until(async () => !(await fetch(origin).then(() => true, () => false)), 15_000);
		const health = JSON.parse((await get(port, "localhost", "/__xo/health")).body);
		assert.ok(!health.apps.includes("doomed"), "its name is gone too");
	});

	test("a root that appears after the gateway started is watched once it exists", async () => {
		const parent = mkdtempSync(path.join(tmpdir(), "xo-late-"));
		roots.push(parent);
		const root = path.join(parent, "xo-root");
		const { port } = await start({ roots: [root] });
		mkdirSync(path.join(root, "first"), { recursive: true });
		writeFileSync(path.join(root, "first", "index.html"), "<h1>first</h1>");
		// Asking for a name nobody knows scans again, which also starts watching the new root.
		await until(async () => (await get(port, "first.localhost", "/", PAGE)).status === 200);
		mkdirSync(path.join(root, "second"));
		// No lookup this time: only the watch can make it appear this quickly (the fallback scan is 10 s).
		const seen = await until(async () => JSON.parse((await get(port, "localhost", "/__xo/health")).body).apps.includes("second"), 4_000);
		assert.ok(seen);
	});

	test("display names reach both the launcher and the pages", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "xo-names-"));
		roots.push(root);
		mkdirSync(path.join(root, "acme", ".xo"), { recursive: true });
		writeFileSync(path.join(root, "acme", "index.html"), "<h1>acme</h1>");
		writeFileSync(path.join(root, "acme", ".xo", "project.json"), JSON.stringify({ name: "acme", display_name: "Acme Notes", description: "Notes" }));
		const { port } = await start({ roots: [root] });
		const launcher = JSON.parse((await get(port, "localhost", "/__xo/api/targets")).body).targets.find((target) => target.name === "acme");
		assert.equal(launcher.folder.displayName, "Acme Notes");
		assert.equal(launcher.folder.description, "Notes");
		assert.equal(launcher.folder.xoProject, "acme");
		const page = JSON.parse((await get(port, "acme.localhost", "/__xo/api/targets", { "sec-fetch-site": "same-origin" })).body);
		const seen = page.targets.find((target) => target.name === "acme").folder;
		assert.equal(seen.displayName, "Acme Notes");
		assert.equal(seen.dir, undefined);
		assert.equal(seen.description, undefined);
	});
});
