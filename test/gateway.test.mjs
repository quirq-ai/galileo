/**
 * The gateway end to end, in-process: apps behind it (the sample app in two
 * builds as two versions of one app, and a small second server that also
 * speaks WebSocket), real HTTP in between, and every request routed by its
 * Host header. `npm test`.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { createGateway } from "../src/server.mjs";
import { createSampleApp } from "../sample-app/server.mjs";

const HTML = { accept: "text/html", "sec-fetch-dest": "document" };

let sample;
let sampleDev;
let other;
let gateway;
let port;
let dataDir;
let sampleBase;
let sampleDevBase;

before(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "galileo-test-"));
	sample = createSampleApp();
	await listen(sample);
	sampleBase = `http://127.0.0.1:${sample.address().port}`;
	sampleDev = createSampleApp({ build: "dev" });
	await listen(sampleDev);
	sampleDevBase = `http://127.0.0.1:${sampleDev.address().port}`;

	other = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(`<!doctype html><title>Other</title><h1>Other app</h1><p>${req.headers.host}</p>`);
	});
	// A stand-in for a dev server's hot-reload socket: accept the upgrade, then echo.
	other.on("upgrade", (req, socket) => {
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
		socket.pipe(socket);
	});
	await listen(other);

	gateway = createGateway({
		dataDir,
		log: () => {},
		targets: [
			{ name: "acme", upstream: sampleBase },
			{ name: "acme", version: "dev", upstream: sampleDevBase },
			{ name: "other", upstream: `http://127.0.0.1:${other.address().port}` },
			{ name: "other", version: "canary", upstream: `http://127.0.0.1:${other.address().port}` },
			{ name: "down", upstream: "http://127.0.0.1:9" },
		],
	}).server;
	await listen(gateway);
	port = gateway.address().port;
});

after(() => {
	gateway.close();
	sample.close();
	sampleDev.close();
	other.close();
	rmSync(dataDir, { recursive: true, force: true });
});

const host = (name) => (name ? `${name}.localhost:${port}` : `localhost:${port}`);
const PAGE = { accept: "text/html", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

describe("routing by name", () => {
	test("each name reaches its own app, with the toolbar tagged for that app", async () => {
		const acme = await get("acme", "/pricing", HTML);
		const second = await get("other", "/", HTML);
		assert.match(acme.body, /<h1>Pricing<\/h1>/);
		assert.match(acme.body, /data-project="acme"/);
		assert.match(second.body, /<h1>Other app<\/h1>/);
		assert.match(second.body, /data-project="other"/);
		// The app sees its own Host; the gateway's address travels as x-forwarded-host.
		assert.match(second.body, /<p>127\.0\.0\.1:\d+<\/p>/);
	});

	test("the bare host is galileo's home page, and is never proxied", async () => {
		const home = await get(null, "/", HTML);
		assert.equal(home.status, 200);
		assert.match(home.body, /<title>galileo<\/title>/);
		assert.match(home.body, /Routes now/);
		assert.match(home.headers["content-security-policy"], /script-src 'self'/);
		assert.doesNotMatch(home.body, /data-xo-toolbar/);
		for (const [file, type] of [["home.js", /javascript/], ["home.css", /css/], ["icon.svg", /image\/svg\+xml/]]) {
			const asset = await get(null, `/__xo/home/${file}`);
			assert.equal(asset.status, 200, file);
			assert.match(asset.headers["content-type"], type);
		}
	});

	test("the launcher moved to /launcher on the bare host", async () => {
		for (const route of ["/launcher", "/launcher/"]) {
			const launcher = await get(null, route, HTML);
			assert.equal(launcher.status, 200, route);
			assert.match(launcher.body, /Apps on this gateway/);
			assert.doesNotMatch(launcher.body, /data-xo-toolbar/);
		}
	});

	test("an unknown name gets a list of the real ones instead of someone else's app", async () => {
		const page = await get("docs", "/", HTML);
		assert.equal(page.status, 404);
		assert.match(page.body, /No app called “docs”/);
		assert.match(page.body, new RegExp(`http://acme\\.localhost:${port}/`));
		assert.match(page.body, new RegExp(`<a href="http://localhost:${port}/launcher">Add one in the launcher</a>`));
		const api = await get("docs", "/anything", { accept: "application/json" });
		assert.equal(JSON.parse(api.body).error, 'No app called "docs" on this gateway');
	});

	test("hot-reload WebSockets are tunnelled to the app the name points at", async () => {
		const echoed = await websocketEcho("other", "ping");
		assert.equal(echoed, "ping");
	});

	test("a stopped app gets a waiting page that still carries its toolbar", async () => {
		const page = await get("down", "/", HTML);
		assert.equal(page.status, 502);
		assert.match(page.body, /Waiting for down/);
		assert.match(page.body, /data-project="down"/);
	});
});

describe("carrying the toolbar", () => {
	test("appends one loader tag after the page's last byte, with a nonce the rewritten CSP trusts", async () => {
		const direct = await request("GET", `${sampleBase}/pricing`, undefined, HTML);
		const through = await get("acme", "/pricing", HTML);

		assert.equal(through.status, 200);
		assert.equal(through.headers["x-xo-toolbar"], "injected");
		assert.equal(through.headers["x-frame-options"], undefined);

		const tag = /<script async data-xo-toolbar data-explicit-opt-in="true" data-preview-id="acme-main-[0-9a-f]+" data-project="acme" data-app-version="main" data-app-versions="main,dev" nonce="([^"]+)" src="\/__xo\/toolbar\/loader\.js"><\/script>\n$/.exec(through.body);
		assert.ok(tag, "the loader tag ends the document");
		const csp = through.headers["content-security-policy"];
		assert.match(csp, /'strict-dynamic'/);
		assert.ok(csp.includes(`'nonce-${tag[1]}'`), "the page's CSP trusts the tag's nonce");
		assert.doesNotMatch(csp, /frame-ancestors/);

		// Everything before the tag is the page exactly as its server sent it, apart from its own per-response nonce.
		const withoutNonces = (text) => text.replace(/nonce="[^"]+"/g, 'nonce=""');
		assert.equal(withoutNonces(through.body.slice(0, tag.index - 1)), withoutNonces(direct.body));
	});

	test("leaves pages alone when asked, and never touches stylesheets", async () => {
		const skipped = await get("acme", "/", { ...HTML, "x-xo-skip-toolbar": "1" });
		assert.doesNotMatch(skipped.body, /data-xo-toolbar/);
		assert.equal(skipped.headers["x-frame-options"], "DENY");

		const css = await get("acme", "/styles.css", { accept: "text/css", "sec-fetch-dest": "style" });
		assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
		assert.doesNotMatch(css.body, /data-xo-toolbar/);
	});

	test("serves the loader and the app from each app's own origin", async () => {
		const loader = await get("other", "/__xo/toolbar/loader.js");
		assert.equal(loader.status, 200);
		assert.match(loader.body, /document\.currentScript/);
		const app = await get("acme", "/__xo/toolbar/app.js");
		assert.match(app.body, /^var XoToolbarSchema = /);
		assert.match(app.body, /var XoNodeId/);
		assert.match(app.body, /window\.initXoToolbar/);
		assert.equal((await get("acme", "/__xo/toolbar/../package.json")).status, 404);
		assert.equal((await get("acme", "/__xo/toolbar/ui.js")).status, 404);
	});
});

describe("each app's toolbar API", () => {
	test("threads belong to one app: another app can't list, reply to or resolve them", async () => {
		const created = await send("acme", "POST", "/__xo/api/threads", {
			nodeId: '[data-testid="plan-team"]>button',
			anchor: { tag: "button", textQuote: "Start a trial", offsetX: 1, offsetY: 0 },
			page: "/pricing",
			text: "Make this the default plan",
		});
		assert.equal(created.status, 201);
		const { thread } = created.json;
		assert.equal(thread.target, "acme");

		assert.equal((await send("acme", "GET", "/__xo/api/threads?page=%2Fpricing")).json.threads.length, 1);
		assert.equal((await send("other", "GET", "/__xo/api/threads?page=%2Fpricing")).json.threads.length, 0);
		assert.equal((await send("other", "POST", `/__xo/api/threads/${thread.id}/comments`, { text: "hijack" })).status, 404);
		assert.equal((await send("other", "PATCH", `/__xo/api/threads/${thread.id}`, { status: "resolved" })).status, 404);

		const replied = await send("acme", "POST", `/__xo/api/threads/${thread.id}/comments`, { text: "Agreed" });
		assert.equal(replied.json.thread.comments.length, 2);
		const resolved = await send("acme", "PATCH", `/__xo/api/threads/${thread.id}`, { status: "resolved" });
		assert.equal(resolved.json.thread.status, "resolved");
	});

	test("records ask-the-agent requests with the app they came from", async () => {
		const sent = await send("acme", "POST", "/__xo/api/agent", {
			ask: "Make this button larger",
			element: { kind: "xo.element/v1", page: "/", nodeId: "#trial", tag: "button" },
		});
		assert.equal(sent.status, 202);
		const lines = readFileSync(path.join(dataDir, "agent-requests.jsonl"), "utf8").trim().split("\n");
		const entry = JSON.parse(lines.at(-1));
		assert.equal(entry.ask, "Make this button larger");
		assert.equal(entry.target, "acme");
	});

	test("lists the gateway's apps for the switcher, but can't change them", async () => {
		const listed = await send("other", "GET", "/__xo/api/targets");
		assert.equal(listed.json.current, "other");
		const byName = Object.fromEntries(listed.json.targets.map((target) => [target.name, target]));
		assert.equal(byName.acme.url, `http://acme.localhost:${port}/`);
		assert.equal(byName.acme.up, true);
		assert.equal(byName.down.up, false);

		assert.equal((await send("other", "POST", "/__xo/api/targets", { name: "evil", upstream: "1" })).status, 404);
		assert.equal((await send("other", "DELETE", "/__xo/api/targets/acme")).status, 404);
	});

	test("rejects missing fields and requests from other sites", async () => {
		assert.equal((await send("acme", "POST", "/__xo/api/threads", { page: "/" })).status, 400);
		const foreign = await send("acme", "GET", "/__xo/api/threads", undefined, { "sec-fetch-site": "same-site" });
		assert.equal(foreign.status, 403);
	});
});

describe("screenshots and recordings", () => {
	const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a0b93e5c0000000049454e44ae426082", "hex");

	test("an upload is stored for its app and served back from that app's origin, with byte ranges", async () => {
		const created = await upload("acme", PNG, "image/png");
		assert.equal(created.status, 201);
		const { upload: stored } = created.json;
		assert.match(stored.id, /^u_[a-z0-9]+$/);
		assert.equal(stored.kind, "image");
		assert.equal(stored.size, PNG.length);
		assert.equal(stored.path, undefined, "the page never learns where the file sits");

		const whole = await get("acme", stored.url);
		assert.equal(whole.status, 200);
		assert.equal(whole.headers["content-type"], "image/png");
		assert.equal(whole.headers["accept-ranges"], "bytes");

		const part = await get("acme", stored.url, { range: "bytes=0-7" });
		assert.equal(part.status, 206);
		assert.equal(part.headers["content-range"], `bytes 0-7/${PNG.length}`);
		assert.equal(Number(part.headers["content-length"]), 8);
		assert.equal((await get("acme", stored.url, { range: "bytes=9999-" })).status, 416);

		assert.equal((await get("other", stored.url)).status, 404, "another app can't read it");
		assert.equal((await send("other", "DELETE", `/__xo/api/uploads/${stored.id}`)).status, 404, "or delete it");
		assert.equal((await send("acme", "DELETE", `/__xo/api/uploads/${stored.id}`)).status, 200);
		assert.equal((await get("acme", stored.url)).status, 404);
	});

	test("only images and videos are accepted, and never empty", async () => {
		assert.equal((await upload("acme", Buffer.from("<script>alert(1)</script>"), "text/html")).status, 415);
		assert.equal((await upload("acme", Buffer.alloc(0), "image/png")).status, 400);
		assert.equal((await upload("acme", PNG, "image/png", { "sec-fetch-site": "cross-site" })).status, 403);
	});

	test("comments carry captures, and a comment can be about the whole page", async () => {
		const { upload: shot } = (await upload("acme", PNG, "image/png")).json;
		const created = await send("acme", "POST", "/__xo/api/threads", { page: "/about", text: "Header overlaps", attachments: [shot.id] });
		assert.equal(created.status, 201);
		const { thread } = created.json;
		assert.equal(thread.nodeId, "");
		assert.deepEqual(thread.comments[0].attachments.map((item) => item.id), [shot.id]);
		assert.equal(thread.comments[0].attachments[0].path, undefined);

		const { upload: foreign } = (await upload("other", PNG, "image/png")).json;
		const refused = await send("acme", "POST", `/__xo/api/threads/${thread.id}/comments`, { text: "theirs", attachments: [foreign.id] });
		assert.equal(refused.status, 400, "an app can't attach another app's upload");
		assert.equal((await send("acme", "POST", "/__xo/api/threads", { page: "/", text: "x", attachments: "u_1" })).status, 400);
	});

	test("the agent gets captures as files on this machine, with the page's logs and environment", async () => {
		const { upload: clip } = (await upload("acme", Buffer.from("1a45dfa3", "hex"), "video/webm")).json;
		assert.equal(clip.kind, "video");
		const sent = await send("acme", "POST", "/__xo/api/agent", {
			ask: "",
			page: "/pricing",
			attachments: [clip.id],
			logs: [{ kind: "network", level: "error", message: "500 fetch /api/plans", status: 500 }],
			environment: { viewport: { width: 1280, height: 800 }, userAgent: "test" },
		});
		assert.equal(sent.status, 202);
		const entry = lastAgentRequest();
		assert.equal(entry.page, "/pricing");
		assert.equal(entry.attachments[0].kind, "video");
		assert.ok(entry.attachments[0].path.startsWith(path.join(dataDir, "uploads", "acme")), "the agent can open the file");
		assert.equal(entry.logs[0].status, 500);
		assert.equal(entry.environment.viewport.width, 1280);
		assert.equal((await send("acme", "POST", "/__xo/api/agent", { ask: "  " })).status, 400);
	});
});

describe("toolbar designs", () => {
	test("an app starts with the built-in design; saving gives it its own, tidied by the toolbar's schema", async () => {
		const first = await send("other", "GET", "/__xo/api/toolbar");
		assert.equal(first.json.source, "built-in");
		assert.equal(first.json.isDefault, true);
		assert.ok(first.json.options.tools.includes("screenshot"));

		const saved = await send("other", "PUT", "/__xo/api/toolbar", {
			dock: { position: "top-right", labels: false },
			items: [{ type: "inspect" }, { type: "inspect" }, { type: "link", label: "Docs", href: "javascript:alert(1)" }, { type: "record" }],
		});
		assert.equal(saved.status, 200);
		assert.equal(saved.json.source, "app");
		assert.deepEqual(saved.json.layout.items, [{ type: "inspect" }, { type: "record" }]);
		assert.equal(saved.json.layout.dock.position, "top-right");
		assert.equal((await send("other", "GET", "/__xo/api/toolbar")).json.source, "app");
		const file = JSON.parse(readFileSync(path.join(dataDir, "toolbars", "other.json"), "utf8"));
		assert.equal(file.dock.position, "top-right");

		const reset = await send("other", "DELETE", "/__xo/api/toolbar");
		assert.equal(reset.json.source, "built-in");
	});

	test("the launcher sets the gateway's default design, which every app without its own gets", async () => {
		const accent = "#ff8a3d";
		const saved = await send(null, "PUT", "/__xo/api/toolbars/_default", { theme: { accent }, items: [{ type: "screenshot" }, { type: "logs" }] });
		assert.equal(saved.status, 200);
		assert.equal(saved.json.source, "gateway");

		const inherited = await send("acme", "GET", "/__xo/api/toolbar");
		assert.equal(inherited.json.source, "gateway");
		assert.equal(inherited.json.layout.theme.accent, accent);

		await send(null, "PUT", "/__xo/api/toolbars/acme", { dock: { position: "bottom-left" }, items: [{ type: "comment" }] });
		const listed = (await send(null, "GET", "/__xo/api/toolbars")).json;
		assert.equal(listed.default.source, "gateway");
		const byName = Object.fromEntries(listed.apps.map((app) => [app.name, app]));
		assert.equal(byName.acme.source, "app");
		assert.equal(byName.acme.url, `http://acme.localhost:${port}/`);
		assert.equal(byName.other.source, "gateway");

		assert.equal((await send(null, "DELETE", "/__xo/api/toolbars/acme")).json.source, "gateway");
		assert.equal((await send(null, "DELETE", "/__xo/api/toolbars/_default")).json.source, "built-in");
		assert.equal((await send("acme", "GET", "/__xo/api/toolbar")).json.source, "built-in");
	});

	test("only the launcher edits other apps' designs, and only for apps it knows", async () => {
		assert.equal((await send("acme", "PUT", "/__xo/api/toolbars/other", { items: [] })).status, 404, "an app's host has no such route");
		assert.equal((await send("acme", "GET", "/__xo/api/toolbars")).status, 404);
		assert.equal((await send(null, "PUT", "/__xo/api/toolbars/ghost", { items: [] })).status, 404);
		assert.equal((await send(null, "PUT", "/__xo/api/toolbars/_default", { items: [] }, { "sec-fetch-site": "same-site" })).status, 403);
		const form = await request("PUT", `http://127.0.0.1:${port}/__xo/api/toolbars/_default`, undefined, {
			host: host(null),
			"content-type": "text/plain",
		}, "{}");
		assert.equal(form.status, 415);
	});

	test("the launcher serves the toolbar's design editor from the toolbar project", async () => {
		const editor = await get(null, "/__xo/toolbar/designer.js");
		assert.equal(editor.status, 200);
		assert.match(editor.body, /var XoDesigner/);
		assert.doesNotMatch(editor.body, /initXoToolbar/);
	});
});

describe("versions", () => {
	test("each version has its own host, and the app's own host is its default version", async () => {
		const live = await get("acme", "/pricing", HTML);
		const dev = await get("dev.acme", "/pricing", HTML);
		const main = await get("main.acme", "/pricing", HTML);
		assert.doesNotMatch(live.body, /build-note/);
		assert.match(dev.body, /Dev build: changes not yet live/);
		assert.match(dev.body, /<span class="amount">\$9<\/span>/);
		assert.match(dev.body, /data-app-version="dev" data-app-versions="main,dev"/);
		assert.match(main.body, /data-app-version="main"/);
	});

	test("on the app's own host, a page path starting with a version goes to that version's host", async () => {
		const picked = await get("acme", "/dev/pricing?plan=team", PAGE);
		assert.equal(picked.status, 302);
		assert.equal(picked.headers.location, `http://dev.acme.localhost:${port}/pricing?plan=team`);
		assert.equal((await get("acme", "/main", PAGE)).headers.location, `http://main.acme.localhost:${port}/`);

		const fetched = await get("acme", "/dev/pricing", { accept: "*/*", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
		assert.equal(fetched.status, 404, "a fetch is the app's own request, never redirected");
		const onVersionHost = await get("dev.acme", "/main", PAGE);
		assert.equal(onVersionHost.status, 404, "a version host passes every path to its app");
		assert.equal((await get("acme", "/devtools", PAGE)).status, 404);
	});

	test("an unknown version lists the real ones instead of serving another", async () => {
		const page = await get("beta.acme", "/", HTML);
		assert.equal(page.status, 404);
		assert.match(page.body, /acme has no version called “beta”/);
		assert.match(page.body, new RegExp(`http://dev\\.acme\\.localhost:${port}/`));
		const api = await get("beta.acme", "/x", { accept: "application/json" });
		assert.equal(JSON.parse(api.body).error, 'acme has no version called "beta"');
		assert.equal((await get("x.dev.acme", "/", HTML)).status, 404);
	});

	test("hot-reload WebSockets go to the version the host names", async () => {
		assert.equal(await websocketEcho("canary.other", "ping"), "ping");
	});

	test("comments belong to the app and remember their version; the agent hears which version was seen", async () => {
		const created = await send("dev.acme", "POST", "/__xo/api/threads", { page: "/versions-test", text: "New price looks off" });
		assert.equal(created.json.thread.version, "dev");
		const listed = await send("acme", "GET", "/__xo/api/threads?page=%2Fversions-test");
		assert.equal(listed.json.threads.length, 1, "the same comment shows on every version of the app");

		await send("dev.acme", "POST", "/__xo/api/agent", { ask: "Revert the Team price", page: "/pricing" });
		const entry = lastAgentRequest();
		assert.equal(entry.version, "dev");
		assert.equal(entry.upstream, sampleDevBase);
	});

	test("the switcher lists every app's versions with their addresses", async () => {
		const listed = await send("dev.acme", "GET", "/__xo/api/targets");
		assert.equal(listed.json.current, "acme");
		assert.equal(listed.json.currentVersion, "dev");
		const acme = listed.json.targets.find((target) => target.name === "acme");
		assert.equal(acme.defaultVersion, "main");
		assert.deepEqual(acme.versions.map((version) => [version.name, version.url, version.up]), [
			["main", `http://main.acme.localhost:${port}/`, true],
			["dev", `http://dev.acme.localhost:${port}/`, true],
		]);
	});

	test("the launcher adds a version, makes it the default, and removes it; an app keeps at least one", async () => {
		const added = await send(null, "POST", "/__xo/api/targets", { name: "acme", version: "beta", upstream: String(other.address().port) });
		assert.equal(added.status, 201);
		assert.match((await get("beta.acme", "/", HTML)).body, /Other app/);

		const made = await send(null, "PATCH", "/__xo/api/targets/acme", { defaultVersion: "beta" });
		assert.equal(made.json.target.defaultVersion, "beta");
		assert.match((await get("acme", "/", HTML)).body, /Other app/, "the app's own host now serves beta");
		assert.equal((await send(null, "PATCH", "/__xo/api/targets/acme", { defaultVersion: "nope" })).status, 400);

		const removed = await send(null, "DELETE", "/__xo/api/targets/acme/versions/beta");
		assert.equal(removed.status, 200);
		assert.equal(removed.json.target.defaultVersion, "main");
		assert.equal((await get("beta.acme", "/", HTML)).status, 404);
		assert.equal((await send(null, "DELETE", "/__xo/api/targets/down/versions/main")).status, 400);
		assert.equal((await send("acme", "DELETE", "/__xo/api/targets/acme/versions/dev")).status, 404, "an app's host can't change versions");
	});
});

