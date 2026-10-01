/**
 * What galileo changes on the way through a source, kept as pure functions so
 * the rules are tested without a server (`npm test`).
 *
 * telescope shows each source in a frame, so a source's responses may be
 * framed by galileo and by nothing else, and each HTML page gets one script
 * appended at the end: telescope's bridge, which tells telescope where the
 * page is. A page's own security headers are loosened just enough for that
 * script to run.
 */

export const XO_PREFIX = "/__xo/";
export const BRIDGE_PATH = "/__xo/bridge.js";

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

/**
 * Whether a response is a page the bridge should ride on: a GET for a
 * document (not a fetch, not a script) answered with uncompressed HTML.
 */
export function shouldInject(request, response) {
	if (request.method !== "GET") return false;

	const status = response.statusCode ?? 0;
	if (status < 200 || status === 204 || (status >= 300 && status < 400)) return false;

	const type = String(response.headers["content-type"] ?? "").toLowerCase();
	if (!type.startsWith("text/html")) return false;

	// Appending to a compressed body would corrupt it; galileo asks the
	// upstream for identity encoding, so this only trips on servers that ignore it.
	const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
	if (encoding !== "identity") return false;

	const destination = request.headers["sec-fetch-dest"];
	if (destination) return DOCUMENT_DESTINATIONS.has(destination);
	return String(request.headers.accept ?? "").includes("text/html");
}

/**
 * The bridge's tag. It comes from the page's own origin, so `script-src
 * 'self'` admits it, and it carries a nonce for pages whose policy trusts
 * scripts by nonce.
 */
export function bridgeTag({ nonce } = {}) {
	const attributes = nonce ? ` nonce="${escapeAttribute(nonce)}"` : "";
	return `<script async${attributes} src="${BRIDGE_PATH}"></script>`;
}

/** The policy galileo adds to every response of a source: only galileo, and the source itself, may frame it. */
export function framePolicy(origins) {
	return ["frame-ancestors", "'self'", ...origins].join(" ");
}

function escapeAttribute(value) {
	return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Lets galileo frame the response, and lets the bridge run under the page's
 * own Content Security Policy.
 *
 * - Framing: `X-Frame-Options` is removed, and so is each policy's
 *   `frame-ancestors`; `framePolicy` then allows galileo's origins alone.
 * - Scripts, when `nonce` is given (a page that gets the bridge): a policy that
 *   trusts scripts by nonce, hash or 'strict-dynamic', or allows none, gets
 *   galileo's nonce. One that only lists sources gets 'self'. A nonce is never
 *   added to a policy that relies on 'unsafe-inline', because browsers ignore
 *   'unsafe-inline' once a nonce is present and the page's own inline scripts
 *   would stop running.
 */
export function rewriteSecurityHeaders(headers, { nonce, frameOrigins } = {}) {
	const out = { ...headers };
	delete out["x-frame-options"];
	for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
		if (out[name] === undefined) continue;
		const policies = splitPolicies(out[name]).map((policy) => rewritePolicy(policy, nonce)).filter(Boolean);
		if (policies.length === 0) delete out[name];
		else out[name] = policies.length === 1 ? policies[0] : policies;
	}
	if (frameOrigins) {
		const policies = [].concat(out["content-security-policy"] ?? [], framePolicy(frameOrigins));
		out["content-security-policy"] = policies.length === 1 ? policies[0] : policies;
	}
	return out;
}

/**
 * The policies in a CSP header. A header's value is a comma-separated list of
 * policies, and Node joins a header sent twice with a comma, so each part is a
 * policy of its own.
 */
export function splitPolicies(value) {
	return []
		.concat(value)
		.flatMap((item) => String(item).split(","))
		.map((policy) => policy.trim())
		.filter(Boolean);
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

	if (nonce !== undefined) {
		// When only `default-src` restricts scripts, add a `script-src` copied from
		// it rather than widening `default-src`, which also governs styles,
		// fonts, frames and requests.
		const names = new Set(directives.map((directive) => directive.name));
		const fallback = directives.find((directive) => directive.name === "default-src");
		if (!names.has("script-src") && fallback) directives.push({ name: "script-src", sources: [...fallback.sources] });
		for (const directive of directives) {
			if (directive.name === "script-src" || directive.name === "script-src-elem") {
				directive.sources = allowBridge(directive.sources, nonce);
			}
		}
	}
	return directives.map((directive) => [directive.name, ...directive.sources].join(" ")).join("; ");
}

function allowBridge(sources, nonce) {
	const lower = sources.map((source) => source.toLowerCase());
	const blocksEverything = lower.includes("'none'");
	const trustsByToken = lower.some(
		(source) => source === "'strict-dynamic'" || source.startsWith("'nonce-") || /^'sha(256|384|512)-/.test(source),
	);
	const kept = sources.filter((source) => source.toLowerCase() !== "'none'");
	if ((trustsByToken || blocksEverything) && nonce) return [...kept, `'nonce-${nonce}'`];
	if (lower.includes("'self'") || lower.includes("*")) return kept;
	return [...kept, "'self'"];
}

/** Request headers for a port: its own Host, no hop-by-hop headers, no compression. */
export function upstreamRequestHeaders(headers, upstreamHost) {
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!HOP_BY_HOP.has(name)) out[name] = value;
	}
	out.host = upstreamHost;
	// Identity encoding lets galileo append to a page without decompressing it;
	// on a loopback hop it costs nothing.
	out["accept-encoding"] = "identity";
	if (headers.host) out["x-forwarded-host"] = headers.host;
	out["x-forwarded-proto"] = "http";
	return out;
}

/**
 * Response headers for the browser: framed by galileo alone, redirects and
 * cookies kept on the source's address, and loosened for the bridge when
 * `inject` is set.
 */
export function responseHeaders(headers, { inject, nonce, upstreamOrigins = [], sourceOrigin, frameOrigins }) {
	let out = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!HOP_BY_HOP.has(name)) out[name] = value;
	}
	if (typeof out.location === "string") out.location = rewriteLocation(out.location, upstreamOrigins, sourceOrigin);
	if (out["set-cookie"]) out["set-cookie"] = [].concat(out["set-cookie"]).map(stripCookieDomain);
	out = rewriteSecurityHeaders(out, { nonce: inject ? nonce : undefined, frameOrigins });
	if (inject) {
		// The body grows by one tag, so the length and validators no longer describe it.
		delete out["content-length"];
		delete out.etag;
		delete out["last-modified"];
		out["x-galileo-bridge"] = "added";
	}
	return out;
}

/** A redirect to the port's own origin, written whole or as `//host:port/…`, comes back through the source's address. */
export function rewriteLocation(location, upstreamOrigins, sourceOrigin) {
	const absolute = location.startsWith("//") ? `http:${location}` : location;
	for (const origin of upstreamOrigins) {
		const rest = absolute.slice(origin.length);
		if (sourceOrigin && absolute.startsWith(origin) && (rest === "" || /^[/?#]/.test(rest))) return sourceOrigin + rest;
	}
	return location;
}

/** A cookie scoped to another domain would be dropped on the source's address. */
export function stripCookieDomain(cookie) {
	return String(cookie).replace(/;\s*domain=[^;]*/gi, "");
}
