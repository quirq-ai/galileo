/**
 * Naming apps and their versions, and routing a request to one by its Host
 * header or, on an app's own host, by the first part of its path. `npm test`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
	DEFAULT_VERSION,
	appUrl,
	createRegistry,
	isValidName,
	normalizeUpstream,
	ownsRequest,
	parseTargetSpec,
	portOf,
	routeForHost,
	versionPick,
} from "../src/targets.mjs";

describe("names", () => {
	test("are DNS labels: lowercase letters, digits and inner dashes", () => {
		for (const name of ["acme", "xo", "docs-v2", "a", "app1"]) assert.equal(isValidName(name), true, name);
		for (const name of ["", "Acme", "-acme", "acme-", "my_app", "a.b", "x".repeat(41)]) assert.equal(isValidName(name), false, name);
	});
});

describe("upstreams", () => {
	test("take a port, a host and port, or a URL", () => {
		assert.equal(normalizeUpstream("3000"), "http://localhost:3000");
		assert.equal(normalizeUpstream("127.0.0.1:4173"), "http://127.0.0.1:4173");
		assert.equal(normalizeUpstream("https://app-git-main-team.vercel.app/some/path"), "https://app-git-main-team.vercel.app");
	});

	test("refuse anything that isn't http(s)", () => {
		assert.throws(() => normalizeUpstream("ftp://example.com"), /http\(s\)/);
		assert.throws(() => normalizeUpstream("not a url"), /not a port/);
	});

	test("come from specs on the command line that read like the address they create", () => {
		assert.deepEqual(parseTargetSpec("xo=3000"), { name: "xo", upstream: "http://localhost:3000" });
		assert.deepEqual(parseTargetSpec("Docs=localhost:5173"), { name: "docs", upstream: "http://localhost:5173" });
		assert.deepEqual(parseTargetSpec("dev.acme=5173"), { name: "acme", version: "dev", upstream: "http://localhost:5173" });
		assert.deepEqual(parseTargetSpec("live.acme=https://acme.vercel.app"), { name: "acme", version: "live", upstream: "https://acme.vercel.app" });
		assert.throws(() => parseTargetSpec("3000"), /name=port/);
		assert.throws(() => parseTargetSpec("my_app=3000"), /can't be an app name/);
		assert.throws(() => parseTargetSpec("dev_1.acme=3000"), /can't be a version name/);
		assert.throws(() => parseTargetSpec("a.b.acme=3000"), /too many parts/);
	});
});

describe("routing by Host", () => {
	const acme = {
		name: "acme",
		defaultVersion: "dev",
		versions: [{ name: "live", upstream: "l" }, { name: "dev", upstream: "d" }],
	};
	const xo = { name: "xo", defaultVersion: DEFAULT_VERSION, versions: [{ name: DEFAULT_VERSION, upstream: "x" }] };
	const apps = new Map([["acme", acme], ["xo", xo]]);
	const lookup = (name) => apps.get(name);

	test("an app's own host is its default version", () => {
		assert.deepEqual(routeForHost("acme.localhost:4100", lookup), { kind: "app", target: acme, version: acme.versions[1], versionHost: false });
		assert.equal(routeForHost("XO.LOCALHOST:4100", lookup).version.name, DEFAULT_VERSION);
	});

	test("a version's host is that version", () => {
		assert.deepEqual(routeForHost("live.acme.localhost:4100", lookup), { kind: "app", target: acme, version: acme.versions[0], versionHost: true });
		assert.equal(routeForHost("DEV.ACME.localhost", lookup).version.name, "dev");
	});

	test("the bare host is the launcher", () => {
		for (const host of ["localhost:4100", "127.0.0.1:4100", "[::1]:4100", "localhost"]) {
			assert.deepEqual(routeForHost(host, lookup), { kind: "launcher" }, host);
		}
	});

	test("an unregistered name or version is unknown, never another app or version", () => {
		assert.deepEqual(routeForHost("docs.localhost:4100", lookup), { kind: "unknown", name: "docs" });
		assert.deepEqual(routeForHost("beta.acme.localhost:4100", lookup), { kind: "unknown-version", target: acme, name: "beta" });
		assert.deepEqual(routeForHost("dev.docs.localhost:4100", lookup), { kind: "unknown", name: "docs" });
		assert.deepEqual(routeForHost("a.dev.acme.localhost:4100", lookup), { kind: "unknown", name: "a.dev.acme" });
		assert.deepEqual(routeForHost("example.com", lookup), { kind: "unknown", name: "example.com" });
	});

	test("addresses and ports", () => {
		assert.equal(appUrl("acme", 4100), "http://acme.localhost:4100/");
		assert.equal(appUrl("acme", 4100, "dev"), "http://dev.acme.localhost:4100/");
		assert.equal(portOf("acme.localhost:4100", 1), 4100);
		assert.equal(portOf("localhost", 80), 80);
	});
});

describe("picking a version by path", () => {
	const acme = { name: "acme", defaultVersion: "dev", versions: [{ name: "dev" }, { name: "live" }] };
	const own = { kind: "app", target: acme, version: acme.versions[0], versionHost: false };
	const page = { "sec-fetch-mode": "navigate", accept: "text/html" };
	const pick = (url, { route = own, method = "GET", headers = page } = {}) => versionPick({ method, url, headers }, route, 4100);

	test("a page address starting with a version goes to that version's host, keeping the rest", () => {
		assert.equal(pick("/live"), "http://live.acme.localhost:4100/");
		assert.equal(pick("/live/"), "http://live.acme.localhost:4100/");
		assert.equal(pick("/live/pricing?plan=team"), "http://live.acme.localhost:4100/pricing?plan=team");
		assert.equal(pick("/dev/docs/a/b"), "http://dev.acme.localhost:4100/docs/a/b");
		assert.equal(pick("/live", { headers: { accept: "text/html,*/*" } }), "http://live.acme.localhost:4100/", "without Sec-Fetch headers, by Accept");
	});

	test("anything else is the app's own: other paths, fetches, posts, and every path on a version host", () => {
		assert.equal(pick("/livestream"), null);
		assert.equal(pick("/pricing"), null);
		assert.equal(pick("/Live"), null);
		assert.equal(pick("/live/data.json", { headers: { "sec-fetch-mode": "cors", accept: "*/*" } }), null);
		assert.equal(pick("/live", { method: "POST" }), null);
		assert.equal(pick("/live", { route: { ...own, versionHost: true } }), null);
	});
});