describe("the launcher", () => {
	test("adds an app that is then reachable by name, and removes it again", async () => {
		const added = await send(null, "POST", "/__xo/api/targets", { name: "Docs", upstream: String(other.address().port) });
		assert.equal(added.status, 201);
		assert.equal(added.json.target.url, `http://docs.localhost:${port}/`);
		assert.match((await get("docs", "/", HTML)).body, /Other app/);

		const saved = JSON.parse(readFileSync(path.join(dataDir, "targets.json"), "utf8"));
		assert.ok(saved.targets.some((target) => target.name === "docs"));

		assert.equal((await send(null, "DELETE", "/__xo/api/targets/docs")).status, 200);
		assert.equal((await get("docs", "/", HTML)).status, 404);
	});

	test("accepts changes only as JSON from its own origin, with valid names", async () => {
		assert.equal((await send(null, "POST", "/__xo/api/targets", { name: "bad_name", upstream: "3000" })).status, 400);
		assert.equal((await send(null, "POST", "/__xo/api/targets", { name: "x", upstream: "3000" }, { "sec-fetch-site": "same-site" })).status, 403);
		const form = await request("POST", `http://127.0.0.1:${port}/__xo/api/targets`, undefined, {
			host: host(null),
			"content-type": "application/x-www-form-urlencoded",
		}, "name=x&upstream=3000");
		assert.equal(form.status, 415);
	});
});

