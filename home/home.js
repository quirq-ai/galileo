/**
 * galileo's home page: the routes table, kept current. The app names are read
 * every 2 seconds while the page is visible (`/__xo/health`, cheap); every app
 * in detail (`/__xo/api/targets`) when those names change, when the page comes
 * back, and every 10 seconds. Everything is built with text nodes: folder names
 * and commands come from disk.
 */
const HEALTH_MS = 2000;
const DETAIL_MS = 10_000;

const port = location.port || "80";
for (const node of document.querySelectorAll("[data-port]")) node.textContent = port;

const routes = document.getElementById("routes");
/** The roots folders come from, so a folder can be named relative to its root. */
let roots = [];
const summary = document.getElementById("summary");
const rootsLine = document.getElementById("roots");

function el(tag, attrs, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs ?? {})) {
		if (value === undefined || value === null || value === false) continue;
		node.setAttribute(key, value === true ? "" : String(value));
	}
	for (const child of children.flat()) {
		if (child === null || child === undefined || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}

async function getJson(path) {
	const response = await fetch(path, { cache: "no-store" });
	if (!response.ok) throw new Error(`${path} answered ${response.status}`);
	return response.json();
}

/** `/Users/name/Projects/root` as `~/Projects/root`. */
function homeShort(dir) {
	return dir.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/** An address without its scheme and trailing slash: `acme.localhost:4100`. */
function bare(url) {
	return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** The version the app's own address serves. */
function servedVersion(app) {
	return app.versions.find((version) => version.default) ?? app.versions[0];
}

/** What a version is doing, as a tone and a few words. */
function versionState(app, version) {
	if (!version) return { tone: "down", text: "no version" };
	switch (version.state) {
		case undefined:
			return version.up ? { tone: "up", text: "answering" } : { tone: "down", text: "not answering" };
		case "files":
			return { tone: "up", text: "files" };
		case "running":
			return { tone: "up", text: version.external ? "running (started elsewhere)" : "running" };
		case "starting":
			return { tone: "busy", text: "starting" };
		case "stopped":
			return { tone: "idle", text: "starts when opened" };
		case "failed":
			return { tone: "down", text: app.folder?.server?.error ? `didn't start: ${app.folder.server.error}` : "didn't start" };
		default:
			return { tone: "idle", text: version.state };
	}
}

/** A folder by its place in its root (`web/`), or by its path when it's in none. */
function folderName(dir) {
	const root = roots.find((candidate) => dir.startsWith(`${candidate}/`));
	return root ? `${dir.slice(root.length + 1)}/` : homeShort(dir);
}

/** How a folder is served, from what galileo found in it. */
function howServed(folder) {
	if (folder.serves === "files") return folder.from === "index.html" ? "a static site" : "its files";
	const from = folder.from ?? "";
	const script = /^package\.json: (\w+) \((.*)\)$/.exec(from);
	if (script) return `${script[2]}, package.json ${script[1]}`;
	const launch = /^(.*)\.claude\/launch\.json: (.+)$/.exec(from);
	if (launch) return `“${launch[2]}”, ${launch[1] ? "its" : "the root's"} launch.json`;
	return from || "a dev server";
}

/** Where an app's requests go: what, and in a smaller line, how. */
function goesTo(app, version, isMain) {
	if (isMain && app.versions.length > 1) return [`its ${version.name} version`, null];
	if (version && !version.state) return [version.upstream ? bare(version.upstream) : "nothing yet", app.folder ? "added" : null];
	const folder = app.folder;
	if (!folder) return ["an added app", null];
	const port = folder.server?.port ? `, on :${folder.server.port}` : "";
	return [folderName(folder.dir), `${howServed(folder)}${port}`];
}

function goesToCell(app, version, isMain) {
	const [what, how] = goesTo(app, version, isMain);
	return el("td", { class: "target" }, el("span", { class: "what" }, what), how ? el("span", { class: "how" }, how) : null);
}

function stateCell(state) {
	return el("td", {}, el("span", { class: "state", title: state.text }, el("span", { class: `dot ${state.tone}`, "aria-hidden": "true" }), state.text));
}

function rowsFor(app) {
	const main = servedVersion(app);
	const title = app.folder?.displayName?.trim();
	const rows = [
		el(
			"tr",
			{},
			el("td", {}, el("a", { class: "address", href: app.url }, bare(app.url)), title && title !== app.name ? el("span", { class: "title" }, title) : null),
			goesToCell(app, main, true),
			stateCell(versionState(app, main)),
		),
	];
	if (app.versions.length > 1) {
		for (const version of app.versions) {
			rows.push(
				el(
					"tr",
					{ class: "version" },
					el("td", {}, el("a", { class: "address", href: version.url }, bare(version.url)), version.default ? el("span", { class: "title" }, "default") : null),
					goesToCell(app, version, false),
					stateCell(versionState(app, version)),
				),
			);
		}
	}
	return rows;
}

function render(apps) {
	const sorted = [...apps].sort((a, b) => a.name.localeCompare(b.name));
	if (sorted.length === 0) {
		routes.replaceChildren(el("tr", {}, el("td", { colspan: 3, class: "muted" }, "No apps yet. Add a folder to the XO root, or add an app in the launcher.")));
	} else {
		routes.replaceChildren(...sorted.flatMap(rowsFor));
	}
	const running = sorted.filter((app) => servedVersion(app)?.state === "running").length;
	summary.textContent = `${sorted.length} ${sorted.length === 1 ? "app" : "apps"}${running ? `, ${running} running` : ""}`;
}

function showRoots(list) {
	roots = list;
	rootsLine.textContent = list.length ? `Folders from ${list.map(homeShort).join(", ")}` : "No XO root: only added apps are routed.";
}

function showProblem(message) {
	summary.textContent = message;
}

let names = null;
let detailedAt = 0;
let loading = null;
let first = true;

function loadDetail() {
	loading ??= getJson("/__xo/api/targets")
		.then(({ targets }) => {
			detailedAt = Date.now();
			render(targets ?? []);
		})
		.catch((error) => showProblem(`Couldn't read the routes: ${error.message}`))
		.finally(() => {
			loading = null;
		});
	return loading;
}

async function tick() {
	if (first || document.visibilityState === "visible") {
		first = false;
		try {
			const health = await getJson("/__xo/health");
			showRoots(health.roots ?? []);
			const key = (health.apps ?? []).join("\n");
			if (key !== names || Date.now() - detailedAt >= DETAIL_MS) {
				names = key;
				await loadDetail();
			}
		} catch (error) {
			names = null;
			showProblem(`galileo didn't answer: ${error.message}`);
		}
	}
	setTimeout(tick, HEALTH_MS);
}

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") void loadDetail();
});
void tick();