describe("the registry", () => {
	test("saves additions, and the command line wins over what was saved", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "xo-targets-"));
		try {
			const first = createRegistry({ dataDir: dir, initial: [{ name: "acme", upstream: "4173" }] });
			first.add({ name: "docs", upstream: "5173" });
			assert.deepEqual(first.list().map((target) => target.name), ["acme", "docs"]);

			const second = createRegistry({ dataDir: dir, initial: [{ name: "docs", upstream: "6006" }] });
			assert.equal(second.get("acme").versions[0].upstream.origin, "http://localhost:4173");
			assert.equal(second.get("docs").versions[0].upstream.origin, "http://localhost:6006");

			assert.equal(second.remove("acme"), true);
			const saved = JSON.parse(readFileSync(path.join(dir, "targets.json"), "utf8"));
			assert.deepEqual(saved.targets.map((target) => target.name), ["docs"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an app has named versions; the first is its default, and a chosen default is kept", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "xo-targets-"));
		try {
			const initial = [
				{ name: "acme", version: "dev", upstream: "5173" },
				{ name: "acme", version: "live", upstream: "https://acme.vercel.app" },
			];
			const first = createRegistry({ dataDir: dir, initial });
			const acme = first.get("acme");
			assert.deepEqual(acme.versions.map((version) => version.name), ["dev", "live"]);
			assert.equal(acme.defaultVersion, "dev");

			assert.equal(first.add({ name: "acme", version: "pr-12", upstream: "5174" }).isNew, true);
			assert.equal(first.add({ name: "acme", upstream: "5175" }).version.name, "dev", "no version name: the default version is updated");
			assert.equal(first.setDefault("acme", "live"), true);
			assert.equal(first.setDefault("acme", "nope"), false);

			const second = createRegistry({ dataDir: dir, initial });
			assert.equal(second.get("acme").defaultVersion, "live", "the launcher's choice survives a restart");
			assert.equal(second.get("acme").versions.find((version) => version.name === "dev").upstream.origin, "http://localhost:5173", "the command line wins");
			assert.deepEqual(second.get("acme").versions.map((version) => version.name), ["dev", "live", "pr-12"]);

			assert.equal(second.removeVersion("acme", "live"), true);
			assert.equal(second.get("acme").defaultVersion, "dev", "removing the default hands it to the next version");
			second.removeVersion("acme", "pr-12");
			assert.throws(() => second.removeVersion("acme", "dev"), /at least one version/);
			assert.equal(second.removeVersion("acme", "gone"), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an app saved before versions existed becomes one main version", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "xo-targets-"));
		try {
			writeFileSync(path.join(dir, "targets.json"), JSON.stringify({ targets: [{ name: "acme", upstream: "http://127.0.0.1:4173" }] }));
			const registry = createRegistry({ dataDir: dir });
			assert.equal(registry.get("acme").defaultVersion, DEFAULT_VERSION);
			assert.equal(registry.get("acme").versions[0].upstream.origin, "http://127.0.0.1:4173");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sharing a port with another app", () => {
	test("every *.localhost host is the gateway's, registered or not", () => {
		for (const host of ["acme.localhost:3000", "dev.acme.localhost:3000", "nobody.localhost:3000", "ACME.localhost"]) {
			assert.equal(ownsRequest(host, "/"), true, host);
		}
	});

	test("on the bare host only /__xo/* is the gateway's; pages and Next.js files are the other app's", () => {
		for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
			assert.equal(ownsRequest(host, "/__xo/api/targets"), true, host);
			assert.equal(ownsRequest(host, "/__xo/toolbar/designer.js"), true, host);
			assert.equal(ownsRequest(host, "/"), false, host);
			assert.equal(ownsRequest(host, "/launcher"), false, host);
			assert.equal(ownsRequest(host, "/__xo/home/home.js"), true, host);
			assert.equal(ownsRequest(host, "/_next/static/chunk.js"), false, host);
			assert.equal(ownsRequest(host, "/__xoo"), false, host);
		}
	});

	test("any other hostname, and a missing Host, is the other app's", () => {
		assert.equal(ownsRequest("192.168.1.20:3000", "/__xo/api/targets"), false);
		assert.equal(ownsRequest("example.com", "/"), false);
		assert.equal(ownsRequest("localhost.example.com", "/"), false);
		assert.equal(ownsRequest(undefined, "/__xo/api/targets"), false);
	});
});