function upload(name, body, type, headers = {}) {
	return request("POST", `http://127.0.0.1:${port}/__xo/api/uploads`, undefined, {
		host: host(name),
		"sec-fetch-site": "same-origin",
		"content-type": type,
		...headers,
	}, body).then((response) => ({ ...response, json: JSON.parse(response.body || "{}") }));
}

function lastAgentRequest() {
	const lines = readFileSync(path.join(dataDir, "agent-requests.jsonl"), "utf8").trim().split("\n");
	return JSON.parse(lines.at(-1));
}

function listen(server) {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function get(name, route, headers = {}) {
	return request("GET", `http://127.0.0.1:${port}${route}`, undefined, { host: host(name), ...headers });
}

async function send(name, method, route, body, headers = {}) {
	const response = await request(method, `http://127.0.0.1:${port}${route}`, body, {
		host: host(name),
		"sec-fetch-site": "same-origin",
		...headers,
	});
	return { ...response, json: JSON.parse(response.body || "{}") };
}

function request(method, url, body, headers = {}, raw) {
	return new Promise((resolve, reject) => {
		const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
		const contentType = raw === undefined && payload ? { "content-type": "application/json" } : {};
		const req = http.request(url, { method, headers: { ...contentType, ...headers } }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end(payload);
	});
}

function websocketEcho(name, message) {
	return new Promise((resolve, reject) => {
		const req = http.request(`http://127.0.0.1:${port}/_next/hmr`, {
			headers: { host: host(name), connection: "Upgrade", upgrade: "websocket" },
		});
		req.on("upgrade", (_res, socket) => {
			socket.once("data", (data) => {
				resolve(data.toString());
				socket.destroy();
			});
			socket.write(message);
		});
		req.on("error", reject);
		req.end();
	});
}
