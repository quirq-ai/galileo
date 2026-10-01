/**
 * Comment threads, agent requests and toolbar designs, kept in files beside
 * the gateway: the local stand-in for Vercel's comment service.
 *
 * A thread has the shape the Vercel toolbar uses (`id`, `nodeId`, `page`,
 * `pageTitle`, `selectionRange`, `screenWidth`, `screenHeight`, `comments`)
 * plus an `anchor` for re-finding the element when every selector misses.
 * Threads are keyed by app and page path, so they come back on the next load
 * of that page and after the app is rebuilt, and `/` in one app never shows
 * another app's comments.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { defaultLayout, normalizeLayout } from "../layout.mjs";

/** The gateway's own default design lives beside the apps' designs; no app can be called `_default`. */
const GATEWAY_DESIGN = "_default";

export function createStore(dir) {
	mkdirSync(dir, { recursive: true });
	const threadsFile = path.join(dir, "threads.json");
	const agentFile = path.join(dir, "agent-requests.jsonl");
	const layoutsDir = path.join(dir, "toolbars");
	let threads = load();

	function load() {
		try {
			const data = JSON.parse(readFileSync(threadsFile, "utf8"));
			return Array.isArray(data.threads) ? data.threads : [];
		} catch {
			return [];
		}
	}

	function save() {
		const temp = `${threadsFile}.tmp`;
		writeFileSync(temp, JSON.stringify({ threads }, null, 2));
		renameSync(temp, threadsFile);
	}

	function newId(prefix) {
		return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
	}

	function comment({ text, author, attachments }) {
		const entry = { id: newId("c"), text, author, createdAt: new Date().toISOString() };
		if (attachments?.length) entry.attachments = attachments;
		return entry;
	}

	function designFile(name) {
		return path.join(layoutsDir, `${name}.json`);
	}

	function readDesign(name) {
		try {
			return normalizeLayout(JSON.parse(readFileSync(designFile(name), "utf8")));
		} catch {
			return null;
		}
	}

	function writeDesign(name, input) {
		const layout = normalizeLayout(input);
		mkdirSync(layoutsDir, { recursive: true });
		const temp = `${designFile(name)}.tmp`;
		writeFileSync(temp, JSON.stringify(layout, null, 2));
		renameSync(temp, designFile(name));
		return layout;
	}

	return {
		list({ target, page } = {}) {
			return threads.filter((thread) => thread.target === target && (!page || thread.page === page));
		},

		/** A thread, but only through the app it belongs to. */
		get(id, target) {
			return threads.find((thread) => thread.id === id && (target === undefined || thread.target === target));
		},

		/** A thread belongs to its app, and remembers which of the app's versions it was started on. */
		create({ target, version, nodeId, anchor, page, pageTitle, selectionRange, screenWidth, screenHeight, text, author, attachments }) {
			const thread = {
				id: newId("t"),
				target,
				version,
				nodeId,
				anchor,
				page,
				pageTitle,
				selectionRange,
				screenWidth,
				screenHeight,
				status: "open",
				createdAt: new Date().toISOString(),
				comments: [comment({ text, author, attachments })],
			};
			threads.push(thread);
			save();
			return thread;
		},

		reply(id, target, input) {
			const thread = this.get(id, target);
			if (!thread) return undefined;
			thread.comments.push(comment(input));
			save();
			return thread;
		},

		setStatus(id, target, status) {
			const thread = this.get(id, target);
			if (!thread) return undefined;
			thread.status = status;
			save();
			return thread;
		},

		remove(id, target) {
			const before = threads.length;
			threads = threads.filter((thread) => !(thread.id === id && thread.target === target));
			if (threads.length !== before) save();
			return threads.length !== before;
		},

		recordAgentRequest(request) {
			const entry = { id: newId("a"), receivedAt: new Date().toISOString(), ...request };
			appendFileSync(agentFile, `${JSON.stringify(entry)}\n`);
			return entry;
		},

		/**
		 * The toolbar design an app gets: its own, else the gateway's default,
		 * else the toolbar's built-in design. `source` says which. A hand-edited
		 * file is checked like any other.
		 */
		getLayout(app) {
			const own = readDesign(app);
			return own ? { layout: own, source: "app" } : this.getDefault();
		},

		saveLayout(app, input) {
			return writeDesign(app, input);
		},

		/** Drops the app's own design; it gets the default again. */
		resetLayout(app) {
			rmSync(designFile(app), { force: true });
			return this.getDefault();
		},

		/** The design every app without its own gets. */
		getDefault() {
			const gateway = readDesign(GATEWAY_DESIGN);
			return gateway ? { layout: gateway, source: "gateway" } : { layout: defaultLayout(), source: "built-in" };
		},

		saveDefault(input) {
			return writeDesign(GATEWAY_DESIGN, input);
		},

		/** Back to the toolbar's built-in design. */
		resetDefault() {
			rmSync(designFile(GATEWAY_DESIGN), { force: true });
			return this.getDefault();
		},
	};
}
