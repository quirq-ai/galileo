/**
 * What the gateway changes on the way through, kept as pure functions so the
 * rules are tested without a server (`npm test`).
 *
 * The gateway plays the part Vercel's edge plays on preview URLs: it appends
 * one loader tag to the end of every HTML page it serves and passes
 * everything else through. The page's own security headers are adjusted just
 * enough for that tag to run and for the page to be framed by XO.
 */

export const SKIP_HEADER = "x-xo-skip-toolbar";
export const SKIP_PARAM = "xo_toolbar";
export const XO_PREFIX = "/__xo/";
export const LOADER_PATH = "/__xo/toolbar/loader.js";

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

const DOCUMENT_DESTINATIONS = new Set(["document", "iframe", "frame"]);

/** Directives that must admit the page's own origin: the toolbar's API, and captures shown back to the user. */
const SELF_DIRECTIVES = ["connect-src", "img-src", "media-src"];

/**
 * Whether a response is a page the toolbar should ride on: a GET for a
 * document (not a fetch, not a framework data request) answered with
 * uncompressed HTML, and not opted out by header or by `?xo_toolbar=off`.
 */
export function shouldInject(request, response) {
	if (request.method !== "GET") return false;
	if (request.headers[SKIP_HEADER] !== undefined) return false;
	if (skippedByQuery(request.url)) return false;

	const status = response.statusCode ?? 0;
	if (status < 200 || status === 204 || (status >= 300 && status < 400)) return false;

	const type = String(response.headers["content-type"] ?? "").toLowerCase();
	if (!type.startsWith("text/html")) return false;

	// Appending to a compressed body would corrupt it; the gateway asks the
	// upstream for identity encoding, so this only trips on servers that ignore it.
	const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
	if (encoding !== "identity") return false;

	const destination = request.headers["sec-fetch-dest"];
	if (destination) return DOCUMENT_DESTINATIONS.has(destination);
	return String(request.headers.accept ?? "").includes("text/html");
}

function skippedByQuery(url = "/") {
	const start = url.indexOf("?");
	if (start < 0) return false;
	return new URLSearchParams(url.slice(start + 1)).get(SKIP_PARAM) === "off";
}

/**
 * The one tag the gateway carries into a page, the counterpart of Vercel's
 * `<script async data-explicit-opt-in … src="https://vercel.live/…/feedback.js">`.
 * It is served from the page's own origin, so `script-src 'self'` admits it,
 * and it carries a nonce for pages whose policy trusts scripts by nonce. It
 * also says which version of the app the page came from, and which versions
 * the app has, so the toolbar can show and switch them.
 */
export function loaderTag({ nonce, previewId, project, version, versions }) {
	const attributes = [
		["async", true],
		["data-xo-toolbar", true],
		["data-explicit-opt-in", "true"],
		["data-preview-id", previewId],
		["data-project", project],
		["data-app-version", version],
		["data-app-versions", Array.isArray(versions) ? versions.join(",") : undefined],
		["nonce", nonce],
		["src", LOADER_PATH],
	];
	const rendered = attributes
		.filter(([, value]) => value === true || (typeof value === "string" && value !== ""))
		.map(([name, value]) => (value === true ? name : `${name}="${escapeAttribute(value)}"`));
	return `<script ${rendered.join(" ")}></script>`;
}

function escapeAttribute(value) {
	return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Lets the page be framed by XO and lets the toolbar run under the page's own
 * Content Security Policy.
 *
 * - Framing: `X-Frame-Options` is removed, and so is CSP `frame-ancestors`.
 * - Scripts: a policy that already trusts scripts by nonce, hash or
 *   'strict-dynamic' gets the gateway's nonce added. One that only lists
 *   sources gets 'self', since the loader and the app come from the page's own
 *   origin. A nonce is never added to a policy that relies on
 *   'unsafe-inline', because browsers ignore 'unsafe-inline' once a nonce is
 *   present and the page's own inline scripts would stop running.
 * - Requests: the toolbar's API is same-origin, so `connect-src` gets 'self'.
 * - Captures: screenshots and recordings are shown from the page's own origin
 *   (`/__xo/uploads/…`), so `img-src` and `media-src` get 'self'.
 */
export function rewriteSecurityHeaders(headers, nonce) {
	const out = { ...headers };
	delete out["x-frame-options"];
	for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
		if (out[name] === undefined) continue;
		const policies = [].concat(out[name]).map((policy) => rewritePolicy(policy, nonce)).filter(Boolean);
		if (policies.length === 0) delete out[name];
		else out[name] = policies.length === 1 ? policies[0] : policies;
	}
	return out;
}

