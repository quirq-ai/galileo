/**
 * The gateway's rules for which responses carry the toolbar and how their
 * security headers change. `npm test`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	loaderTag,
	responseHeaders,
	rewritePolicy,
	rewriteSecurityHeaders,
	shouldInject,
	upstreamRequestHeaders,
} from "../src/inject.mjs";

const page = (headers = {}, extra = {}) => ({
	method: "GET",
	url: "/",
	headers: { accept: "text/html", "sec-fetch-dest": "document", ...headers },
	...extra,
});
const html = (headers = {}, statusCode = 200) => ({
	statusCode,
	headers: { "content-type": "text/html; charset=utf-8", ...headers },
});

describe("which responses carry the toolbar", () => {
	test("a document request answered with HTML", () => {
		assert.equal(shouldInject(page(), html()), true);
		assert.equal(shouldInject(page({ "sec-fetch-dest": "iframe" }), html()), true);
	});

	test("an HTML error page, so the toolbar is there when something breaks", () => {
		assert.equal(shouldInject(page(), html({}, 404)), true);
		assert.equal(shouldInject(page(), html({}, 500)), true);
	});

	test("an older client that sends no Sec-Fetch-Dest but accepts HTML", () => {
		assert.equal(shouldInject({ method: "GET", url: "/", headers: { accept: "text/html" } }, html()), true);
	});

	test("never a fetch, a non-GET, a redirect, a 304, a non-HTML body or a compressed one", () => {
		assert.equal(shouldInject(page({ "sec-fetch-dest": "empty" }), html()), false);
		assert.equal(shouldInject(page({}, { method: "POST" }), html()), false);
		assert.equal(shouldInject(page(), html({}, 302)), false);
		assert.equal(shouldInject(page(), html({}, 304)), false);
		assert.equal(shouldInject(page(), { statusCode: 200, headers: { "content-type": "application/json" } }), false);
		assert.equal(shouldInject(page(), html({ "content-encoding": "gzip" })), false);
	});

	test("never when opted out by header or query, as automated test runs do", () => {
		assert.equal(shouldInject(page({ "x-xo-skip-toolbar": "1" }), html()), false);
		assert.equal(shouldInject(page({}, { url: "/pricing?xo_toolbar=off" }), html()), false);
		assert.equal(shouldInject(page({}, { url: "/pricing?xo_toolbar=on" }), html()), true);
	});
});

describe("security headers", () => {
	test("framing headers go, so XO can frame the page", () => {
		const out = rewriteSecurityHeaders(
			{ "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" },
			"N",
		);
		assert.equal(out["x-frame-options"], undefined);
		assert.doesNotMatch(out["content-security-policy"], /frame-ancestors/);
	});

	test("a nonce policy with 'strict-dynamic' gets the gateway's nonce, the case Vercel's tag once failed on", () => {
		assert.equal(
			rewritePolicy("script-src 'nonce-app' 'strict-dynamic'; style-src 'self'", "N"),
			"script-src 'nonce-app' 'strict-dynamic' 'nonce-N'; style-src 'self'",
		);
	});

	test("a hash policy gets the nonce too", () => {
		assert.match(rewritePolicy("script-src 'sha256-abc'", "N"), /script-src 'sha256-abc' 'nonce-N'/);
	});

	test("an 'unsafe-inline' policy gets 'self' and never a nonce, which would switch its inline scripts off", () => {
		assert.equal(
			rewritePolicy("script-src 'unsafe-inline' https://cdn.example", "N"),
			"script-src 'unsafe-inline' https://cdn.example 'self'",
		);
	});

	test("a policy that already allows 'self' is left alone", () => {
		assert.equal(rewritePolicy("script-src 'self'; connect-src 'self'", "N"), "script-src 'self'; connect-src 'self'");
	});

	test("default-src alone gains explicit script-src, connect-src and media-src instead of being widened", () => {
		assert.equal(
			rewritePolicy("default-src 'none'; img-src 'self'", "N"),
			"default-src 'none'; img-src 'self'; script-src 'nonce-N'; connect-src 'self'; media-src 'self'",
		);
	});

	test("screenshots and recordings shown from the page's own origin: img-src and media-src get 'self'", () => {
		assert.equal(
			rewritePolicy("img-src https://cdn.example data:; media-src 'none'; script-src 'self'", "N"),
			"img-src https://cdn.example data: 'self'; media-src 'self'; script-src 'self'",
		);
		assert.equal(rewritePolicy("img-src *; media-src 'self'", "N"), "img-src *; media-src 'self'");
	});

	test("report-only policies are rewritten the same way, and pages without a policy stay without one", () => {
		const out = rewriteSecurityHeaders({ "content-security-policy-report-only": "script-src 'nonce-a'" }, "N");
		assert.equal(out["content-security-policy-report-only"], "script-src 'nonce-a' 'nonce-N'");
		assert.equal(rewriteSecurityHeaders({ "content-type": "text/html" }, "N")["content-security-policy"], undefined);
	});
});

describe("the tag", () => {
	test("is the counterpart of Vercel's: async, explicit opt-in, ids, nonce, same-origin src", () => {
		assert.equal(
			loaderTag({ nonce: "abc+/=", previewId: "pv_1", project: "acme" }),
			'<script async data-xo-toolbar data-explicit-opt-in="true" data-preview-id="pv_1" data-project="acme" nonce="abc+/=" src="/__xo/toolbar/loader.js"></script>',
		);
	});

	test("escapes attribute values and drops empty ones", () => {
		const tag = loaderTag({ nonce: "", previewId: 'a"b<c', project: "" });
		assert.match(tag, /data-preview-id="a&quot;b&lt;c"/);
		assert.doesNotMatch(tag, /nonce=|data-project=/);
	});
});

describe("passing requests and responses through", () => {
	test("upstream requests get the upstream's host, no compression and no skip header", () => {
		const out = upstreamRequestHeaders(
			{ host: "localhost:4100", "accept-encoding": "gzip, br", connection: "keep-alive", "x-xo-skip-toolbar": "1", accept: "*/*" },
			new URL("http://127.0.0.1:4173"),
		);
		assert.equal(out.host, "127.0.0.1:4173");
		assert.equal(out["accept-encoding"], "identity");
		assert.equal(out["x-forwarded-host"], "localhost:4100");
		assert.equal(out.connection, undefined);
		assert.equal(out["x-xo-skip-toolbar"], undefined);
		assert.equal(out["x-vercel-skip-toolbar"], undefined);
	});

	test("fronting a Vercel preview switches Vercel's own toolbar off", () => {
		const out = upstreamRequestHeaders({ host: "localhost:4100" }, new URL("https://app-git-main-team.vercel.app"));
		assert.equal(out["x-vercel-skip-toolbar"], "1");
	});

	test("injected responses lose length and validators, redirects and cookies come back through the gateway", () => {
		const out = responseHeaders(
			{
				"content-type": "text/html",
				"content-length": "120",
				etag: '"x"',
				"transfer-encoding": "chunked",
				location: "http://127.0.0.1:4173/pricing",
				"set-cookie": ["sid=1; Domain=example.com; Path=/; HttpOnly"],
			},
			{ inject: true, nonce: "N", upstreamOrigin: "http://127.0.0.1:4173", gatewayOrigin: "http://localhost:4100" },
		);
		assert.equal(out["content-length"], undefined);
		assert.equal(out.etag, undefined);
		assert.equal(out["transfer-encoding"], undefined);
		assert.equal(out.location, "http://localhost:4100/pricing");
		assert.deepEqual(out["set-cookie"], ["sid=1; Path=/; HttpOnly"]);
		assert.equal(out["x-xo-toolbar"], "injected");
	});

	test("responses that are not injected keep their length and security headers", () => {
		const out = responseHeaders(
			{ "content-type": "text/css", "content-length": "10", "x-frame-options": "DENY" },
			{ inject: false, upstreamOrigin: "http://a", gatewayOrigin: "http://b" },
		);
		assert.equal(out["content-length"], "10");
		assert.equal(out["x-frame-options"], "DENY");
	});
});
