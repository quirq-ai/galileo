/**
 * telescope's server side: what it keeps (comment threads, requests for the
 * agent, designs, captures) and the routes it answers under `/__xo/`, on each
 * app's own host and on the gateway's.
 *
 * galileo makes one with `createTelescope({ dataDir })` and hands it requests:
 * `handleApp` for an app's `/__xo/*`, `handleGateway` for the bare host's. Each
 * answers and resolves `true`, or resolves `false` for a route that isn't
 * telescope's, which the host then answers itself. Errors are thrown as
 * `Object.assign(new Error(message), { status })`, for the host to answer as
 * `{ error }` JSON.
 */
import { readBundle } from "../index.mjs";
import { BUILT_IN_TOOLS, CUSTOM_ICONS, DOCK_POSITIONS } from "../layout.mjs";
import { guardSameOrigin, readJson, requireJson, sendBody, sendJson } from "./http.mjs";
import { createStore } from "./store.mjs";
import { createUploads } from "./uploads.mjs";

export function createTelescope({ dataDir, log = () => {} }) {
	const store = createStore(dataDir);
	const uploads = createUploads(dataDir);

	/**
	 * An app's `/__xo/*`: telescope's files, its captures, and its API, which
	 * answers only about this app and only to pages on this app's origin.
	 * `app` is `{ name, version, upstream, label }`: the app, the version the
	 * page came from, the origin serving that version, and how logs name it.
	 */
	async function handleApp(req, res, app) {
		const url = new URL(req.url, "http://telescope");
		const route = url.pathname;

		if (req.method === "GET" && route.startsWith("/__xo/toolbar/")) {
			await sendBundle(res, route.slice("/__xo/toolbar/".length));
			return true;
		}
		if (req.method === "GET" && route.startsWith("/__xo/uploads/")) {
			if (!(await uploads.serve(app.name, route.slice("/__xo/uploads/".length), req, res))) sendJson(res, 404, { error: "No such upload" });
			return true;
		}
		if (!route.startsWith("/__xo/api/")) return false;

		// Only telescope, running on this app's own origin, may use its API.
		// Another app on the gateway, or on another localhost port, is refused.
		guardSameOrigin(req);

		if (route === "/__xo/api/threads" && req.method === "GET") {
			sendJson(res, 200, { threads: store.list({ target: app.name, page: url.searchParams.get("page") ?? undefined }) });
			return true;
		}
		if (route === "/__xo/api/uploads" && req.method === "POST") {
			const upload = await uploads.save(app.name, req);
			log(`${app.name}: saved ${upload.kind} ${upload.file} (${Math.round(upload.size / 1024)} KB)`);
			sendJson(res, 201, { upload: publicUpload(upload) });
			return true;
		}
		const uploadRoute = /^\/__xo\/api\/uploads\/(u_[a-z0-9]+)$/.exec(route);
		if (uploadRoute && req.method === "DELETE") {
			if (await uploads.remove(app.name, uploadRoute[1])) sendJson(res, 200, { ok: true });
			else sendJson(res, 404, { error: "No such upload" });
			return true;
		}

		// This app's design. Saving one gives the app its own; deleting it hands
		// the app back the gateway's default.
		if (route === "/__xo/api/toolbar" && req.method === "GET") {
			sendJson(res, 200, design(store.getLayout(app.name)));
			return true;
		}
		if (route === "/__xo/api/toolbar" && req.method === "PUT") {
			requireJson(req);
			const layout = store.saveLayout(app.name, await readJson(req));
			log(`${app.name}: telescope design saved (${layout.items.length} items, dock ${layout.dock.position})`);
			sendJson(res, 200, design({ layout, source: "app" }));
			return true;
		}
		if (route === "/__xo/api/toolbar" && req.method === "DELETE") {
			log(`${app.name}: back to the default telescope design`);
			sendJson(res, 200, design(store.resetLayout(app.name)));
			return true;
		}

		if (route === "/__xo/api/threads" && req.method === "POST") {
			const body = await readJson(req);
			const input = {
				target: app.name,
				version: app.version,
				// Empty for a comment on the whole page, such as one carrying a screenshot of it.
				nodeId: text(body.nodeId, 4000, ""),
				anchor: anchor(body.anchor),
				page: text(body.page, 2000),
				pageTitle: text(body.pageTitle, 300, ""),
				selectionRange: body.selectionRange?.text ? { text: text(body.selectionRange.text, 500) } : undefined,
				screenWidth: whole(body.screenWidth),
				screenHeight: whole(body.screenHeight),
				text: text(body.text, 5000),
				author: text(body.author, 80, "Local user"),
				attachments: await resolveAttachments(app.name, body.attachments),
			};
			const thread = store.create(input);
			log(`${app.label}: comment on ${input.page} (${firstSelector(input.nodeId)}): ${JSON.stringify(input.text)}`);
			sendJson(res, 201, { thread });
			return true;
		}

		const threadRoute = /^\/__xo\/api\/threads\/([\w-]+)(\/comments)?$/.exec(route);
		if (threadRoute) {
			const [, id, comments] = threadRoute;
			if (comments && req.method === "POST") {
				const body = await readJson(req);
				const thread = store.reply(id, app.name, {
					text: text(body.text, 5000),
					author: text(body.author, 80, "Local user"),
					attachments: await resolveAttachments(app.name, body.attachments),
				});
				if (thread) sendJson(res, 200, { thread });
				else sendJson(res, 404, { error: "No such thread" });
				return true;
			}
			if (!comments && req.method === "PATCH") {
				const body = await readJson(req);
				if (body.status !== "open" && body.status !== "resolved") {
					sendJson(res, 400, { error: "status must be open or resolved" });
					return true;
				}
				const thread = store.setStatus(id, app.name, body.status);
				if (thread) sendJson(res, 200, { thread });
				else sendJson(res, 404, { error: "No such thread" });
				return true;
			}
			if (!comments && req.method === "DELETE") {
				if (store.remove(id, app.name)) sendJson(res, 200, { ok: true });
				else sendJson(res, 404, { error: "No such thread" });
				return true;
			}
		}

		if (route === "/__xo/api/agent" && req.method === "POST") {
			const body = await readJson(req);
			const element = typeof body.element === "object" && body.element !== null ? body.element : undefined;
			// Agents get file paths, so they can open a screenshot or recording directly.
			const attachments = (await resolveAttachments(app.name, body.attachments, true)) ?? [];
			const logs = Array.isArray(body.logs) ? body.logs.slice(-200).map((entry) => clipJson(entry, 2000)) : undefined;
			const ask = text(body.ask, 4000, "");
			if (!ask && !attachments.length) {
				sendJson(res, 400, { error: "Say what the agent should do" });
				return true;
			}
			const entry = store.recordAgentRequest({
				target: app.name,
				// The version the person was looking at, and what served it.
				version: app.version,
				upstream: app.upstream ?? null,
				ask,
				page: text(body.page ?? element?.page, 2000, ""),
				element,
				attachments,
				logs,
				environment: typeof body.environment === "object" && body.environment !== null ? clipJson(body.environment, 4000) : undefined,
			});
			const extras = [
				attachments.length ? attachments.map((item) => `${item.kind} ${item.path}`).join(", ") : "",
				logs?.length ? `${logs.length} log entries` : "",
			].filter(Boolean);
			log(
				`${app.label}: ask the agent${element ? ` about ${firstSelector(element.nodeId)}` : ""} on ${entry.page || "the page"}: ` +
					`${JSON.stringify(ask)}${extras.length ? ` (+ ${extras.join("; ")})` : ""}`,
			);
			sendJson(res, 202, { id: entry.id });
			return true;
		}

		return false;
	}

	/**
	 * The gateway's own host: the design editor, and every app's design. Only
	 * this host may change another app's design; telescope in an app can only
	 * change that app's own. `apps` lists `{ name, url }` for each app.
	 */
	async function handleGateway(req, res, { apps }) {
		const route = new URL(req.url, "http://telescope").pathname;

		// The design editor, which a host's settings page mounts to edit any app's design.
		if (req.method === "GET" && route === "/__xo/toolbar/designer.js") {
			await sendBundle(res, "designer.js");
			return true;
		}
		if (route === "/__xo/api/toolbars" && req.method === "GET") {
			guardSameOrigin(req);
			sendJson(res, 200, {
				default: store.getDefault(),
				apps: apps.map(({ name, url }) => ({ name, url, ...store.getLayout(name) })),
				options: designOptions(),
			});
			return true;
		}
		// The gateway's default design, which every app without its own gets, or one app's own.
		const designRoute = /^\/__xo\/api\/toolbars\/(_default|[a-z0-9-]+)$/.exec(route);
		if (designRoute && (req.method === "PUT" || req.method === "DELETE")) {
			guardSameOrigin(req);
			const name = designRoute[1];
			const isDefault = name === "_default";
			if (!isDefault && !apps.some((app) => app.name === name)) {
				sendJson(res, 404, { error: `No app called "${name}"` });
				return true;
			}
			if (req.method === "PUT") {
				requireJson(req);
				const body = await readJson(req);
				const layout = isDefault ? store.saveDefault(body) : store.saveLayout(name, body);
				log(`${isDefault ? "default" : name} telescope design saved from the launcher`);
				sendJson(res, 200, design({ layout, source: isDefault ? "gateway" : "app" }));
				return true;
			}
			log(`${isDefault ? "default telescope design back to built-in" : `${name}: back to the default telescope design`}`);
			sendJson(res, 200, design(isDefault ? store.resetDefault() : store.resetLayout(name)));
			return true;
		}
		return false;
	}

	async function sendBundle(res, name) {
		const code = await readBundle(name);
		if (code === undefined) return sendJson(res, 404, { error: "Not found" });
		return sendBody(res, 200, "text/javascript; charset=utf-8", code);
	}

	/** Upload ids from a request, checked against this app's own uploads. */
	async function resolveAttachments(app, ids, withPath = false) {
		if (ids === undefined || ids === null) return undefined;
		if (!Array.isArray(ids) || ids.length > 10) throw Object.assign(new Error("attachments must be a list of up to 10 upload ids"), { status: 400 });
		const found = [];
		for (const id of ids) {
			const upload = await uploads.find(app, id);
			if (!upload) throw Object.assign(new Error(`No upload ${String(id).slice(0, 40)} for this app`), { status: 400 });
			found.push(withPath ? { ...publicUpload(upload), path: upload.path } : publicUpload(upload));
		}
		return found;
	}

	return { store, uploads, handleApp, handleGateway };
}