export function rewritePolicy(policy, nonce) {
	const directives = String(policy)
		.split(";")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const [name, ...sources] = part.split(/\s+/);
			return { name: name.toLowerCase(), sources };
		})
		.filter((directive) => directive.name !== "frame-ancestors");

	// When only `default-src` restricts one of these, add an explicit directive
	// copied from it rather than widening `default-src`, which also governs
	// styles, fonts and frames.
	const byName = new Map(directives.map((directive) => [directive.name, directive]));
	const fallback = byName.get("default-src");
	for (const name of ["script-src", ...SELF_DIRECTIVES]) {
		if (!byName.has(name) && fallback) {
			const copy = { name, sources: [...fallback.sources] };
			directives.push(copy);
			byName.set(name, copy);
		}
	}
	for (const directive of directives) {
		if (directive.name === "script-src" || directive.name === "script-src-elem") {
			directive.sources = allowToolbarScripts(directive.sources, nonce);
		} else if (SELF_DIRECTIVES.includes(directive.name)) {
			directive.sources = allowSelf(directive.sources);
		}
	}
	return directives.map((directive) => [directive.name, ...directive.sources].join(" ")).join("; ");
}

function allowToolbarScripts(sources, nonce) {
	const lower = sources.map((source) => source.toLowerCase());
	const blocksEverything = lower.includes("'none'");
	const trustsByToken = lower.some(
		(source) =>
			source === "'strict-dynamic'" || source.startsWith("'nonce-") || /^'sha(256|384|512)-/.test(source),
	);
	const kept = sources.filter((source) => source.toLowerCase() !== "'none'");
	if ((trustsByToken || blocksEverything) && nonce) return [...kept, `'nonce-${nonce}'`];
	if (lower.includes("'self'") || lower.includes("*")) return kept;
	return [...kept, "'self'"];
}

function allowSelf(sources) {
	const lower = sources.map((source) => source.toLowerCase());
	if (lower.includes("'self'") || lower.includes("*")) return sources;
	return [...sources.filter((source) => source.toLowerCase() !== "'none'"), "'self'"];
}

/** Request headers for the upstream: its own Host, no hop-by-hop headers, no compression. */
export function upstreamRequestHeaders(headers, upstream) {
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		if (HOP_BY_HOP.has(name) || name === SKIP_HEADER) continue;
		out[name] = value;
	}
	out.host = upstream.host;
	// Identity encoding lets the gateway append to HTML without decompressing;
	// on a local loopback hop it costs nothing.
	out["accept-encoding"] = "identity";
	if (headers.host) out["x-forwarded-host"] = headers.host;
	out["x-forwarded-proto"] = "http";
	// Fronting a Vercel preview: XO's toolbar replaces Vercel's, as Vercel's own docs suggest for automation.
	if (upstream.hostname.endsWith(".vercel.app")) out["x-vercel-skip-toolbar"] = "1";
	return out;
}

/** Response headers for the browser, rewritten for injection when `inject` is set. */
export function responseHeaders(headers, { inject, nonce, upstreamOrigin, gatewayOrigin }) {
	let out = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!HOP_BY_HOP.has(name)) out[name] = value;
	}
	if (typeof out.location === "string") out.location = rewriteLocation(out.location, upstreamOrigin, gatewayOrigin);
	if (out["set-cookie"]) out["set-cookie"] = [].concat(out["set-cookie"]).map(stripCookieDomain);
	if (inject) {
		out = rewriteSecurityHeaders(out, nonce);
		// The body grows by one tag, so the length and validators no longer describe it.
		delete out["content-length"];
		delete out.etag;
		delete out["last-modified"];
		out["x-xo-toolbar"] = "injected";
	}
	return out;
}

/** Redirects to the upstream's own origin come back through the gateway. */
export function rewriteLocation(location, upstreamOrigin, gatewayOrigin) {
	if (upstreamOrigin && gatewayOrigin && location.startsWith(upstreamOrigin)) {
		return gatewayOrigin + location.slice(upstreamOrigin.length);
	}
	return location;
}

/** A cookie scoped to the upstream's domain would be dropped on the gateway's host. */
export function stripCookieDomain(cookie) {
	return String(cookie).replace(/;\s*domain=[^;]*/gi, "");
}
