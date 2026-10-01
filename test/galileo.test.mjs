/**
 * galileo end to end, in-process: port sources (the sample app, with its
 * strict security headers, and a small server that redirects, sets cookies
 * and speaks WebSocket), files sources in a scratch folder, and real HTTP in
 * between, every request routed by its Host header. `npm test`.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { createGalileo } from "../src/server.mjs";
import { createSampleApp } from "../sample-app/server.mjs";

const PAGE = { accept: "text/html", "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" };
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

let scratch;
let sample;
let other;
let galileo;
let port;
let downPort;

before(async () => {
	scratch = mkdtempSync(path.join(tmpdir(), "galileo-test-"));
	const site = path.join(scratch, "site");
	mkdirSync(path.join(site, "sub"), { recursive: true });
	mkdirSync(path.join(site, "node_modules"), { recursive: true });
	writeFileSync(path.join(site, "notes.md"), "# Notes\n\n<b>not markup</b> & more\n");
	writeFileSync(path.join(site, "page.html"), "<!doctype html><title>A page</title><h1>A page</h1>");
	writeFileSync(path.join(site, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 4, 5, 6, 7]));
	writeFileSync(path.join(site, "data.bin"), Buffer.from([1, 0, 2, 0, 3]));
	writeFileSync(path.join(site, "Makefile"), "all:\n\techo hi\n");
	writeFileSync(path.join(site, ".env"), "SECRET=1\n");
	writeFileSync(path.join(site, "sub", "deep.txt"), "deep\n");
	writeFileSync(path.join(site, "node_modules", "x.js"), "module.exports = 1;\n");
	writeFileSync(path.join(scratch, "outside.txt"), "outside\n");
	symlinkSync(path.join(scratch, "outside.txt"), path.join(site, "escape.txt"));
	// Links that try to reach what a source hides: a page outside it, .env, and .git.
	writeFileSync(path.join(scratch, "outside.html"), "<!doctype html><h1>SECRET PAGE</h1>");
	mkdirSync(path.join(site, "linked"));
	symlinkSync(path.join(scratch, "outside.html"), path.join(site, "linked", "index.html"));
	symlinkSync(path.join(site, ".env"), path.join(site, "env-link"));
	mkdirSync(path.join(site, ".git"));
	writeFileSync(path.join(site, ".git", "config"), "url = https://user:TOKEN@example.com/repo\n");
	symlinkSync(path.join(site, ".git"), path.join(site, "gitlink"));
	const docs = path.join(scratch, "docs");
	mkdirSync(docs);
	writeFileSync(path.join(docs, "index.html"), "<!doctype html><title>Docs</title><h1>Docs home</h1>");
	writeFileSync(path.join(scratch, "report.html"), "<!doctype html><title>Report</title><h1>The report</h1>");

	sample = createSampleApp();
	await listen(sample);
	other = http.createServer((req, res) => {
		if (req.url === "/redirect") {
			res.writeHead(302, { location: `http://localhost:${other.address().port}/landed?from=redirect` });
			return res.end();
		}
		if (req.url === "/cookie") {
			res.writeHead(200, { "content-type": "text/plain", "set-cookie": "sid=1; Domain=localhost; Path=/" });
			return res.end("cookie");
		}
		if (req.url === "/two-policies") {
			// Two CSP headers, which Node joins with a comma on the way in.
			res.setHeader("content-security-policy", ["default-src 'self'", "frame-ancestors 'none'"]);
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			return res.end("<!doctype html><title>Two</title><h1>Two policies</h1>");
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(`<!doctype html><title>Other</title><h1>Other app</h1><p>${req.headers.host}</p>`);
	});
	// A stand-in for a dev server's hot-reload socket: accept the upgrade, then echo.
	other.on("upgrade", (_req, socket) => {
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
		socket.pipe(socket);
	});
	await listen(other);
	const spare = http.createServer();
	await listen(spare);
	downPort = spare.address().port;
	await new Promise((resolve) => spare.close(resolve));

	galileo = createGalileo({
		dataDir: path.join(scratch, "data"),
		log: () => {},
		sources: [
			{ name: "acme", type: "port", port: sample.address().port },
			{ name: "other", type: "port", port: other.address().port },
			{ name: "down", type: "port", port: downPort },
			{ name: "site", type: "files", path: site },
			{ name: "docs", type: "files", path: docs },
			{ name: "report", type: "files", path: path.join(scratch, "report.html") },
			{ name: "gone", type: "files", path: path.join(scratch, "no-such-folder") },
		],
	});
	await listen(galileo.server);
	port = galileo.server.address().port;
});

after(async () => {
	await galileo.close();
	sample.close();
	other.close();
	rmSync(scratch, { recursive: true, force: true });
});

const host = (name) => (name ? `${name}.localhost:${port}` : `localhost:${port}`);
const framing = () => `frame-ancestors 'self' http://localhost:${port} http://127.0.0.1:${port}`;

describe("galileo's own host", () => {
	test("serves telescope for its routes, framing every source and framed by nothing", async () => {
		for (const route of ["/", "/sources", "/s/acme/", "/s/acme/pricing?x=1"]) {
			const response = await get(null, route, PAGE);
			assert.equal(response.status, 200, route);
			assert.match(response.body, /<header class="bar"/);
			assert.match(response.headers["content-security-policy"], new RegExp(`frame-src http://\\*\\.localhost:${port}`));
			assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
		}
		assert.equal((await get(null, "/launcher")).status, 404);
		const head = await request("HEAD", url(null, "/sources"), undefined, { host: host(null) });
		assert.equal(head.status, 200);
		assert.equal(head.body, "");
	});

	test("tells a foreign host nothing, not even the names of the sources", async () => {
		const response = await get("", "/", PAGE, "evil.example:" + port);
		assert.equal(response.status, 421);
		assert.doesNotMatch(response.body, /acme|site/);
		assert.equal((await get("", "/__xo/api/sources", { ...SAME_ORIGIN }, "evil.example")).status, 421);
	});

	test("serves telescope's own files, and no others", async () => {
		const script = await get(null, "/__xo/telescope/telescope.js");
		assert.equal(script.status, 200);
		assert.match(script.headers["content-type"], /javascript/);
		assert.equal((await get(null, "/__xo/telescope/index.html")).status, 404);
		assert.equal((await get(null, "/__xo/telescope/../src/server.mjs")).status, 404);
	});

	test("answers health with the names of the sources", async () => {
		const response = await get(null, "/__xo/health");
		assert.deepEqual(JSON.parse(response.body), { ok: true, sources: ["acme", "docs", "down", "gone", "other", "report", "site"] });
	});
});

describe("the sources API", () => {
	test("lists every source with its address and how it is right now", async () => {
		const { status, json } = await send(null, "GET", "/__xo/api/sources");
		assert.equal(status, 200);
		const byName = Object.fromEntries(json.sources.map((source) => [source.name, source]));
		assert.equal(byName.acme.url, `http://acme.localhost:${port}/`);
		assert.equal(byName.acme.up, true);
		assert.equal(byName.down.up, false);
		assert.equal(byName.site.kind, "folder");
		assert.equal(byName.report.kind, "file");
		assert.equal(byName.gone.kind, null);
		assert.equal(byName.gone.up, false);
	});

	test("adds, changes and removes a source", async () => {
		const added = await send(null, "POST", "/__xo/api/sources", { name: "web", location: String(other.address().port) });
		assert.equal(added.status, 201);
		assert.equal(added.json.source.type, "port");
		assert.equal(added.json.source.up, true);
		assert.match((await get("web", "/", PAGE)).body, /<h1>Other app<\/h1>/);

		const changed = await send(null, "POST", "/__xo/api/sources", { name: "web", location: path.join(scratch, "docs") });
		assert.equal(changed.status, 200);
		assert.equal(changed.json.source.kind, "folder");
		assert.match((await get("web", "/", PAGE)).body, /<h1>Docs home<\/h1>/);

		assert.equal((await send(null, "DELETE", "/__xo/api/sources/web")).status, 200);
		assert.equal((await send(null, "DELETE", "/__xo/api/sources/web")).status, 404);
		assert.equal((await get("web", "/", PAGE)).status, 404);
	});

	test("takes changes only as JSON, from galileo's own pages, with full paths and good names", async () => {
		const formPost = await request("POST", url(null, "/__xo/api/sources"), "name=x&location=1", {
			host: host(null),
			"content-type": "application/x-www-form-urlencoded",
		});
		assert.equal(formPost.status, 415);
		assert.equal((await send(null, "POST", "/__xo/api/sources", { name: "x", location: "5173" }, { "sec-fetch-site": "cross-site" })).status, 403);
		assert.equal((await send(null, "GET", "/__xo/api/sources", undefined, { "sec-fetch-site": "same-site" })).status, 403);
		assert.match((await send(null, "POST", "/__xo/api/sources", { name: "x", location: "notes" })).json.error, /full path/);
		assert.match((await send(null, "POST", "/__xo/api/sources", { name: "No Good", location: "5173" })).json.error, /can't be a source name/);
		assert.match((await send(null, "POST", "/__xo/api/sources", { name: "self", location: String(port) })).json.error, /galileo's own port/);
		assert.match((await send(null, "POST", "/__xo/api/sources", { name: "far", location: "https://example.com" })).json.error, /not on this machine/);
	});

	test("isn't there on a source's own address", async () => {
		assert.equal((await send("acme", "GET", "/__xo/api/sources")).status, 404);
		assert.equal((await send("site", "POST", "/__xo/api/sources", { name: "x", location: "1" })).status, 404);
	});
});

describe("a port source", () => {
	test("is proxied with the bridge appended to its pages, under a policy that lets it run", async () => {
		const response = await get("acme", "/pricing", PAGE);
		assert.equal(response.status, 200);
		assert.match(response.body, /<h1>Pricing<\/h1>/);
		const nonce = /<script async nonce="([^"]+)" src="\/__xo\/bridge\.js"><\/script>\n$/.exec(response.body)?.[1];
		assert.ok(nonce, "the bridge tag comes last, with a nonce");
		const policies = [].concat(response.headers["content-security-policy"]).join(" | ");
		assert.match(policies, new RegExp(`script-src 'nonce-[^']+' 'strict-dynamic' 'nonce-${nonce.replace(/[+/=]/g, "\\$&")}'`));
		assert.ok(policies.includes(framing()));
		assert.doesNotMatch(policies, /frame-ancestors 'none'/);
		assert.equal(response.headers["x-frame-options"], undefined);
		assert.equal(response.headers["x-galileo-bridge"], "added");
	});

	test("passes everything that isn't a page through as it is, framed by galileo alone", async () => {
		const response = await get("acme", "/styles.css", { accept: "text/css", "sec-fetch-dest": "style" });
		assert.equal(response.status, 200);
		assert.equal(response.body, readFileSync(new URL("../sample-app/public/styles.css", import.meta.url), "utf8"));
		assert.equal(response.headers["x-galileo-bridge"], undefined);
		assert.equal(response.headers["content-security-policy"], framing());
	});

	test("can be framed even when it sends its policies as two headers", async () => {
		const response = await get("other", "/two-policies", PAGE);
		// Node's client joins the headers again, with a comma.
		const policies = String(response.headers["content-security-policy"]).split(",").map((policy) => policy.trim());
		assert.doesNotMatch(policies.join(" | "), /frame-ancestors 'none'/);
		assert.ok(policies.includes(framing()));
		assert.ok(policies.includes("default-src 'self'; script-src 'self'"), policies.join(" | "));
		assert.match(response.body, /src="\/__xo\/bridge\.js"/);
	});

	test("keeps redirects and cookies on the source's address", async () => {
		const redirect = await get("other", "/redirect");
		assert.equal(redirect.status, 302);
		assert.equal(redirect.headers.location, `http://other.localhost:${port}/landed?from=redirect`);
		const cookie = await get("other", "/cookie");
		assert.deepEqual(cookie.headers["set-cookie"], ["sid=1; Path=/"]);
	});

	test("reaches the port with the port's own Host", async () => {
		assert.match((await get("other", "/", PAGE)).body, new RegExp(`<p>localhost:${other.address().port}</p>`));
	});

	test("serves the bridge on its own address", async () => {
		const response = await get("acme", "/__xo/bridge.js");
		assert.equal(response.status, 200);
		assert.match(response.body, /galileo: "where"/);
		assert.equal(response.headers["content-security-policy"], framing());
		assert.equal((await get("acme", "/__xo/other.js")).status, 404);
	});

	test("tunnels WebSocket upgrades to the port, and to nothing else", async () => {
		assert.equal(await websocketEcho("other", "ping"), "ping");
		await assert.rejects(websocketEcho(null, "ping"));
		await assert.rejects(websocketEcho("site", "ping"));
		await assert.rejects(websocketEcho("nobody", "ping"));
	});

	test("takes upgrades only from the source's own pages, galileo's, or no page", async () => {
		assert.equal(await websocketEcho("other", "own", `http://other.localhost:${port}`), "own");
		assert.equal(await websocketEcho("other", "galileo", `http://localhost:${port}`), "galileo");
		await assert.rejects(websocketEcho("other", "evil", "https://evil.example"), /403/);
		await assert.rejects(websocketEcho("other", "sibling", `http://acme.localhost:${port}`), /403/);
	});

	test("that isn't answering gets a page that waits, with the bridge", async () => {
		const page = await get("down", "/", PAGE);
		assert.equal(page.status, 502);
		assert.match(page.body, /Waiting for down/);
		assert.match(page.body, /<meta http-equiv="refresh" content="2">/);
		assert.match(page.body, /src="\/__xo\/bridge\.js"/);
		assert.match(page.headers["content-security-policy"], new RegExp(framing().replace(/[.*]/g, "\\$&")));
		const fetchOne = await get("down", "/api", { accept: "application/json" });
		assert.equal(fetchOne.status, 502);
		assert.match(fetchOne.body, /Nothing answers on port/);
		assert.equal(fetchOne.headers["content-security-policy"], framing());
	});
});

describe("a name nobody added", () => {
	test("gets a page listing the real sources, never another source", async () => {
		const page = await get("nobody", "/", PAGE);
		assert.equal(page.status, 404);
		assert.match(page.body, /No source called “nobody”/);
		assert.match(page.body, new RegExp(`href="http://localhost:${port}/s/acme/" target="_top"`));
		const json = await get("nobody", "/", { accept: "application/json" });
		assert.equal(json.status, 404);
		assert.match(JSON.parse(json.body).error, /nobody/);
		assert.equal(json.headers["content-security-policy"], framing());
	});
});

describe("a files source", () => {
	test("lists a folder, leaving out hidden files and node_modules, with the bridge", async () => {
		const page = await get("site", "/", PAGE);
		assert.equal(page.status, 200);
		for (const name of ["notes.md", "page.html", "image.png", "Makefile", "sub/"]) assert.ok(page.body.includes(`>${name}</a>`), name);
		assert.doesNotMatch(page.body, /href="\.env"|href="node_modules\/"/);
		assert.match(page.body, /src="\/__xo\/bridge\.js"/);
		assert.match(page.headers["content-security-policy"], /default-src 'none'/);
		assert.equal((await get("site", "/sub", PAGE)).headers.location, "/sub/");
		assert.match((await get("site", "/sub/", PAGE)).body, />deep\.txt<\/a>/);
	});

	test("shows a text file as a page, escaped, and serves it as it is when asked", async () => {
		const page = await get("site", "/notes.md", PAGE);
		assert.equal(page.status, 200);
		assert.match(page.body, /&lt;b&gt;not markup&lt;\/b&gt; &amp; more/);
		assert.match(page.body, /href="\?raw">Raw<\/a>/);
		assert.match(page.body, /src="\/__xo\/bridge\.js"/);
		const raw = await get("site", "/notes.md?raw", PAGE);
		assert.match(raw.headers["content-type"], /^text\/plain/);
		assert.equal(raw.body, "# Notes\n\n<b>not markup</b> & more\n");
		assert.equal(raw.headers["x-content-type-options"], "nosniff");
		const fetched = await get("site", "/notes.md", { accept: "*/*", "sec-fetch-dest": "empty" });
		assert.equal(fetched.body, raw.body);
		assert.match((await get("site", "/Makefile", PAGE)).body, /echo hi/);
	});

	test("serves its own HTML as it is, with the bridge appended only to page loads", async () => {
		const page = await get("site", "/page.html", PAGE);
		assert.match(page.body, /<h1>A page<\/h1>\n<script async src="\/__xo\/bridge\.js"><\/script>\n$/);
		assert.equal(Number(page.headers["content-length"]), Buffer.byteLength(page.body));
		assert.equal(page.headers["content-security-policy"], framing());
		const fetched = await get("site", "/page.html", { accept: "text/html", "sec-fetch-dest": "empty" });
		assert.doesNotMatch(fetched.body, /bridge/);
	});

	test("serves media to the elements that ask, with byte ranges, and a page around it for a page load", async () => {
		const image = await get("site", "/image.png", { accept: "image/*", "sec-fetch-dest": "image" });
		assert.equal(image.headers["content-type"], "image/png");
		assert.equal(image.headers["accept-ranges"], "bytes");
		const part = await get("site", "/image.png", { "sec-fetch-dest": "image", range: "bytes=0-3" });
		assert.equal(part.status, 206);
		assert.equal(part.headers["content-range"], "bytes 0-3/16");
		assert.match((await get("site", "/image.png", PAGE)).body, /<img src="\?raw"/);
		assert.match((await get("site", "/data.bin", PAGE)).body, /can't show this kind of file/);
	});

	test("serves nothing hidden, nothing outside the folder, and nothing but reads", async () => {
		for (const route of ["/.env", "/%2e%2e/outside.txt", "/sub/%2E%2E/%2E%2E/outside.txt", "/escape.txt", "/missing.txt", "/a%5cb"]) {
			assert.equal((await get("site", route, PAGE)).status, 404, route);
		}
		// Links with ordinary names reach nothing hidden or outside either, and aren't listed.
		for (const route of ["/env-link", "/env-link?raw", "/gitlink/", "/gitlink/config"]) {
			assert.equal((await get("site", route, PAGE)).status, 404, route);
		}
		const linked = await get("site", "/linked/", PAGE);
		assert.equal(linked.status, 200);
		assert.doesNotMatch(linked.body, /SECRET PAGE|index\.html/);
		const listing = (await get("site", "/", PAGE)).body;
		for (const name of ["escape.txt", "env-link", "gitlink"]) assert.ok(!listing.includes(`>${name}`), name);
		const post = await request("POST", url("site", "/notes.md"), "x", { host: host("site") });
		assert.equal(post.status, 405);
		const head = await request("HEAD", url("site", "/notes.md?raw"), undefined, { host: host("site") });
		assert.equal(head.status, 200);
		assert.equal(head.body, "");
	});

	test("a folder with an index.html shows it, a single file shows itself alone, and a path that's gone says so", async () => {
		assert.match((await get("docs", "/", PAGE)).body, /<h1>Docs home<\/h1>/);
		const report = await get("report", "/", PAGE);
		assert.match(report.body, /<h1>The report<\/h1>\n<script async src="\/__xo\/bridge\.js">/);
		assert.equal((await get("report", "/report.html", PAGE)).status, 404);
		const gone = await get("gone", "/", PAGE);
		assert.equal(gone.status, 404);
		assert.match(gone.body, /isn't there any more/);
	});
});

