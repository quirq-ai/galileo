/**
 * The little HTTP telescope's routes need: JSON in and out, and the two rules
 * that keep its API to its own pages. galileo's own routes keep the same rules
 * in `src/server.mjs`.
 */

/** The largest JSON body telescope reads. Captures don't come this way: they stream to `uploads.mjs`. */
export const MAX_BODY_BYTES = 256 * 1024;

export function sendBody(res, status, type, body, headers = {}) {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
	res.end(body);
}

export function sendJson(res, status, value) {
	if (res.headersSent) return;
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
}

/** A request's JSON body, `{}` when it isn't an object; a 413 past `MAX_BODY_BYTES`. */
export async function readJson(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Body too large"), { status: 413 });
		chunks.push(chunk);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		return typeof value === "object" && value !== null ? value : {};
	} catch {
		return {};
	}
}

/** Requests from any origin other than this one are refused; tools like curl send no Sec-Fetch-Site and pass. */
export function guardSameOrigin(req) {
	const site = req.headers["sec-fetch-site"];
	if (site && site !== "same-origin" && site !== "none") {
		throw Object.assign(new Error("Cross-origin requests are not accepted"), { status: 403 });
	}
}

/** JSON only, so a plain HTML form elsewhere can't post here. */
export function requireJson(req) {
	if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
		throw Object.assign(new Error("Send JSON"), { status: 415 });
	}
}
