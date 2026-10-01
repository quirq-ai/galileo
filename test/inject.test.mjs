/**
 * What galileo changes on the way through a source: which responses get the
 * bridge, how framing is limited to galileo, and how a page's policy lets the
 * bridge run. `npm test`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	bridgeTag,
	framePolicy,
	responseHeaders,
	rewriteLocation,
	rewritePolicy,
	rewriteSecurityHeaders,
	shouldInject,
	splitPolicies,
	stripCookieDomain,
	upstreamRequestHeaders,
} from "../src/inject.mjs";

const ORIGINS = ["http://localhost:4100", "http://127.0.0.1:4100"];
const FRAMING = "frame-ancestors 'self' http://localhost:4100 http://127.0.0.1:4100";

const page = (headers = {}, extra = {}) => ({
	method: "GET",
	url: "/",
	headers: { accept: "text/html", "sec-fetch-dest": "iframe", ...headers },
	...extra,
});
const html = (headers = {}, statusCode = 200) => ({
	statusCode,
	headers: { "content-type": "text/html; charset=utf-8", ...headers },
});

describe("which responses get the bridge", () => {
	test("a page loaded in telescope's frame, or on its own, answered with HTML", () => {
		assert.equal(shouldInject(page(), html()), true);
		assert.equal(shouldInject(page({ "sec-fetch-dest": "document" }), html()), true);
		assert.equal(shouldInject({ method: "GET", url: "/", headers: { accept: "text/html" } }, html()), true);
	});

	test("an app's own error pages too, so the bar follows them", () => {
		assert.equal(shouldInject(page(), html({}, 404)), true);
		assert.equal(shouldInject(page(), html({}, 500)), true);
	});

	test("never a fetch, a non-GET, a redirect, a 304, a non-HTML body or a compressed one", () => {
		assert.equal(shouldInject(page({ "sec-fetch-dest": "empty" }), html()), false);
		assert.equal(shouldInject(page({}, { method: "POST" }), html()), false);
		assert.equal(shouldInject(page(), html({}, 302)), false);
		assert.equal(shouldInject(page(), html({}, 304)), false);
		assert.equal(shouldInject(page(), { statusCode: 200, headers: { "content-type": "application/json" } }), false);
		assert.equal(shouldInject(page(), html({ "content-encoding": "gzip" })), false);
	});

	test("the tag is same-origin and async, with the nonce when there is one", () => {
		assert.equal(bridgeTag(), '<script async src="/__xo/bridge.js"></script>');
		assert.equal(bridgeTag({ nonce: 'a"b' }), '<script async nonce="a&quot;b" src="/__xo/bridge.js"></script>');
	});
});

describe("framing", () => {
	test("only galileo, and the source itself, may frame a source", () => {
		assert.equal(framePolicy(ORIGINS), FRAMING);
	});

	test("X-Frame-Options and the page's own frame-ancestors go, and galileo's policy is added", () => {
		const out = rewriteSecurityHeaders(
			{ "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" },
			{ frameOrigins: ORIGINS },
		);
		assert.equal(out["x-frame-options"], undefined);
		assert.deepEqual(out["content-security-policy"], ["default-src 'self'", FRAMING]);
	});

	test("a response with no policy gets galileo's alone, and a policy that only framed goes away", () => {
		assert.equal(rewriteSecurityHeaders({}, { frameOrigins: ORIGINS })["content-security-policy"], FRAMING);
		assert.equal(rewriteSecurityHeaders({ "content-security-policy": "frame-ancestors 'none'" }, { frameOrigins: ORIGINS })["content-security-policy"], FRAMING);
	});
});

describe("a page's policy and the bridge", () => {
	test("a nonce policy with 'strict-dynamic' gets galileo's nonce", () => {
		assert.equal(
			rewritePolicy("script-src 'nonce-app' 'strict-dynamic'; style-src 'self'", "N"),
			"script-src 'nonce-app' 'strict-dynamic' 'nonce-N'; style-src 'self'",
		);
	});

	test("a hash policy, and one that allows no scripts, get the nonce too", () => {
		assert.match(rewritePolicy("script-src 'sha256-abc'", "N"), /script-src 'sha256-abc' 'nonce-N'/);
		assert.equal(rewritePolicy("script-src 'none'", "N"), "script-src 'nonce-N'");
	});

	test("an 'unsafe-inline' policy gets 'self' and never a nonce, which would switch its inline scripts off", () => {
		assert.equal(rewritePolicy("script-src 'unsafe-inline' https://cdn.example", "N"), "script-src 'unsafe-inline' https://cdn.example 'self'");
	});

	test("a policy that already allows 'self' is left alone, and so is script-src-elem's", () => {
		assert.equal(rewritePolicy("script-src 'self'; connect-src 'self'", "N"), "script-src 'self'; connect-src 'self'");
		assert.equal(rewritePolicy("script-src-elem https://cdn.example", "N"), "script-src-elem https://cdn.example 'self'");
	});

	test("default-src alone gains an explicit script-src instead of being widened", () => {
		assert.equal(rewritePolicy("default-src 'none'; img-src 'self'", "N"), "default-src 'none'; img-src 'self'; script-src 'nonce-N'");
	});

	test("without a nonce (a response that gets no bridge) scripts are left as they are", () => {
		assert.equal(rewritePolicy("default-src 'none'; frame-ancestors 'none'"), "default-src 'none'");
	});

	test("a header holding several policies, as Node joins two headers, is rewritten policy by policy", () => {
		assert.deepEqual(splitPolicies(["default-src 'self', frame-ancestors 'none'", "img-src *"]), ["default-src 'self'", "frame-ancestors 'none'", "img-src *"]);
		const out = rewriteSecurityHeaders({ "content-security-policy": "default-src 'self', frame-ancestors 'none'" }, { nonce: "N", frameOrigins: ORIGINS });
		assert.deepEqual(out["content-security-policy"], ["default-src 'self'; script-src 'self'", FRAMING]);
	});

	test("report-only policies are rewritten the same way", () => {
		const out = rewriteSecurityHeaders({ "content-security-policy-report-only": "script-src 'nonce-a'; frame-ancestors 'none'" }, { nonce: "N" });
		assert.equal(out["content-security-policy-report-only"], "script-src 'nonce-a' 'nonce-N'");
	});
});

describe("passing requests and responses through", () => {
	test("a port gets its own Host, no compression and no hop-by-hop headers", () => {
		const out = upstreamRequestHeaders(
			{ host: "acme.localhost:4100", connection: "keep-alive", "accept-encoding": "gzip, br", cookie: "a=1" },
			"localhost:5173",
		);
		assert.equal(out.host, "localhost:5173");
		assert.equal(out["accept-encoding"], "identity");
		assert.equal(out["x-forwarded-host"], "acme.localhost:4100");
		assert.equal(out.connection, undefined);
		assert.equal(out.cookie, "a=1");
	});

	test("pages that get the bridge lose length and validators, and say so", () => {
		const out = responseHeaders(
			{ "content-type": "text/html", "content-length": "10", etag: '"x"', "last-modified": "today", "transfer-encoding": "chunked" },
			{ inject: true, nonce: "N", frameOrigins: ORIGINS },
		);
		assert.equal(out["content-length"], undefined);
		assert.equal(out.etag, undefined);
		assert.equal(out["last-modified"], undefined);
		assert.equal(out["transfer-encoding"], undefined);
		assert.equal(out["x-galileo-bridge"], "added");
	});

	test("everything else keeps its length, and every response is framed by galileo alone", () => {
		const out = responseHeaders({ "content-type": "image/png", "content-length": "10", "x-frame-options": "SAMEORIGIN" }, { inject: false, frameOrigins: ORIGINS });
		assert.equal(out["content-length"], "10");
		assert.equal(out["x-frame-options"], undefined);
		assert.equal(out["content-security-policy"], FRAMING);
	});

	test("redirects to the port come back to the source's address, and cookies stay on it", () => {
		const origins = ["http://localhost:5173", "http://127.0.0.1:5173"];
		assert.equal(rewriteLocation("http://localhost:5173/login?next=/", origins, "http://acme.localhost:4100"), "http://acme.localhost:4100/login?next=/");
		assert.equal(rewriteLocation("http://127.0.0.1:5173", origins, "http://acme.localhost:4100"), "http://acme.localhost:4100");
		assert.equal(rewriteLocation("http://localhost:51730/x", origins, "http://acme.localhost:4100"), "http://localhost:51730/x");
		assert.equal(rewriteLocation("//localhost:5173/landed", origins, "http://acme.localhost:4100"), "http://acme.localhost:4100/landed");
		assert.equal(rewriteLocation("//cdn.example/x", origins, "http://acme.localhost:4100"), "//cdn.example/x");
		assert.equal(rewriteLocation("/relative", origins, "http://acme.localhost:4100"), "/relative");
		assert.equal(stripCookieDomain("sid=1; Domain=localhost; Path=/; HttpOnly"), "sid=1; Path=/; HttpOnly");
	});
});