function listen(server) {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function url(name, route) {
	return `http://127.0.0.1:${port}${route}`;
}

function get(name, route, headers = {}, hostHeader = host(name)) {
	return request("GET", url(name, route), undefined, { host: hostHeader, ...headers });
}

async function send(name, method, route, body, headers = {}) {
	const response = await request(method, url(name, route), body, { host: host(name), ...SAME_ORIGIN, ...headers });
	return { ...response, json: JSON.parse(response.body || "{}") };
}

function request(method, address, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const payload = typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body);
		const contentType = typeof body === "object" ? { "content-type": "application/json" } : {};
		const req = http.request(address, { method, headers: { ...contentType, ...headers } }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end(payload);
	});
}

function websocketEcho(name, message, origin) {
	return new Promise((resolve, reject) => {
		const req = http.request(`http://127.0.0.1:${port}/_hmr`, {
			headers: { host: host(name), connection: "Upgrade", upgrade: "websocket", ...(origin ? { origin } : {}) },
		});
		req.on("upgrade", (_res, socket) => {
			socket.once("data", (data) => {
				resolve(data.toString());
				socket.destroy();
			});
			socket.write(message);
		});
		req.on("response", (res) => reject(new Error(`answered ${res.statusCode} without upgrading`)));
		req.on("error", reject);
		req.end();
	});
}
