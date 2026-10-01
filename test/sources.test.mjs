/**
 * Sources: names, where a source is, which source a Host means, and the list
 * galileo keeps. `npm test`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { createSources, galileoOrigins, isValidName, parseLocation, parseSourceSpec, routeForHost, sourceUrl } from "../src/sources.mjs";

const HOME = "/Users/me";

describe("names", () => {
	test("are DNS labels: lowercase letters, digits and inner dashes", () => {
		for (const name of ["acme", "web-2", "a", "x".repeat(40)]) assert.equal(isValidName(name), true, name);
		for (const name of ["", "Acme", "-web", "web-", "a.b", "x".repeat(41), "web_2", undefined]) assert.equal(isValidName(name), false, String(name));
	});
});

describe("where a source is", () => {
	test("a number, or a local address with a port, is a port of this machine", () => {
		assert.deepEqual(parseLocation("5173"), { type: "port", port: 5173 });
		assert.deepEqual(parseLocation(" localhost:3000 "), { type: "port", port: 3000 });
		assert.deepEqual(parseLocation("http://127.0.0.1:8080/"), { type: "port", port: 8080 });
		assert.deepEqual(parseLocation("http://[::1]:9000"), { type: "port", port: 9000 });
	});

	test("ports must be real ones, and other machines are refused", () => {
		for (const value of ["0", "65536", "99999"]) assert.throws(() => parseLocation(value), /not a port/);
		for (const value of ["https://acme.vercel.app", "example.com:80", "ftp://localhost/x"]) {
			assert.throws(() => parseLocation(value), /not on this machine/, value);
		}
		assert.throws(() => parseLocation(""), /Give a port/);
	});

	test("anything else is a file or a folder, by its full path", () => {
		assert.deepEqual(parseLocation("~", { home: HOME }), { type: "files", path: HOME });
		assert.deepEqual(parseLocation("~/notes/", { home: HOME }), { type: "files", path: `${HOME}/notes/` });
		assert.deepEqual(parseLocation("/tmp/../var/report.html"), { type: "files", path: "/var/report.html" });
		assert.deepEqual(parseLocation("./site", { cwd: "/work" }), { type: "files", path: "/work/site" });
	});

	test("the sources API takes full paths only, since galileo's own folder means nothing to the person typing", () => {
		assert.throws(() => parseLocation("notes", { relative: false }), /full path/);
		assert.deepEqual(parseLocation("~/notes", { relative: false, home: HOME }), { type: "files", path: `${HOME}/notes` });
	});

	test("command-line sources read name=where", () => {
		assert.deepEqual(parseSourceSpec("acme=5173"), { name: "acme", type: "port", port: 5173 });
		assert.deepEqual(parseSourceSpec("Notes=~/notes", { home: HOME }), { name: "notes", type: "files", path: `${HOME}/notes` });
		assert.throws(() => parseSourceSpec("5173"), /name=port/);
		assert.throws(() => parseSourceSpec("my_app=5173"), /can't be a source name/);
	});
});

describe("which source a Host means", () => {
	const lookup = (name) => ({ acme: { name: "acme", type: "port", port: 5173 } })[name];

	test("galileo's own host is galileo's, whatever the port", () => {
		for (const host of ["localhost:4100", "127.0.0.1:4100", "[::1]:4100", "LOCALHOST", undefined]) {
			assert.equal(routeForHost(host, lookup).kind, "galileo", String(host));
		}
	});

	test("a source's name under .localhost is that source", () => {
		const route = routeForHost("acme.localhost:4100", lookup);
		assert.equal(route.kind, "source");
		assert.equal(route.source.name, "acme");
	});

	test("a name nobody added is unknown, and never falls through to another source", () => {
		assert.deepEqual(routeForHost("beta.localhost:4100", lookup), { kind: "unknown", name: "beta" });
		assert.deepEqual(routeForHost("dev.acme.localhost:4100", lookup), { kind: "unknown", name: "dev.acme" });
	});

	test("any other host is foreign: a page elsewhere that points its own name at this machine", () => {
		assert.deepEqual(routeForHost("example.com", lookup), { kind: "foreign", host: "example.com" });
		assert.deepEqual(routeForHost("acme.localhost.evil.example:4100", lookup), { kind: "foreign", host: "acme.localhost.evil.example" });
	});

	test("addresses, and the origins that may frame a source", () => {
		assert.equal(sourceUrl("acme", 4100), "http://acme.localhost:4100/");
		assert.deepEqual(galileoOrigins(4100), ["http://localhost:4100", "http://127.0.0.1:4100"]);
	});
});

describe("the list galileo keeps", () => {
	test("saves what is added and removed, and loads it again", () => {
		const dataDir = mkdtempSync(path.join(tmpdir(), "galileo-sources-"));
		try {
			const first = createSources({ dataDir });
			assert.equal(first.add({ name: "acme", type: "port", port: 5173 }).isNew, true);
			first.add({ name: "notes", type: "files", path: "/Users/me/notes" });
			assert.equal(first.add({ name: "acme", type: "port", port: 5174 }).isNew, false);
			assert.equal(first.remove("missing"), false);

			const again = createSources({ dataDir });
			assert.deepEqual(
				again.list().map((source) => [source.name, source.port ?? source.path]),
				[
					["acme", 5174],
					["notes", "/Users/me/notes"],
				],
			);
			assert.equal(again.remove("acme"), true);
			assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, "sources.json"), "utf8")).sources, [
				{ name: "notes", type: "files", path: "/Users/me/notes" },
			]);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("the command line wins over what was saved, and saved entries that no longer make sense are dropped", () => {
		const dataDir = mkdtempSync(path.join(tmpdir(), "galileo-sources-"));
		try {
			writeFileSync(
				path.join(dataDir, "sources.json"),
				JSON.stringify({
					sources: [
						{ name: "acme", type: "port", port: 3000 },
						{ name: "Bad Name", type: "port", port: 1 },
						{ name: "relative", type: "files", path: "notes" },
						{ name: "nowhere", type: "port", port: 70000 },
					],
				}),
			);
			const sources = createSources({ dataDir, initial: [{ name: "acme", type: "port", port: 5173 }] });
			assert.deepEqual(sources.list(), [{ name: "acme", type: "port", port: 5173 }]);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test("refuses bad names, ports and paths", () => {
		const dataDir = mkdtempSync(path.join(tmpdir(), "galileo-sources-"));
		try {
			const sources = createSources({ dataDir });
			assert.throws(() => sources.add({ name: "-x", type: "port", port: 1 }), /can't be a source name/);
			assert.throws(() => sources.add({ name: "x", type: "port", port: 0 }), /needs a port or a full path/);
			assert.throws(() => sources.add({ name: "x", type: "files", path: "relative" }), /needs a port or a full path/);
			assert.throws(() => sources.add({ name: "x", type: "folder", path: "/tmp" }), /needs a port or a full path/);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
