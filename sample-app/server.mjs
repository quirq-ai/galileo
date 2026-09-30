#!/usr/bin/env node
/**
 * Acme Notes, a small three-page site used to show the gateway at work.
 * `createSampleApp({ build: "dev" })` serves the same site with unreleased
 * changes (a note on every page, a new Team price), to stand in for a second
 * version of the app.
 *
 * It sends the headers a careful production app sends: `X-Frame-Options:
 * DENY` and a Content Security Policy that trusts scripts only by a
 * per-response nonce with 'strict-dynamic'. That is the hardest case for an
 * injected toolbar, and the one Vercel's injected script once failed on.
 *
 *   node sample-app/server.mjs --port 4173
 */
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
};

/** What the dev build changes: text only, so both builds share one set of files. */
const DEV_CHANGES = [
	["<main", '<p class="build-note" data-testid="build-note">Dev build: changes not yet live</p>\n\t\t<main'],
	['<span class="amount">$8</span>', '<span class="amount">$9</span>'],
	["</title>", " (dev)</title>"],
];

export function createSampleApp({ build = "live" } = {}) {
	return http.createServer(async (req, res) => {
		const { pathname } = new URL(req.url, "http://sample");
		let file = pathname === "/" ? "/index.html" : pathname;
		if (!path.extname(file)) file += ".html";
		const full = path.join(PUBLIC_DIR, path.normalize(file));
		if (!full.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);

		let body;
		try {
			body = await readFile(full);
		} catch {
			return notFound(res);
		}
		const type = TYPES[path.extname(full)] ?? "application/octet-stream";
		const headers = { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" };
		if (type.startsWith("text/html")) {
			const nonce = randomBytes(16).toString("base64");
			body = body.toString("utf8").replaceAll("{{nonce}}", nonce);
			if (build === "dev") for (const [from, to] of DEV_CHANGES) body = body.replace(from, to);
			Object.assign(headers, pageSecurityHeaders(nonce));
		}
		res.writeHead(200, headers);
		res.end(body);
	});
}

function pageSecurityHeaders(nonce) {
	return {
		"x-frame-options": "DENY",
		"content-security-policy": [
			"default-src 'self'",
			`script-src 'nonce-${nonce}' 'strict-dynamic'`,
			"style-src 'self'",
			"img-src 'self' data:",
			"base-uri 'none'",
			"frame-ancestors 'none'",
		].join("; "),
	};
}

async function notFound(res) {
	const nonce = randomBytes(16).toString("base64");
	res.writeHead(404, { "content-type": "text/html; charset=utf-8", ...pageSecurityHeaders(nonce) });
	res.end(
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found · Acme Notes</title>' +
			'<link rel="stylesheet" href="/styles.css"></head><body><main class="page narrow"><h1>Page not found</h1>' +
			'<p><a href="/">Back to Acme Notes</a></p></main></body></html>',
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { values } = parseArgs({ options: { port: { type: "string" }, build: { type: "string" } } });
	const port = Number(values.port ?? process.env.PORT ?? 4173);
	createSampleApp({ build: values.build }).listen(port, "127.0.0.1", () => {
		console.log(`[sample-app] Acme Notes (${values.build ?? "live"} build) on http://localhost:${port}`);
	});
}
