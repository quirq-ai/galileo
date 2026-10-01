// The launcher: the gateway's apps with their live status, and their telescope
// designs. It is the only page allowed to add or remove apps, or to change any
// app's design, because no app code ever runs on this origin.
//
// The design editor is telescope's own (XoDesigner, from telescope/, served
// at /__xo/toolbar/designer.js), mounted in shadow roots so telescope's styles
// and this page's never meet.
const port = location.port || "80";
const list = document.getElementById("apps");
const form = document.getElementById("add");
const nameInput = document.getElementById("name");
const versionInput = document.getElementById("version");
const upstreamInput = document.getElementById("upstream");
const addButton = document.getElementById("add-button");
const errorLine = document.getElementById("error");
const previewUrl = document.getElementById("preview-url");
const dialog = document.getElementById("editor");
const editorHost = document.getElementById("editor-host");
const defaultPreview = document.getElementById("default-preview");
const defaultSummary = document.getElementById("design-summary");

document.getElementById("gateway").textContent = `gateway on :${port}`;
document.getElementById("edit-default").addEventListener("click", () => openEditor(null));

let targets = [];
let designs = null;
let versionDraft = null;
let shownDefault = "";
let defaultObserver = null;
let editor = null;

function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "class") node.className = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, value);
	}
	node.append(...children.filter((child) => child !== null && child !== undefined));
	return node;
}

