/**
 * galileo's home page: the routes table, kept current. The app names are read
 * every 2 seconds while the page is visible (`/__xo/health`, cheap); every app
 * in detail (`/__xo/api/targets`) when those names change, when the page comes
 * back, and every 10 seconds. Everything is built with text nodes.
 */
const HEALTH_MS = 2000;
const DETAIL_MS = 10_000;

const port = location.port || "80";
for (const node of document.querySelectorAll("[data-port]")) node.textContent = port;

const routes = document.getElementById("routes");
const summary = document.getElementById("summary");

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

/** An address without its scheme and trailing slash: `acme.localhost:4100`. */
function bare(url) {
	return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** The version the app's own address serves. */
function servedVersion(app) {
	return app.versions.find((version) => version.default) ?? app.versions[0];
}

function stateCell(version) {
	const up = Boolean(version?.up);
	const text = up ? "answering" : "not answering";
	return el("td", {}, el("span", { class: "state" }, el("span", { class: `dot ${up ? "up" : "down"}`, "aria-hidden": "true" }), text));
}

/** Where a row's requests go: its port or URL, or for an app with versions, which one it serves. */
function goesToCell(app, version, isMain) {
	const what = isMain && app.versions.length > 1 ? `its ${version.name} version` : bare(version.upstream);
	return el("td", { class: "target" }, el("span", { class: "what" }, what));
}

function rowsFor(app) {
	const main = servedVersion(app);
	const rows = [el("tr", {}, el("td", {}, el("a", { class: "address", href: app.url }, bare(app.url))), goesToCell(app, main, true), stateCell(main))];
	if (app.versions.length > 1) {
		for (const version of app.versions) {
			rows.push(
				el(
					"tr",
					{ class: "version" },
					el("td", {}, el("a", { class: "address", href: version.url }, bare(version.url)), version.default ? el("span", { class: "title" }, "default") : null),
					goesToCell(app, version, false),
					stateCell(version),
				),
			);
		}
	}
	return rows;
}

function render(apps) {
	const sorted = [...apps].sort((a, b) => a.name.localeCompare(b.name));
	if (sorted.length === 0) {
		routes.replaceChildren(el("tr", {}, el("td", { colspan: 3, class: "muted" }, "No apps yet. Add one in the launcher, with a name and its port.")));
	} else {
		routes.replaceChildren(...sorted.flatMap(rowsFor));
	}
	const answering = sorted.filter((app) => servedVersion(app)?.up).length;
	summary.textContent = `${sorted.length} ${sorted.length === 1 ? "app" : "apps"}, ${answering} answering`;
}

let names = null;
let detailedAt = 0;
let loading = null;
// The first look happens even in a background tab, so the page isn't empty when it is shown.
let first = true;

function loadDetail() {
	loading ??= getJson("/__xo/api/targets")
		.then(({ targets }) => {
			detailedAt = Date.now();
			render(targets ?? []);
		})
		.catch((error) => {
			summary.textContent = `Couldn't read the routes: ${error.message}`;
		})
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
			const key = (health.apps ?? []).join("\n");
			if (key !== names || Date.now() - detailedAt >= DETAIL_MS) {
				names = key;
				await loadDetail();
			}
		} catch (error) {
			names = null;
			summary.textContent = `galileo didn't answer: ${error.message}`;
		}
	}
	setTimeout(tick, HEALTH_MS);
}

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") void loadDetail();
});
void tick();
