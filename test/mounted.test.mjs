/**
 * The gateway mounted in another server on the same port, as xo-client runs
 * it: the host answers its own pages and upgrades, and hands the gateway every
 * request and upgrade `owns()` claims. `npm test`.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { createGateway, ownsRequest } from "../index.mjs";

let app;
let host;
let port;
let dataDir;

before(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "galileo-mounted-"));
	app = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(`<!doctype html><title>Docs</title><h1>Docs app</h1>`);
	});
	app.on("upgrade", (req, socket) => {
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
		socket.write("app:");
		socket.pipe(socket);
	});
	await listen(app);

	host = http.createServer();
	await listen(host);
	port = host.address().port;
	const gateway = createGateway({
		dataDir,
		port,
		log: () => {},
		targets: [{ name: "docs", upstream: `http://127.0.0.1:${app.address().port}` }],
		addAppsIn: "Settings › Apps",
	});
	host.on("request", (req, res) => {
		if (gateway.owns(req)) return gateway.handle(req, res);
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.end(`host app: ${req.url}`);
	});
	host.on("upgrade", (req, socket, head) => {
		if (gateway.owns(req)) return gateway.upgrade(req, socket, head);
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
		socket.write("host:");
		socket.pipe(socket);
	});
});

after(() => {
	host.close();
	app.close();
	rmSync(dataDir, { recursive: true, force: true });
});

describe("mounted beside another app", () => {
	test("the library exports the same rule the gateway applies", () => {
		assert.equal(ownsRequest(`docs.localhost:${port}`, "/"), true);
	});

	test("the bare host's pages stay the host app's, the launcher page included", async () => {
		for (const route of ["/", "/settings", "/_next/static/app.js"]) {
			const response = await get(`localhost:${port}`, route);
			assert.equal(response.body, `host app: ${route}`);
		}
	});

	test("the launcher's API and the toolbar's files answer on the bare host, with addresses on the host's port", async () => {
		const targets = await get(`localhost:${port}`, "/__xo/api/targets", { "sec-fetch-site": "same-origin" });
		assert.equal(targets.status, 200);
		const [docs] = JSON.parse(targets.body).targets;
		assert.equal(docs.name, "docs");
		assert.equal(docs.url, `http://docs.localhost:${port}/`);
		const designer = await get(`localhost:${port}`, "/__xo/toolbar/designer.js");
		assert.equal(designer.status, 200);
		assert.match(designer.headers["content-type"], /javascript/);
	});

	test("apps are proxied with the toolbar, and unknown names get the gateway's 404", async () => {
		const page = await get(`docs.localhost:${port}`, "/", { accept: "text/html", "sec-fetch-dest": "document" });
		assert.match(page.body, /<h1>Docs app<\/h1>/);
		assert.match(page.body, /__xo\/toolbar\/loader\.js/);
		const unknown = await get(`nobody.localhost:${port}`, "/", { accept: "application/json" });
		assert.equal(unknown.status, 404);
		assert.match(unknown.body, /No app called/);
	});

	test("its 404 pages send people to where the host adds apps", async () => {
		const page = await get(`nobody.localhost:${port}`, "/", { accept: "text/html" });
		assert.equal(page.status, 404);
		assert.match(page.body, new RegExp(`<a href="http://localhost:${port}/">Add one in Settings › Apps</a>`));
	});

	test("other hostnames reach the host app", async () => {
		const response = await get(`192.168.1.20:${port}`, "/__xo/api/targets");
		assert.equal(response.body, "host app: /__xo/api/targets");
	});

	test("an app's upgrade reaches the app, and the host's own upgrade stays the host's", async () => {
		assert.equal(await upgradeEcho(`docs.localhost:${port}`, "ping"), "app:");
		assert.equal(await upgradeEcho(`localhost:${port}`, "ping"), "host:");
	});
});

function listen(server) {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function get(hostHeader, route, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(`http://127.0.0.1:${port}${route}`, { headers: { host: hostHeader, ...headers } }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end();
	});
}

/** Opens a WebSocket-style upgrade and resolves with the first bytes the far side sends. */
function upgradeEcho(hostHeader, message) {
	return new Promise((resolve, reject) => {
		const req = http.request(`http://127.0.0.1:${port}/_next/hmr`, {
			headers: { host: hostHeader, connection: "Upgrade", upgrade: "websocket" },
		});
		req.on("upgrade", (_res, socket, head) => {
			const first = head?.length ? head.toString() : null;
			if (first) {
				resolve(first.slice(0, 5));
				socket.destroy();
				return;
			}
			socket.once("data", (data) => {
				resolve(data.toString().slice(0, 5));
				socket.destroy();
			});
			socket.write(message);
		});
		req.on("error", reject);
		req.end();
	});
}