async function api(method, path, body) {
	const response = await fetch(path, {
		method,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
	return data;
}

// ---------------------------------------------------------------- apps

function row(target) {
	const remove = el("button", { class: "quiet", type: "button", "aria-label": `Remove ${target.name}` }, "Remove");
	remove.addEventListener("click", async () => {
		remove.disabled = true;
		try {
			await api("DELETE", `/__xo/api/targets/${encodeURIComponent(target.name)}`);
			await load();
		} catch (error) {
			showError(error.message);
			remove.disabled = false;
		}
	});
	const design = designs?.apps.find((app) => app.name === target.name);
	const own = design?.source === "app";
	const toolbarButton = el(
		"button",
		{
			class: "quiet",
			type: "button",
			title: own ? `${target.name} has its own telescope design` : `${target.name} uses the default telescope design`,
			"aria-label": `Edit ${target.name}'s telescope`,
		},
		"Telescope",
		el("span", { class: `badge${own ? " own" : ""}` }, own ? "own" : "default"),
	);
	toolbarButton.addEventListener("click", () => openEditor(target.name));
	return el(
		"li",
		{ class: `app ${target.up ? "up" : "down"}` },
		el("span", { class: "dot", title: target.up ? "Answering" : "Not answering" }),
		el(
			"div",
			{ class: "info" },
			el("div", { class: "name" }, target.name, el("span", { class: "muted" }, ` · serves ${target.defaultVersion}`)),
			el("a", { class: "mono", href: target.url }, target.url.replace(/\/$/, "")),
		),
		el("div", { class: "actions" }, toolbarButton, el("a", { class: "open", href: target.url }, "Open"), remove),
		versionList(target),
	);
}

/** An app's versions: each on its own address, which one the app's address serves, and a way to add another. */
function versionList(target) {
	const items = target.versions.map((version) => {
		const actions = el("span", { class: "version-actions" });
		if (!version.default) {
			actions.append(button("Make default", `Serve ${version.name} at ${target.url}`, async () => {
				await api("PATCH", `/__xo/api/targets/${target.name}`, { defaultVersion: version.name });
			}));
		}
		if (target.versions.length > 1) {
			actions.append(button("Remove", `Remove the ${version.name} version of ${target.name}`, async () => {
				await api("DELETE", `/__xo/api/targets/${target.name}/versions/${version.name}`);
			}));
		}
		return el(
			"li",
			{ class: `version ${version.up ? "up" : "down"}` },
			el("span", { class: "dot small", title: version.up ? "Answering" : "Not answering" }),
			el("span", { class: "version-name" }, version.name),
			version.default ? el("span", { class: "badge own" }, "default") : null,
			el("a", { class: "mono", href: version.url }, version.url.replace(/^http:\/\//, "").replace(/\/$/, "")),
			el("span", { class: "muted mono" }, `→ ${version.upstream.replace(/^https?:\/\//, "")}${version.up ? "" : " · not answering"}`),
			actions,
		);
	});
	return el("ul", { class: "versions" }, ...items, el("li", { class: "version-add" }, addVersion(target)));
}

/** A small button that runs an action against the launcher's API, then reloads the list. */
function button(label, title, action) {
	const node = el("button", { class: "quiet small", type: "button", title }, label);
	node.addEventListener("click", async () => {
		node.disabled = true;
		try {
			await action();
			await load();
		} catch (error) {
			showError(error.message);
			node.disabled = false;
		}
	});
	return node;
}

function addVersion(target) {
	if (versionDraft?.app !== target.name) {
		const open = el("button", { class: "quiet small", type: "button", title: `Add a version of ${target.name}, like live or a preview` }, "+ Version");
		open.addEventListener("click", () => {
			versionDraft = { app: target.name, name: "", upstream: "" };
			load().then(() => list.querySelector(".version-form input")?.focus());
		});
		return open;
	}
	const nameField = el("input", { placeholder: "live", "aria-label": "Version name", autocomplete: "off", spellcheck: "false" });
	const upstreamField = el("input", { placeholder: "port or https://…", "aria-label": "Port or URL", autocomplete: "off", spellcheck: "false" });
	nameField.value = versionDraft.name;
	upstreamField.value = versionDraft.upstream;
	nameField.addEventListener("input", () => (versionDraft.name = nameField.value));
	upstreamField.addEventListener("input", () => (versionDraft.upstream = upstreamField.value));
	const cancel = el("button", { class: "quiet small", type: "button" }, "Cancel");
	cancel.addEventListener("click", () => {
		versionDraft = null;
		load();
	});
	const form = el(
		"form",
		{ class: "version-form" },
		nameField,
		upstreamField,
		el("button", { class: "small", type: "submit" }, "Add version"),
		cancel,
		versionDraft.error ? el("span", { class: "error inline", role: "alert" }, versionDraft.error) : null,
	);
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		try {
			await api("POST", "/__xo/api/targets", { name: target.name, version: nameField.value, upstream: upstreamField.value });
			versionDraft = null;
			await load();
		} catch (error) {
			versionDraft.error = error.message;
			await load();
			list.querySelector(".version-form input")?.focus();
		}
	});
	return form;
}

async function load() {
	try {
		[{ targets }, designs] = await Promise.all([api("GET", "/__xo/api/targets"), api("GET", "/__xo/api/toolbars")]);
		list.replaceChildren(...(targets.length ? targets.map(row) : [el("li", { class: "empty" }, "No apps yet. Add one below.")]));
		showDefault();
	} catch (error) {
		showError(`Couldn't load apps: ${error.message}`);
	}
}

function showError(message) {
	errorLine.textContent = message;
	errorLine.hidden = !message;
}

function updatePreview() {
	const name = nameInput.value.trim().toLowerCase() || "name";
	const version = versionInput.value.trim().toLowerCase();
	previewUrl.textContent = version ? `http://${version}.${name}.localhost:${port}/` : `http://${name}.localhost:${port}/`;
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	showError("");
	addButton.disabled = true;
	try {
		await api("POST", "/__xo/api/targets", { name: nameInput.value, version: versionInput.value, upstream: upstreamInput.value });
		form.reset();
		updatePreview();
		await load();
	} catch (error) {
		showError(error.message);
	} finally {
		addButton.disabled = false;
	}
});
nameInput.addEventListener("input", updatePreview);
versionInput.addEventListener("input", updatePreview);
document.getElementById("pick-example").textContent = `acme.localhost:${port}/live`;

// ---------------------------------------------------------------- designs

let sheet = null;

/** A shadow root holding telescope's styles, so they and this page's never meet. */
function shadowOf(host) {
	if (!sheet) {
		sheet = new CSSStyleSheet();
		sheet.replaceSync([XoUi.STYLES, XoDesigner.STYLES, EDITOR_STYLES].join("\n"));
	}
	const root = host.shadowRoot || host.attachShadow({ mode: "open" });
	root.adoptedStyleSheets = [sheet];
	return root;
}

function showDefault() {
	if (!designs || typeof XoDesigner === "undefined") return;
	const { layout, source } = designs.default;
	const custom = designs.apps.filter((app) => app.source === "app").map((app) => app.name);
	defaultSummary.textContent =
		(source === "gateway" ? "Every app uses this design until it has its own." : "telescope's built-in design. Edit it to set every app's default.") +
		(custom.length ? ` ${custom.join(", ")} ${custom.length === 1 ? "has its" : "have their"} own.` : "");
	const key = JSON.stringify(layout);
	if (key === shownDefault) return;
	shownDefault = key;
	const ui = XoUi.create(document);
	const preview = XoDesigner.preview(ui, layout, { app: "any app" });
	shadowOf(defaultPreview).replaceChildren(preview.element);
	preview.fit();
	defaultObserver?.disconnect();
	defaultObserver = new ResizeObserver(() => preview.fit());
	defaultObserver.observe(preview.element);
}

/** Edits one app's design (`name`), or the gateway's default one (`null`), with a live preview. */
function openEditor(name) {
	if (!designs || typeof XoDesigner === "undefined") return;
	const entry = name ? designs.apps.find((app) => app.name === name) : designs.default;
	if (!entry) return;
	const path = `/__xo/api/toolbars/${name || "_default"}`;
	const ui = XoUi.create(document);
	const { h } = ui;
	const shell = h("div", { class: "xo shell" });
	const stage = h("div", { class: "stage" });
	const toast = h("div", { class: "toast", role: "status", hidden: true });
	let preview = null;
	let saveTimer = 0;
	let saveSeq = 0;
	let pending = null;
	let toastTimer = 0;

	function showPreview(layout) {
		preview = XoDesigner.preview(ui, layout, { app: name || "any app" });
		XoUi.theme(shell, layout.theme.accent);
		stage.replaceChildren(
			h(
				"div",
				{ class: "stage-head" },
				h("span", { class: "side-label" }, "Preview"),
				h("span", { class: "grow" }),
				entry.url ? h("a", { class: "btn", href: entry.url, target: "_blank", rel: "noopener" }, `Open ${name}`) : null,
			),
			preview.element,
			h(
				"p",
				{ class: "hint" },
				name
					? `How ${name} shows telescope with this design. Changes save as you make them; an open ${name} tab picks them up when you return to it.`
					: "How every app without its own design shows telescope. Changes save as you make them.",
			),
		);
		preview.fit();
	}

	function say(message, isError) {
		toast.textContent = message;
		toast.classList.toggle("error", Boolean(isError));
		toast.hidden = false;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast.hidden = true), isError ? 4000 : 2200);
	}

	async function save() {
		saveTimer = 0;
		if (!pending) return;
		const layout = pending;
		pending = null;
		const seq = ++saveSeq;
		try {
			const data = await api("PUT", path, layout);
			if (seq !== saveSeq) return;
			designer.setStatus(name ? `Saved. ${name} has its own design.` : "Saved. Apps without their own design use it.");
			// The gateway may have tidied the design: show what it kept.
			if (JSON.stringify(data.layout) !== JSON.stringify(layout)) {
				designer.setLayout(data.layout, data.source);
				showPreview(data.layout);
			}
		} catch (error) {
			if (seq === saveSeq) designer.setStatus(`Couldn't save: ${error.message}`);
		}
	}

	/** A design replaced whole (edited JSON, or a reset), dropping any change still waiting to be saved. */
	async function replace(request) {
		clearTimeout(saveTimer);
		saveTimer = 0;
		pending = null;
		++saveSeq;
		const data = await request;
		showPreview(data.layout);
		return data;
	}

	const designer = XoDesigner.create({
		ui,
		layout: entry.layout,
		source: entry.source,
		title: name ? `${name}'s telescope` : "Default telescope",
		subtitle: `data/toolbars/${name || "_default"}.json`,
		describe: (source) => describe(name, source),
		commit(next, message) {
			showPreview(next);
			if (message) say(message);
			designer.setStatus("Saving…");
			pending = next;
			clearTimeout(saveTimer);
			saveTimer = setTimeout(save, 300);
		},
		apply: (json) => replace(api("PUT", path, json)),
		reset: () => replace(api("DELETE", path)),
		canReset: (source) => (name ? source === "app" : source === "gateway"),
		resetLabel: name ? "Use the default design" : "Back to the built-in design",
		resetDone: name ? `${name} uses the default design again` : "The default is the built-in design again",
		previewAccent(color) {
			XoUi.theme(shell, color);
			if (preview) XoUi.theme(preview.element, color);
		},
		onClose: () => dialog.close(),
		toast: say,
	});

	shell.append(stage, h("div", { class: "side" }, designer.element), toast);
	shadowOf(editorHost).replaceChildren(shell);
	showPreview(entry.layout);
	designer.render();
	editor = {
		flush: () => (saveTimer ? (clearTimeout(saveTimer), save()) : Promise.resolve()),
		observer: new ResizeObserver(() => preview?.fit()),
	};
	editor.observer.observe(stage);
	dialog.showModal();
}