/** A trimmed string of at most `max` characters, the fallback when absent, or a 400 when required. */
function text(value, max, fallback) {
	if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, max);
	if (fallback !== undefined) return fallback;
	throw Object.assign(new Error("A required text field is missing"), { status: 400 });
}

function whole(value) {
	return Number.isFinite(value) ? Math.round(value) : undefined;
}

function anchor(value) {
	if (typeof value !== "object" || value === null) return undefined;
	const fraction = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
	return {
		tag: typeof value.tag === "string" ? value.tag.slice(0, 40) : undefined,
		textQuote: typeof value.textQuote === "string" ? value.textQuote.slice(0, 120) : undefined,
		offsetX: fraction(value.offsetX),
		offsetY: fraction(value.offsetY),
	};
}

/** A design as both APIs return it: where it comes from, and what the editor may offer. */
function design({ layout, source }) {
	return { layout, source, isDefault: source !== "app", options: designOptions() };
}

function designOptions() {
	return { tools: BUILT_IN_TOOLS, positions: DOCK_POSITIONS, icons: CUSTOM_ICONS };
}

/** What the page may know about an upload: not where it sits on this machine. */
function publicUpload(upload) {
	return { id: upload.id, url: upload.url, type: upload.type, kind: upload.kind, size: upload.size };
}

/** A JSON value cut down to at most `max` characters of serialized text. */
function clipJson(value, max) {
	const json = JSON.stringify(value ?? null);
	if (json.length <= max) return value;
	return { truncated: true, text: json.slice(0, max) };
}

function firstSelector(nodeId) {
	return String(nodeId ?? "").split(/(?<!\\),/)[0] || "element";
}