function describe(name, source) {
	if (!name) {
		return source === "gateway"
			? "Every app without its own design uses this."
			: "telescope's built-in design. A change here becomes every app's default.";
	}
	if (source === "app") return `${name} has its own design.`;
	const base = source === "gateway" ? "the default design" : "the built-in design";
	return `${name} uses ${base}. A change here gives ${name} its own.`;
}

dialog.addEventListener("close", async () => {
	const closing = editor;
	editor = null;
	if (closing) {
		closing.observer.disconnect();
		await closing.flush();
	}
	await load();
});

const EDITOR_STYLES = `
.shell { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 400px; height: min(780px, calc(100vh - 48px)); background: var(--surface); }
.stage { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 16px 18px; overflow: auto; border-right: 1px solid rgba(255, 255, 255, 0.08); }
.stage-head { display: flex; align-items: center; gap: 8px; }
.stage .hint { margin: 0; }
.side { display: flex; flex-direction: column; min-height: 0; }
.toast { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); max-width: calc(100% - 32px); padding: 7px 12px; border-radius: 8px;
  background: var(--accent); color: var(--accent-ink); font-weight: 600; pointer-events: none; }
.toast.error { background: #ffb4a8; color: #2a0b06; }
a.btn { text-decoration: none; }
@media (max-width: 860px) {
  .shell { grid-template-columns: 1fr; height: auto; max-height: calc(100vh - 48px); overflow: auto; }
  .stage { border-right: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .side { min-height: 560px; }
}
`;

updatePreview();
load();
setInterval(() => {
	// Status polling pauses while a design or a new version is being edited, so nothing shifts under the cursor.
	if (!dialog.open && !versionDraft) load();
}, 3000);
