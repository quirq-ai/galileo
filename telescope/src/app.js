/*!
 * telescope, the app.
 *
 * The loader runs this file inside a hidden iframe that shares the page's
 * origin, then calls `initXoToolbar`. The app draws into the loader's closed
 * shadow root and listens on the page, so its own globals never mix with the
 * page's while it can still read and measure every element.
 *
 * Everything that touches the page goes through `page` (the page's window),
 * including timers and animation frames: a hidden iframe does not get
 * animation frames, and a stylesheet or node must come from the page's own
 * document to be used there.
 *
 * The bar is built from the app's telescope design (`GET /__xo/api/toolbar`):
 * which tools, in what order, where it docks, labels and accent color. The
 * Customize panel edits that design live and saves it for the app. Pages can
 * add buttons of their own through `window.__xo_toolbar.addTool`.
 *
 * Modes:
 *   inspect   hover shows a tooltip; click selects and opens a card that can
 *             ask the agent, screenshot the element, copy it for an agent, or comment
 *   comment   click drops a pin where you clicked and opens a composer
 *   area      drag to capture part of the page, or click to capture one element
 *
 * Captures (screenshot, area, record) open a review: mark up the image, add a
 * note, then ask the agent, save it as a comment, copy or download it.
 */
(function () {
	"use strict";

	var AUTHOR = "Local user";
	var TOOLS = XoUi.TOOLS;
	var POSITIONS = XoDesigner.GRID;
	var LOG_FILTERS = [["all", "All"], ["error", "Errors"], ["warn", "Warnings"], ["network", "Requests"]];

	/** The toolbar's own styles; the shared base is XoUi.STYLES and the editor's is XoDesigner.STYLES. */
	var STYLES = [
		".layer { position: fixed; inset: 0; pointer-events: none; }",
		".layer.capturing { visibility: hidden; }",
		".viewport { position: fixed; inset: 0; pointer-events: none; }",
		".box { position: fixed; z-index: 1; border: 2px solid var(--accent); background: var(--accent-soft);",
		"  border-radius: 3px; pointer-events: none; }",
		".box.selected { background: transparent; box-shadow: 0 0 0 4px var(--accent-mid); }",
		".pins { position: fixed; inset: 0; z-index: 2; pointer-events: none; }",
		".pin { all: unset; position: fixed; width: 26px; height: 26px; margin: -13px 0 0 -13px; pointer-events: auto;",
		"  border-radius: 13px 13px 13px 3px; border: 2px solid #10150c; background: var(--accent); color: var(--accent-ink);",
		"  font: 700 12px/22px ui-sans-serif, system-ui, sans-serif; text-align: center; cursor: pointer;",
		"  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35); }",
		".pin.resolved { background: #5d6657; color: #eef2ea; }",
		".pin:focus-visible { outline: 2px solid #eef2ea; outline-offset: 2px; }",
		".tip, .card, .composer { position: fixed; z-index: 3; max-width: 340px; padding: 10px 12px;",
		"  background: var(--surface); border: 1px solid var(--accent-line); border-radius: 12px;",
		"  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.4); }",
		".tip { pointer-events: none; }",
		".card, .composer { pointer-events: auto; width: 340px; }",
		".quote { margin-top: 6px; color: #dfe6d8; }",
		".swatch { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border-radius: 2px;",
		"  border: 1px solid rgba(255, 255, 255, 0.35); vertical-align: -1px; }",
		".bar.recording { border-color: rgba(255, 107, 94, 0.65); }",
		".tool.stop { background: #ff6b5e; color: #1a0703; font-weight: 600; }",
		".tool.stop:hover { background: #ff8479; }",
		".live-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #ff6b5e; box-shadow: 0 0 0 3px rgba(255, 107, 94, 0.2); }",
		".rec { display: inline-flex; align-items: center; gap: 8px; padding: 0 6px 0 10px; font-weight: 600; color: #ffd2cc; white-space: nowrap; }",
		".rec-dot { width: 9px; height: 9px; border-radius: 50%; background: #ff4d4f; animation: xo-blink 1.2s ease-in-out infinite; }",
		".rec-dot.paused { animation: none; background: var(--muted); }",
		"@keyframes xo-blink { 50% { opacity: 0.3; } }",
		".timer { min-width: 76px; padding: 0 6px; color: #dfe6d8; font-variant-numeric: tabular-nums; white-space: nowrap; }",
		".guides { position: fixed; inset: 0; z-index: 4; pointer-events: none; }",
		".guide { position: fixed; width: 128px; height: 40px; border: 2px dashed rgba(255, 255, 255, 0.4);",
		"  border-radius: 999px; background: rgba(17, 20, 16, 0.35); }",
		".guide.near { border-style: solid; border-color: var(--accent); background: var(--accent-soft); }",
		".panel { position: fixed; top: 16px; right: 16px; bottom: 72px; z-index: 4; display: flex; flex-direction: column;",
		"  width: min(380px, calc(100vw - 32px)); pointer-events: auto; overflow: hidden;",
		"  background: var(--surface); border: 1px solid var(--accent-line); border-radius: 14px;",
		"  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42); }",
		".layer[data-dock^='top'] .panel { top: 66px; bottom: 16px; }",
		".item { all: unset; display: flex; gap: 10px; width: 100%; box-sizing: border-box; padding: 10px 8px;",
		"  border-radius: 9px; cursor: pointer; }",
		".item:hover { background: rgba(255, 255, 255, 0.06); }",
		".item:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }",
		".item .text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }",
		".num { flex: none; width: 22px; height: 22px; border-radius: 11px 11px 11px 3px; background: var(--accent); color: var(--accent-ink);",
		"  font-size: 11px; font-weight: 700; line-height: 22px; text-align: center; }",
		".num.resolved { background: #5d6657; color: #eef2ea; }",
		".comment { padding: 10px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.07); }",
		".comment:last-child { border-bottom: 0; }",
		".comment p { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }",
		".attachments { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }",
		".shot { display: block; border-radius: 8px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.12); }",
		".shot img { display: block; max-width: 100%; max-height: 220px; margin: 0 auto; }",
		".clip { display: block; width: 100%; max-height: 240px; border-radius: 8px; background: #000; }",
		".menu { position: fixed; z-index: 6; min-width: 250px; max-width: min(340px, calc(100vw - 16px)); padding: 6px;",
		"  max-height: min(70vh, 560px); overflow-y: auto; overscroll-behavior: contain;",
		"  pointer-events: auto; background: var(--surface); border: 1px solid var(--accent-line); border-radius: 12px;",
		"  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.42); }",
		".menu-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px;",
		"  color: var(--text); text-decoration: none; cursor: pointer; }",
		".menu-item:hover { background: rgba(255, 255, 255, 0.07); }",
		".menu-item.current { background: var(--accent-soft); }",
		".menu-item:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 1px; }",
		".menu-item .grow { display: flex; flex: 1; flex-direction: column; min-width: 0; }",
		".menu-item .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }",
		".menu.wide { min-width: 300px; max-width: min(420px, calc(100vw - 16px)); }",
		".menu-name, .menu-title { font-weight: 600; }",
		".menu-title { padding: 8px 10px 2px; }",
		".menu-sep { height: 1px; margin: 6px 4px; background: rgba(255, 255, 255, 0.1); }",
		".menu-note { padding: 6px 10px; color: var(--muted); }",
		".menu .row { margin: 6px 4px 4px; }",
		".menu-section { padding: 8px 10px 2px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }",
		".version-chip { padding: 1px 7px; border-radius: 9px; background: var(--accent-mid); color: var(--accent-text);",
		"  font-size: 11px; font-weight: 600; }",
		".tool[aria-pressed='true'] .version-chip { background: rgba(16, 21, 12, 0.2); color: var(--accent-ink); }",
		".toast { position: fixed; z-index: 10; max-width: min(440px, calc(100vw - 16px)); padding: 7px 12px;",
		"  border-radius: 8px; background: var(--accent); color: var(--accent-ink); font-weight: 600; pointer-events: none; }",
		".toast.error { background: #ffb4a8; color: #2a0b06; }",
		".area { position: fixed; inset: 0; z-index: 7; cursor: crosshair; pointer-events: auto; background: rgba(8, 10, 7, 0.14); touch-action: none; }",
		".area.dragging { background: transparent; }",
		".area-box { position: fixed; pointer-events: none; border: 2px solid var(--accent); border-radius: 3px; }",
		".area-box.element { background: var(--accent-soft); }",
		".area-box.drag { box-shadow: 0 0 0 100vmax rgba(8, 10, 7, 0.4); }",
		".area-hint { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); padding: 7px 12px; border-radius: 8px;",
		"  background: var(--surface); border: 1px solid var(--accent-line); white-space: nowrap; pointer-events: none; }",
		".area-size { position: fixed; padding: 2px 6px; border-radius: 5px; background: var(--surface); font-size: 11px; pointer-events: none; }",
		".ripple { position: fixed; z-index: 9; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%;",
		"  border: 3px solid var(--accent); background: var(--accent-mid); pointer-events: none; animation: xo-ripple 0.65s ease-out forwards; }",
		"@keyframes xo-ripple { from { transform: scale(0.35); opacity: 1; } to { transform: scale(1.7); opacity: 0; } }",
		".review-layer { position: fixed; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center;",
		"  padding: 16px; background: rgba(6, 8, 5, 0.66); pointer-events: auto; }",
		".review { display: flex; flex-direction: column; width: min(1200px, 100%); height: min(860px, 100%); overflow: hidden;",
		"  background: var(--surface); border: 1px solid var(--accent-line); border-radius: 14px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5); }",
		".review-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 12px 14px;",
		"  border-bottom: 1px solid rgba(255, 255, 255, 0.08); }",
		".review-body { flex: 1; min-height: 0; display: flex; }",
		".review-media { flex: 1; min-width: 0; display: flex; flex-direction: column; }",
		".review-video { display: block; max-width: 100%; max-height: 100%; border-radius: 6px; background: #000; }",
		".review-side { width: 310px; flex: none; display: flex; flex-direction: column; gap: 8px; padding: 14px; overflow: auto;",
		"  border-left: 1px solid rgba(255, 255, 255, 0.08); }",
		".review-actions { display: flex; flex-wrap: wrap; gap: 6px; }",
		".review-side .check { padding: 2px 0; }",
		".side-label { margin-top: 6px; }",
		"@media (max-width: 760px) { .review-body { flex-direction: column; }",
		"  .review-side { width: auto; max-height: 48%; border-left: 0; border-top: 1px solid rgba(255, 255, 255, 0.08); } }",
		".tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 12px 0; }",
		".tab { all: unset; display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 7px;",
		"  cursor: pointer; color: var(--muted); font-size: 12px; }",
		".tab[aria-selected='true'] { background: rgba(255, 255, 255, 0.08); color: var(--text); }",
		".log { border-bottom: 1px solid rgba(255, 255, 255, 0.06); }",
		".log summary { display: flex; gap: 8px; align-items: baseline; padding: 7px 2px; cursor: pointer; list-style: none; }",
		".log summary::-webkit-details-marker { display: none; }",
		".log-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }",
		".log-time { flex: none; font-size: 11px; }",
		".level { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); transform: translateY(-1px); }",
		".level.error { background: #ff6b5e; }",
		".level.warn { background: #ffb05c; }",
		".log-detail { margin: 0 0 8px 16px; }",
		".stack { margin: 4px 0 0; padding: 8px; border-radius: 6px; background: #0b0d0a; color: #c9d1c1; white-space: pre-wrap;",
		"  overflow-wrap: anywhere; max-height: 220px; overflow: auto; }",
	].join("\n");

	window.initXoToolbar = function initXoToolbar(options) {
		return createToolbar(options);
	};

	function createToolbar(options) {
		var root = options.root;
		var host = options.host;
		var page = options.page;
		var config = options.config;
		var logs = options.logs || emptyLog();
		var doc = page.document;
		var ui = XoUi.create(doc);
		var h = ui.h;
		var icon = ui.icon;

		var cachedLayout = parseLayout(readLocal("layout"));
		var state = {
			layout: cachedLayout || clone(XoToolbarSchema.defaultLayout),
			layoutSource: (cachedLayout && readLocal("layout-source")) || "built-in",
			saveStatus: "",
			open: true,
			mode: "idle",
			hovered: null,
			selected: null,
			composer: null,
			panel: null,
			threadId: null,
			threads: [],
			path: page.location.pathname,
			pendingPrompt: null,
			review: null,
			recording: null,
			starting: false,
			logFilter: "all",
			navMenu: null,
		};
		var sessionOpen = readSession("open");
		state.open = sessionOpen === null ? state.layout.dock.startOpen : sessionOpen !== "0";
		var pins = new Map();
		var navParts = null;
		var runtimeTools = new Map();
		var toolButtons = {};
		var cleanups = [];
		var frameRequest = 0;
		var toastTimer = 0;
		var saveTimer = 0;
		var saveSeq = 0;
		var logsDirty = false;
		var saving = false;
		var destroyed = false;
		var justDragged = false;

		// ---------------------------------------------------------------- DOM

		var sheet = new page.CSSStyleSheet();
		sheet.replaceSync([XoUi.STYLES, XoDesigner.STYLES, XoAnnotate.STYLES, STYLES].join("\n"));
		root.adoptedStyleSheets = [sheet];

		var layer = h("div", { class: "layer xo" });
		// Always rendered, never hidden: what a framed page's capture is cropped to.
		var viewportTarget = h("div", { class: "viewport", "aria-hidden": "true" });
		var hoverBox = h("div", { class: "box", hidden: true });
		var selectBox = h("div", { class: "box selected", hidden: true });
		var pinsLayer = h("div", { class: "pins" });
		var ripples = h("div", { class: "pins" });
		var tip = h("div", { class: "tip", hidden: true });
		var card = h("div", { class: "card", hidden: true, role: "dialog", "aria-label": "Selected element" });
		var composer = h("div", { class: "composer", hidden: true, role: "dialog", "aria-label": "New comment" });
		var panel = h("div", { class: "panel", hidden: true, role: "dialog", "aria-label": "Panel" });
		var guides = h("div", { class: "guides", hidden: true });
		var appMenu = h("div", { class: "menu", hidden: true, role: "menu", "aria-label": "Navbar" });
		var recordMenu = h("div", { class: "menu", hidden: true, role: "dialog", "aria-label": "Record this tab" });
		var areaLayer = h("div", { class: "area", hidden: true, role: "application", "aria-label": "Capture an area" });
		var areaBox = h("div", { class: "area-box", hidden: true });
		var areaSize = h("div", { class: "area-size mono", hidden: true });
		var areaHint = h("div", { class: "area-hint" }, "Drag to capture an area, or click an element · Esc to cancel");
		areaLayer.append(areaBox, areaSize, areaHint);
		var reviewLayer = h("div", { class: "review-layer", hidden: true });
		var toast = h("div", { class: "toast", hidden: true, role: "status", "aria-live": "polite" });

		var logoButton = h("button", {
			class: "logo",
			type: "button",
			title: "telescope (Alt+Shift+X) · drag to move",
			"aria-label": "telescope",
			"aria-expanded": "true",
			onclick: function () {
				// A drag of the handle ends in a click too; that one isn't a toggle.
				if (justDragged) {
					justDragged = false;
					return;
				}
				toggleOpen();
			},
		}, "XO");
		var bar = h("div", { class: "bar", role: "toolbar", "aria-label": "telescope" });

		layer.append(hoverBox, selectBox, pinsLayer, ripples, tip, card, composer, panel, guides, bar, appMenu, recordMenu,
			areaLayer, reviewLayer, toast);
		root.append(viewportTarget, layer);

		var capture = XoCapture.create(page, {
			hideUi: function () {
				layer.classList.add("capturing");
				return function () {
					layer.classList.remove("capturing");
				};
			},
			viewportTarget: function () {
				return viewportTarget;
			},
			onChange: function () {
				renderBar();
			},
		});

		// The Customize panel: the same editor the gateway's launcher uses. Every
		// change goes to applyLayout, which shows it at once and saves it.
		var designer = XoDesigner.create({
			ui: ui,
			layout: state.layout,
			source: state.layoutSource,
			title: "Customize telescope",
			subtitle: "data/toolbars/" + appName() + ".json",
			describe: describeSource,
			commit: applyLayout,
			apply: function (json) {
				return replaceLayout(request("PUT", "/toolbar", json));
			},
			reset: function () {
				return replaceLayout(request("DELETE", "/toolbar"));
			},
			canReset: function (source) {
				return source === "app";
			},
			resetLabel: "Use the default design",
			resetDone: appName() + " uses the default design again",
			previewAccent: function (color) {
				XoUi.theme(layer, color);
			},
			extras: function () {
				return runtimeTools.size ? [{ title: "Added by this page", content: runtimeList() }] : [];
			},
			onClose: closePanel,
			toast: showToast,
		});

		cleanups.push(logs.subscribe(function () {
			updateBadges();
			if (state.panel === "logs") logsDirty = true;
		}));

		setUpDrag();
		setUpArea();

		// Keys and clicks inside the toolbar stay inside it: page shortcuts and
		// click-outside handlers never see them.
		["keydown", "keyup", "keypress", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick",
			"contextmenu", "focusin", "focusout", "input", "change"].forEach(function (type) {
			root.addEventListener(type, function (event) {
				event.stopPropagation();
			});
		});

		// ------------------------------------------------------------ page events

		var BLOCKED = ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick", "contextmenu",
			"touchstart", "touchend"];
		BLOCKED.forEach(function (type) {
			listen(page, type, function (event) {
				if ((state.mode === "inspect" || state.mode === "comment") && !isOurs(event)) block(event);
			}, { capture: true, passive: false });
		});
		listen(page, "click", onClick, { capture: true, passive: false });
		listen(page, "pointermove", onPointerMove, { capture: true, passive: true });
		listen(page, "pointerdown", function (event) {
			if (isOurs(event)) return;
			closePopovers();
			var recording = state.recording;
			if (recording && recording.prefs.clicks && !recording.controls.paused()) ripple(event.clientX, event.clientY);
		}, { capture: true, passive: true });
		listen(page, "keydown", onKeyDown, { capture: true });
		listen(doc, "visibilitychange", function () {
			// The design may have been edited on the gateway's launcher meanwhile.
			if (doc.visibilityState === "visible") loadLayout();
		});
		listen(page, "resize", function () {
			fitBar();
			if (state.review && state.review.editor) state.review.editor.fit();
		});

		var routeTimer = page.setInterval(watchPage, 500);
		cleanups.push(function () {
			page.clearInterval(routeTimer);
		});

		renderBar();
		loadLayout();
		loadThreads();
		frameRequest = page.requestAnimationFrame(tick);

		return { debug: debug, destroy: destroy, addTool: addTool, removeTool: removeTool };

		// ------------------------------------------------------------ the bar

		/** Rebuilds the bar from the design: its tools in order, then the page's own tools, then Customize. */
		function renderBar() {
			if (destroyed) return;
			var layout = state.layout;
			XoUi.theme(layer, layout.theme.accent);
			layer.setAttribute("data-dock", layout.dock.position);
			bar.classList.toggle("no-labels", !layout.dock.labels);
			bar.classList.toggle("recording", Boolean(state.recording));
			toolButtons = {};
			if (state.recording) {
				bar.replaceChildren.apply(bar, recordingControls());
			} else {
				var extras = h("div", { class: "extras" });
				XoUi.visibleItems(layout.items).forEach(function (item) {
					extras.append(renderItem(item));
				});
				var added = Array.from(runtimeTools.values());
				if (added.length) {
					if (extras.childNodes.length) extras.append(h("span", { class: "sep" }));
					added.forEach(function (tool) {
						extras.append(toolButton("tool:" + tool.id, tool.icon, tool.label, tool.title, function () {
							runPageTool(tool);
						}));
					});
				}
				if (capture.isSharing()) {
					extras.append(h("button", {
						class: "tool",
						type: "button",
						title: "This tab is shared so captures are instant. Click to stop sharing.",
						"aria-label": "Stop sharing this tab",
						onclick: function () {
							capture.release();
							showToast("Stopped sharing this tab");
						},
					}, h("span", { class: "live-dot" }), h("span", { class: "label" }, "Sharing")));
				}
				var customize = toolButton("customize", "customize", "Customize", "Customize telescope", function () {
					if (state.panel === "designer") closePanel();
					else openPanel("designer");
				}, true);
				customize.classList.add("icon-only");
				extras.append(customize);
				extras.hidden = !state.open;
				bar.replaceChildren(logoButton, extras);
			}
			logoButton.setAttribute("aria-expanded", String(state.open));
			pinsLayer.hidden = !state.open;
			syncPressed();
			updateBadges();
			placeBar();
			fitBar();
			if (!appMenu.hidden) placeMenu(appMenu, navAnchor());
			if (!recordMenu.hidden) placeMenu(recordMenu, toolButtons.record);
		}

		function renderItem(item) {
			if (item.type === "separator") return h("span", { class: "sep" });
			if (item.type === "apps") return navbar();
			if (item.type === "link") {
				return h("a", {
					class: "tool",
					href: item.href,
					target: "_blank",
					rel: "noopener noreferrer",
					title: item.label + " · " + item.href,
					"aria-label": item.label,
				}, icon(item.icon), h("span", { class: "label" }, item.label));
			}
			if (item.type === "prompt") {
				return toolButton(null, item.icon, item.label, item.label + ": " + item.prompt, function () {
					runPrompt(item);
				});
			}
			var info = TOOLS[item.type];
			var button = toolButton(item.type, info.icon, info.label, info.title, function () {
				runTool(item.type);
			}, info.toggle);
			if (item.type === "threads") button.append(h("span", { class: "count", "data-count": "threads" }, "0"));
			if (item.type === "logs") button.append(h("span", { class: "count", "data-count": "logs", hidden: true }, "0"));
			return button;
		}

		function toolButton(id, iconName, text, title, onclick, toggle) {
			var button = h("button", {
				class: "tool",
				type: "button",
				title: title,
				"aria-label": text,
				"aria-pressed": toggle ? "false" : undefined,
				onclick: onclick,
			}, icon(iconName), h("span", { class: "label" }, text));
			if (id) toolButtons[id] = button;
			return button;
		}

		/**
		 * The navbar: the page's version, app and path, in the order its address
		 * is built from them. `dev · acme · /pricing` is
		 * `http://dev.acme.localhost:3000/pricing`. The version opens this page on
		 * another version, the app opens another app at its root, and the path
		 * takes a new path on this version.
		 */
		function navbar() {
			var version = config.appVersion || "main";
			var versionButton = navButton("version", [h("span", { class: "dot up" }), h("span", { class: "nav-text" }, version)],
				"This page on another version", "Version " + version + ", switch version");
			versionButton.classList.add("nav-version");
			var projectButton = navButton("project", [h("span", { class: "nav-text" }, appName())],
				"Open another app", "App " + appName() + ", switch app");
			var path = h("input", {
				class: "nav-path",
				type: "text",
				value: currentPath(),
				spellcheck: "false",
				autocomplete: "off",
				autocapitalize: "off",
				"aria-label": "Page path, type a path and press Enter to go there",
				title: page.location.href,
			});
			sizePath(path);
			path.addEventListener("input", function () {
				sizePath(path);
			});
			path.addEventListener("focus", function () {
				path.select();
			});
			path.addEventListener("blur", function () {
				path.value = currentPath();
				sizePath(path);
			});
			path.addEventListener("keydown", function (event) {
				if (event.key === "Enter") {
					event.preventDefault();
					go(path.value);
				} else if (event.key === "Escape") {
					path.value = currentPath();
					path.blur();
				}
			});
			var copy = h("button", {
				class: "nav-seg nav-copy",
				type: "button",
				title: "Copy this page's address",
				"aria-label": "Copy this page's address",
				onclick: function () {
					copyText(page.location.href, "Copied " + page.location.href);
				},
			}, icon("copy"));
			navParts = { version: versionButton, project: projectButton, path: path };
			toolButtons.apps = versionButton;
			return h("div", { class: "nav", role: "group", "aria-label": "Navbar" },
				versionButton, h("span", { class: "nav-sep", "aria-hidden": "true" }, "·"),
				projectButton, h("span", { class: "nav-sep", "aria-hidden": "true" }, "·"),
				path, copy);
		}

		function navButton(kind, children, title, label) {
			return h("button", {
				class: "nav-seg",
				type: "button",
				title: title,
				"aria-label": label,
				"aria-haspopup": "menu",
				"aria-expanded": String(state.navMenu === kind && !appMenu.hidden),
				onclick: function () {
					if (!appMenu.hidden && state.navMenu === kind) closeNavMenu();
					else openNavMenu(kind);
				},
			}, children, icon("chevron"));
		}

		/** The page's path, query and fragment: what the navbar shows after the app. */
		function currentPath() {
			return page.location.pathname + page.location.search + page.location.hash;
		}

		function sizePath(input) {
			input.size = Math.max(4, Math.min(30, input.value.length + 1));
		}

		/** Goes to a path on this version. The navbar's path never leaves the preview; the switchers do that. */
		function go(value) {
			var text = String(value || "").trim() || "/";
			if (!/^[a-z][a-z\d+.-]*:/i.test(text) && text.charAt(0) !== "/") text = "/" + text;
			var target;
			try {
				target = new URL(text, page.location.href);
			} catch (error) {
				showToast("That isn't a path", true);
				return;
			}
			if (target.origin !== page.location.origin) {
				showToast("Type a path on this preview, like /pricing. Pick another app or version from the navbar.", true);
				return;
			}
			page.location.assign(target.href);
		}

		/** Whether this app has more than one version, so the bar says which one this is. */
		function hasVersions() {
			return Boolean(config.appVersion) && (config.appVersions || []).length > 1;
		}

		function runTool(type) {
			if (type === "inspect") return setMode(state.mode === "inspect" ? "idle" : "inspect");
			if (type === "comment") return setMode(state.mode === "comment" ? "idle" : "comment");
			if (type === "threads") return state.panel === "threads" || state.panel === "thread" ? closePanel() : openPanel("threads");
			if (type === "logs") return state.panel === "logs" ? closePanel() : openPanel("logs");
			if (type === "screenshot") return screenshot();
			if (type === "area") return startArea();
			if (type === "record") return recordMenu.hidden ? openRecordMenu() : closeRecordMenu();
		}

		function syncPressed() {
			setPressed("inspect", state.mode === "inspect");
			setPressed("comment", state.mode === "comment");
			setPressed("threads", state.panel === "threads" || state.panel === "thread");
			setPressed("logs", state.panel === "logs");
			setPressed("customize", state.panel === "designer");
		}

		function setPressed(id, on) {
			if (toolButtons[id]) toolButtons[id].setAttribute("aria-pressed", String(on));
		}

		function updateBadges() {
			var threadsButton = toolButtons.threads;
			if (threadsButton) {
				var open = pageThreads().filter(function (thread) {
					return thread.status === "open";
				}).length;
				threadsButton.querySelector("[data-count='threads']").textContent = String(open);
				threadsButton.setAttribute("aria-label", "Threads, " + open + " open");
			}
			var logsButton = toolButtons.logs;
			if (logsButton) {
				var counts = countLogs();
				var badge = logsButton.querySelector("[data-count='logs']");
				var shown = counts.errors || counts.warnings;
				badge.hidden = shown === 0;
				badge.textContent = String(shown);
				badge.classList.toggle("error", counts.errors > 0);
				badge.classList.toggle("warn", counts.errors === 0 && counts.warnings > 0);
				logsButton.setAttribute("aria-label", "Logs, " + counts.errors + " errors, " + counts.warnings + " warnings");
			}
		}

		function placeBar() {
			var parts = state.layout.dock.position.split("-");
			var style = bar.style;
			style.top = parts[0] === "top" ? "14px" : "auto";
			style.bottom = parts[0] === "bottom" ? "18px" : "auto";
			style.left = parts[1] === "left" ? "16px" : parts[1] === "center" ? "50%" : "auto";
			style.right = parts[1] === "right" ? "16px" : "auto";
			style.transform = parts[1] === "center" ? "translateX(-50%)" : "none";
		}

		/** Labels go first when the bar is too wide for the page, then the bar wraps. */
		function fitBar() {
			bar.classList.remove("compact", "wrap");
			if (bar.scrollWidth > bar.clientWidth + 1) bar.classList.add("compact");
			if (bar.scrollWidth > bar.clientWidth + 1) bar.classList.add("wrap");
		}

		function isTopDock() {
			return state.layout.dock.position.indexOf("top") === 0;
		}

		/** Next to the bar: above it when docked at the bottom, below it when docked at the top. */
		function placeMenu(menu, anchor) {
			if (!anchor || !anchor.isConnected) {
				menu.hidden = true;
				return;
			}
			var rect = anchor.getBoundingClientRect();
			menu.style.left = clamp(rect.left, 8, page.innerWidth - menu.offsetWidth - 8) + "px";
			menu.style.top = isTopDock() ? rect.bottom + 8 + "px" : "auto";
			menu.style.bottom = isTopDock() ? "auto" : page.innerHeight - rect.top + 8 + "px";
		}

		/** The bar docks in six places. Drag the XO handle anywhere; the bar snaps to the part of the page it is dropped in, and the design keeps it. */
		function setUpDrag() {
			logoButton.addEventListener("pointerdown", function (event) {
				if (event.button !== 0) return;
				var startX = event.clientX;
				var startY = event.clientY;
				var startRect = bar.getBoundingClientRect();
				var moved = false;
				var nearest = state.layout.dock.position;
				logoButton.setPointerCapture(event.pointerId);
				function onMove(moveEvent) {
					var dx = moveEvent.clientX - startX;
					var dy = moveEvent.clientY - startY;
					if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
					if (!moved) {
						moved = true;
						closePopovers();
						showGuides();
					}
					var left = clamp(startRect.left + dx, 8, page.innerWidth - startRect.width - 8);
					var top = clamp(startRect.top + dy, 8, page.innerHeight - startRect.height - 8);
					bar.style.transform = "none";
					bar.style.right = "auto";
					bar.style.bottom = "auto";
					bar.style.left = left + "px";
					bar.style.top = top + "px";
					// Where the handle is dropped, not the bar's middle: a wide bar's middle never reaches the sides.
					nearest = nearestPosition(moveEvent.clientX, moveEvent.clientY);
					Array.prototype.forEach.call(guides.children, function (guide) {
						guide.classList.toggle("near", guide.getAttribute("data-position") === nearest);
					});
				}
				function onUp() {
					logoButton.removeEventListener("pointermove", onMove);
					logoButton.removeEventListener("pointerup", onUp);
					logoButton.removeEventListener("pointercancel", onUp);
					guides.hidden = true;
					if (!moved) return;
					justDragged = true;
					if (nearest === state.layout.dock.position) {
						placeBar();
						return;
					}
					changeLayout(function (layout) {
						layout.dock.position = nearest;
					}, "Docked " + XoDesigner.positionLabel(nearest).toLowerCase());
				}
				logoButton.addEventListener("pointermove", onMove);
				logoButton.addEventListener("pointerup", onUp);
				logoButton.addEventListener("pointercancel", onUp);
			});
		}

		function showGuides() {
			guides.replaceChildren.apply(guides, POSITIONS.map(function (position) {
				var guide = h("div", { class: "guide", "data-position": position });
				XoUi.dockAt(guide, position, { top: "14px", bottom: "18px", side: "16px" });
				guide.style.height = bar.offsetHeight + "px";
				return guide;
			}));
			guides.hidden = false;
		}

		function nearestPosition(x, y) {
			var horizontal = x < page.innerWidth / 3 ? "left" : x > (page.innerWidth * 2) / 3 ? "right" : "center";
			return (y < page.innerHeight / 2 ? "top" : "bottom") + "-" + horizontal;
		}

		// ------------------------------------------------------------ the design

		/** The app's design; until it arrives the last one seen (or the built-in one) is shown. */
		function loadLayout() {
			return request("GET", "/toolbar")
				.then(function (data) {
					// A change made while this was loading wins.
					if (saveTimer || saving) return;
					var changed = JSON.stringify(data.layout) !== JSON.stringify(state.layout) || data.source !== state.layoutSource;
					state.layout = data.layout;
					state.layoutSource = data.source;
					remember();
					if (readSession("open") === null && state.open !== data.layout.dock.startOpen) {
						state.open = data.layout.dock.startOpen;
						if (!state.open) closeEverything();
						changed = true;
					}
					if (!changed) return;
					renderBar();
					designer.setLayout(data.layout, data.source);
				})
				.catch(function () {
					// The last design seen, or the built-in one, stays.
				});
		}

		/** A change made on the bar itself (docking it by drag); it shares the editor's Undo. */
		function changeLayout(mutate, message) {
			designer.change(mutate, message);
		}

		/** Shows a design at once and saves it shortly after. Saving gives this app its own design. */
		function applyLayout(next, message) {
			state.layout = next;
			state.layoutSource = "app";
			remember();
			renderBar();
			if (message) showToast(message);
			setSaveStatus("Saving…");
			page.clearTimeout(saveTimer);
			saveTimer = page.setTimeout(saveNow, 300);
		}

		function saveNow() {
			saveTimer = 0;
			saving = true;
			var seq = ++saveSeq;
			return request("PUT", "/toolbar", state.layout)
				.then(function (data) {
					if (seq !== saveSeq) return;
					setSaveStatus("Saved. " + appName() + " has its own design.");
					// The gateway may have tidied the design (ids, separators): show what it kept.
					if (JSON.stringify(data.layout) === JSON.stringify(state.layout)) return;
					state.layout = data.layout;
					remember();
					renderBar();
					designer.setLayout(data.layout, data.source);
				})
				.catch(function (error) {
					if (seq === saveSeq) setSaveStatus("Couldn't save: " + error.message);
				})
				.finally(function () {
					if (seq === saveSeq) saving = false;
				});
		}

		/** A design the gateway sends back whole (edited JSON, or a reset), replacing any pending save. */
		function replaceLayout(promise) {
			page.clearTimeout(saveTimer);
			saveTimer = 0;
			var seq = ++saveSeq;
			return promise.then(function (data) {
				if (seq === saveSeq) {
					state.layout = data.layout;
					state.layoutSource = data.source;
					remember();
					renderBar();
				}
				return data;
			});
		}

		function remember() {
			writeLocal("layout", JSON.stringify(state.layout));
			writeLocal("layout-source", state.layoutSource);
		}

		function setSaveStatus(text) {
			state.saveStatus = text;
			designer.setStatus(text);
		}

		function describeSource(source) {
			var name = appName();
			if (source === "app") return name + " has its own design.";
			var base = source === "gateway" ? "the gateway's default design" : "the built-in design";
			return name + " uses " + base + ". A change here gives " + name + " its own.";
		}

		// ------------------------------------------------------------ modes

		function setMode(mode) {
			closePopovers();
			if (mode !== "area") endArea();
			if (mode !== "inspect") state.pendingPrompt = null;
			state.mode = mode;
			syncPressed();
			state.hovered = null;
			hoverBox.hidden = true;
			tip.hidden = true;
			if (mode !== "inspect") clearSelection();
			if (mode !== "comment") closeComposer();
		}

		function toggleOpen() {
			state.open = !state.open;
			writeSession("open", state.open ? "1" : "0");
			if (!state.open) closeEverything();
			renderBar();
		}

		function closeEverything() {
			setMode("idle");
			closePanel();
			closePopovers();
		}

		function openIfClosed() {
			if (!state.open) toggleOpen();
		}

		function onPointerMove(event) {
			if ((state.mode !== "inspect" && state.mode !== "comment") || isOurs(event)) return;
			var target = pageElement(event);
			if (target && target !== state.hovered) {
				state.hovered = target;
				renderTip();
			}
		}

		function onClick(event) {
			if ((state.mode !== "inspect" && state.mode !== "comment") || isOurs(event)) return;
			block(event);
			var target = pageElement(event);
			if (!target) return;
			if (state.mode === "inspect") select(target);
			else openComposer(target, offsetsWithin(target, event));
		}

		function onKeyDown(event) {
			// The review dialog handles its own keys.
			if (state.review) return;
			if (event.key === "Escape") {
				if (escape()) block(event);
				return;
			}
			if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey) {
				var handled = true;
				if (event.code === "KeyI") {
					openIfClosed();
					setMode(state.mode === "inspect" ? "idle" : "inspect");
				} else if (event.code === "KeyC") {
					openIfClosed();
					setMode(state.mode === "comment" ? "idle" : "comment");
				} else if (event.code === "KeyX") {
					toggleOpen();
				} else if (event.code === "KeyS") {
					screenshot();
				} else if (event.code === "KeyA") {
					startArea();
				} else if (event.code === "KeyR") {
					if (state.recording) state.recording.controls.stop();
					else startRecording(recordPrefs());
				} else if (event.code === "KeyL") {
					openIfClosed();
					if (state.panel === "logs") closePanel();
					else openPanel("logs");
				} else {
					handled = false;
				}
				if (handled) block(event);
				return;
			}
			if (event.key === "ArrowUp" && state.selected && !isOurs(event)) {
				selectParent();
				block(event);
			}
		}

		/** Esc closes the innermost thing that is open: menus, area, composer, selection, mode, then panel. */
		function escape() {
			if (!appMenu.hidden || !recordMenu.hidden) return closePopovers(), true;
			if (state.mode === "area") return setMode("idle"), true;
			if (state.composer) return closeComposer(), true;
			if (state.selected) return clearSelection(), true;
			if (state.mode !== "idle") return setMode("idle"), true;
			if (state.panel) return closePanel(), true;
			return false;
		}

		// ------------------------------------------------------------ apps

		/** Opens the navbar's version or app switcher, loaded fresh from the gateway. */
		function openNavMenu(kind) {
			closeRecordMenu();
			toast.hidden = true;
			state.navMenu = kind;
			appMenu.classList.toggle("wide", kind === "project");
			appMenu.setAttribute("aria-label", kind === "version" ? "Versions of " + appName() : "Apps");
			appMenu.replaceChildren(h("div", { class: "menu-note" }, kind === "version" ? "Loading versions…" : "Loading apps…"));
			appMenu.hidden = false;
			syncNavExpanded();
			placeMenu(appMenu, navAnchor());
			request("GET", "/targets")
				.then(function (data) {
					if (appMenu.hidden || state.navMenu !== kind) return;
					if (kind === "version") renderVersionMenu(data);
					else renderProjectMenu(data);
					placeMenu(appMenu, navAnchor());
				})
				.catch(function (error) {
					if (state.navMenu !== kind) return;
					appMenu.replaceChildren(h("div", { class: "menu-note" }, "Couldn't load " + (kind === "version" ? "versions" : "apps") + ": " + error.message));
				});
		}

		/** This app's versions: the same page, on each version's own host. */
		function renderVersionMenu(data) {
			var mine = (data.targets || []).find(function (target) {
				return target.name === data.current;
			});
			var versions = (mine && mine.versions) || [];
			var here = currentPath();
			var items = [h("div", { class: "menu-section" }, "This page on another version")];
			versions.forEach(function (version) {
				var current = version.name === data.currentVersion;
				items.push(h("a", {
					class: "menu-item" + (current ? " current" : ""),
					role: "menuitem",
					href: version.url.replace(/\/$/, "") + here,
					"aria-current": current ? "page" : undefined,
				},
				h("span", { class: "dot" + (version.up ? " up" : ""), title: version.up ? "Answering" : "Not answering" }),
				h("span", { class: "grow" },
					h("span", { class: "menu-name" }, version.name),
					h("span", { class: "mono muted" }, versionDetail(version))),
				version.default ? h("span", { class: "chip" }, "default") : null,
				current ? h("span", { class: "muted" }, "open") : !version.up ? h("span", { class: "muted" }, "down") : null));
			});
			if (versions.length < 2) items.push(h("div", { class: "menu-note" }, appName() + " has one version."));
			items.push(h("div", { class: "menu-sep" }), manageItem(data));
			appMenu.replaceChildren.apply(appMenu, items);
		}

		/** Where a version is served from: its port or URL. */
		function versionDetail(version) {
			return (version.upstream || "").replace(/^https?:\/\//, "");
		}

		/** Every app on the gateway, searchable. One opens at its root, on its default version. */
		function renderProjectMenu(data) {
			var targets = data.targets || [];
			var search = h("input", {
				class: "field",
				type: "search",
				placeholder: "Find an app",
				spellcheck: "false",
				autocomplete: "off",
				"aria-label": "Find an app",
			});
			var list = h("div", { class: "menu-list" });
			function fill() {
				var query = search.value.trim().toLowerCase();
				var shown = targets
					.map(function (target, index) {
						var name = target.name;
						var rank = !query ? 0 : name === query ? 0 : name.indexOf(query) === 0 ? 1
							: name.indexOf(query) >= 0 ? 2
							: appDetail(target).toLowerCase().indexOf(query) >= 0 ? 3 : -1;
						return { target: target, rank: rank, index: index };
					})
					.filter(function (item) {
						return item.rank >= 0;
					})
					.sort(function (a, b) {
						return a.rank - b.rank || a.index - b.index;
					});
				if (shown.length) {
					list.replaceChildren.apply(list, shown.map(function (item) {
						return projectItem(item.target, data.current);
					}));
				} else {
					list.replaceChildren(h("div", { class: "menu-note" }, "No app matches “" + search.value.trim() + "”"));
				}
			}
			search.addEventListener("input", fill);
			search.addEventListener("keydown", function (event) {
				var first = list.querySelector("a.menu-item");
				if (event.key === "Enter" && first) {
					event.preventDefault();
					page.location.assign(first.href);
				} else if (event.key === "ArrowDown" && first) {
					event.preventDefault();
					first.focus();
				}
			});
			list.addEventListener("keydown", function (event) {
				if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
				var items = Array.prototype.slice.call(list.querySelectorAll("a.menu-item"));
				var at = items.indexOf(root.activeElement);
				event.preventDefault();
				if (event.key === "ArrowDown") {
					if (at < items.length - 1) items[at + 1].focus();
				} else {
					(at > 0 ? items[at - 1] : search).focus();
				}
			});
			fill();
			appMenu.replaceChildren(
				h("div", { class: "menu-section" }, targets.length === 1 ? "1 app" : targets.length + " apps"),
				h("div", { class: "row" }, search),
				list,
				h("div", { class: "menu-sep" }),
				manageItem(data));
			search.focus({ preventScroll: true });
		}

		function projectItem(target, currentName) {
			var current = target.name === currentName;
			var detail = appDetail(target);
			return h("a", {
				class: "menu-item" + (current ? " current" : ""),
				role: "menuitem",
				href: target.url,
				"aria-current": current ? "page" : undefined,
				title: [target.name, detail].filter(Boolean).join(" · "),
			},
			h("span", { class: "dot" + (target.up ? " up" : ""), title: target.up ? "Answering" : "Not answering" }),
			h("span", { class: "grow" },
				h("span", { class: "menu-name" }, target.name),
				detail ? h("span", { class: "mono muted path" }, detail) : null),
			current ? h("span", { class: "muted" }, "open") : target.up ? null : h("span", { class: "muted" }, "down"));
		}

		/** Where apps are managed: a link from a tab of its own; inside XO's Browser, XO is already there. */
		function manageItem(data) {
			var where = data.manageIn || "the launcher";
			if (framed()) return h("div", { class: "menu-note" }, "Add apps and versions in " + where + ".");
			return h("a", { class: "menu-item", role: "menuitem", href: launcherUrl(data.manageAt) },
				h("span", { class: "grow" }, "Manage apps in " + where + "…"));
		}

		function framed() {
			try {
				return page.top !== page;
			} catch (error) {
				return true;
			}
		}

		function navAnchor() {
			return navParts && state.navMenu ? navParts[state.navMenu] : null;
		}

		function syncNavExpanded() {
			if (!navParts) return;
			["version", "project"].forEach(function (kind) {
				navParts[kind].setAttribute("aria-expanded", String(state.navMenu === kind && !appMenu.hidden));
			});
		}

		/** Keeps the navbar's path on the page's, unless someone is typing in it. */
		function syncNavPath() {
			var path = navParts && navParts.path;
			if (!path || !path.isConnected || root.activeElement === path) return;
			var value = currentPath();
			if (path.value !== value) {
				path.value = value;
				sizePath(path);
				fitBar();
			}
			path.title = page.location.href;
		}

		/** Under an app's name: where it is served from, its port or URL. */
		function appDetail(target) {
			return (target.upstream || "").replace(/^https?:\/\//, "");
		}

		function closeNavMenu() {
			appMenu.hidden = true;
			state.navMenu = null;
			syncNavExpanded();
		}

		function closePopovers() {
			closeNavMenu();
			closeRecordMenu();
		}

		/** Where apps are managed, on the bare host of the same port: the path the gateway names, else its root. */
		function launcherUrl(at) {
			var location = page.location;
			var path = typeof at === "string" && at.charAt(0) === "/" && at.charAt(1) !== "/" ? at : "/";
			return location.protocol + "//localhost" + (location.port ? ":" + location.port : "") + path;
		}

		// ------------------------------------------------------------ inspect

		function renderTip() {
			var target = state.hovered;
			if (!target || target === state.selected) {
				tip.hidden = true;
				return;
			}
			var rect = target.getBoundingClientRect();
			if (state.mode === "comment") {
				tip.replaceChildren(
					h("div", { class: "head" }, h("span", { class: "title mono" }, label(target)), h("span", { class: "muted" }, size(rect))),
					h("div", { class: "line muted" }, "Click to leave a comment here"),
				);
			} else {
				var hint = state.pendingPrompt ? "Click to send “" + state.pendingPrompt.label + "” to the agent" : "Click to select · Esc to stop";
				tip.replaceChildren.apply(tip, describeBlock(target, rect).concat([h("div", { class: "hint" }, hint)]));
			}
			tip.hidden = false;
		}

		function describeBlock(target, rect) {
			var styles = page.getComputedStyle(target);
			var text = XoNodeId.normalize(target.textContent).slice(0, 80);
			var blocks = [
				h("div", { class: "head" }, h("span", { class: "title mono" }, label(target)), h("span", { class: "muted" }, size(rect))),
				h("div", { class: "line muted" }, styles.fontSize + " · " + styles.fontWeight + " · " + firstFamily(styles.fontFamily)),
				h("div", { class: "line" },
					swatch(styles.color), hex(styles.color), h("span", { class: "muted" }, "  on  "),
					swatch(effectiveBackground(target)), hex(effectiveBackground(target))),
			];
			if (text) blocks.push(h("div", { class: "quote" }, "“" + text + (text.length === 80 ? "…" : "") + "”"));
			blocks.push(h("div", { class: "line mono muted" }, XoNodeId.split(XoNodeId.build(target))[0] || ""));
			return blocks;
		}

		function select(target) {
			if (state.pendingPrompt) {
				var prompt = state.pendingPrompt;
				setMode("idle");
				askAgent({ ask: prompt.prompt, element: target, sentMessage: "Sent “" + prompt.label + "” to the agent" });
				return;
			}
			state.selected = target;
			tip.hidden = true;
			var rect = target.getBoundingClientRect();
			var ask = h("input", {
				class: "field",
				type: "text",
				placeholder: "Ask the agent about this element…",
				"aria-label": "Ask the agent about this element",
			});
			var sendButton = h("button", { class: "btn primary", type: "button" }, icon("send"), "Send");
			function send() {
				askAgent({ ask: ask.value, element: target, button: sendButton }).then(function (sent) {
					if (sent) ask.value = "";
				});
			}
			sendButton.addEventListener("click", send);
			ask.addEventListener("keydown", function (event) {
				if (event.key === "Enter") send();
				// ↑ in an empty field walks up to the parent, like the Parent button.
				if (event.key === "ArrowUp" && !ask.value) {
					event.preventDefault();
					selectParent();
				}
			});
			card.replaceChildren.apply(card, describeBlock(target, rect).concat([
				h("div", { class: "row" }, ask),
				h("div", { class: "row" },
					sendButton,
					h("button", { class: "btn", type: "button", title: "Screenshot this element", onclick: function () {
						captureElement(target);
					} }, icon("screenshot"), "Screenshot"),
					h("button", { class: "btn", type: "button", onclick: function () {
						openComposer(target, { offsetX: 1, offsetY: 0 });
					} }, icon("comment"), "Comment"),
					h("button", { class: "btn", type: "button", onclick: function () {
						copyForAgent(target);
					} }, icon("copy"), "Copy for agent"),
					h("button", { class: "btn", type: "button", title: "Select the parent element (↑)", onclick: selectParent }, icon("parent"), "Parent"),
					h("button", { class: "btn", type: "button", "aria-label": "Close", onclick: clearSelection }, icon("close")),
				),
			]));
			card.hidden = false;
			// Picking an element and typing the request is one motion, as in Claude Code's and Cursor's pickers.
			ask.focus({ preventScroll: true });
		}

		function selectParent() {
			var parent = state.selected && state.selected.parentElement;
			if (parent && parent !== doc.documentElement) select(parent);
		}

		function clearSelection() {
			state.selected = null;
			selectBox.hidden = true;
			card.hidden = true;
		}

		// ------------------------------------------------------------ comments

		function openComposer(target, offsets) {
			clearSelection();
			var selectionText = String(page.getSelection ? page.getSelection() : "").trim().slice(0, 500);
			state.composer = { target: target, offsetX: offsets.offsetX, offsetY: offsets.offsetY, selectionText: selectionText };
			var field = h("textarea", { class: "field", placeholder: "Add a comment…", "aria-label": "Comment" });
			var submit = h("button", { class: "btn primary", type: "button" }, "Comment");
			function save() {
				submitComment(field.value, submit);
			}
			submit.addEventListener("click", save);
			field.addEventListener("keydown", function (event) {
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
			});
			composer.replaceChildren(
				h("div", { class: "head" }, h("span", { class: "title mono" }, label(target)), h("span", { class: "muted" }, "⌘/Ctrl + Enter")),
				h("div", { class: "row" }, field),
				h("div", { class: "row end" }, h("button", { class: "btn", type: "button", onclick: closeComposer }, "Cancel"), submit),
			);
			composer.hidden = false;
			placeComposer();
			field.focus();
		}

		function closeComposer() {
			state.composer = null;
			composer.hidden = true;
		}

		function submitComment(value, button) {
			var text = value.trim();
			var draft = state.composer;
			if (!text || !draft) return;
			button.disabled = true;
			return createThread(threadBody(draft.target, text, undefined, draft))
				.then(function () {
					closeComposer();
					setMode("idle");
					showToast("Comment added");
				})
				.catch(function (error) {
					showToast(error.message, true);
				})
				.finally(function () {
					button.disabled = false;
				});
		}

		/** A thread on an element, or on the whole page when there is no element. */
		function threadBody(target, text, attachments, draft) {
			return {
				nodeId: target ? XoNodeId.build(target) : "",
				anchor: target ? {
					tag: target.nodeName.toLowerCase(),
					textQuote: XoNodeId.textQuote(target),
					offsetX: draft ? draft.offsetX : 1,
					offsetY: draft ? draft.offsetY : 0,
				} : undefined,
				page: state.path,
				pageTitle: doc.title,
				selectionRange: draft && draft.selectionText ? { text: draft.selectionText } : undefined,
				screenWidth: page.innerWidth,
				screenHeight: page.innerHeight,
				text: text,
				author: AUTHOR,
				attachments: attachments,
			};
		}

		function createThread(body) {
			return request("POST", "/threads", body).then(function (data) {
				state.threads.push(data.thread);
				renderThreads();
				return data.thread;
			});
		}

		function loadThreads() {
			var path = state.path;
			return request("GET", "/threads?page=" + encodeURIComponent(path))
				.then(function (data) {
					if (path !== state.path) return;
					state.threads = data.threads || [];
					renderThreads();
				})
				.catch(function (error) {
					showToast("Couldn't load comments: " + error.message, true);
				});
		}

		function pageThreads() {
			return state.threads
				.filter(function (thread) {
					return thread.page === state.path;
				})
				.sort(function (a, b) {
					return a.createdAt < b.createdAt ? -1 : 1;
				});
		}

		function renderThreads() {
			var threads = pageThreads();
			var ids = new Set(threads.map(function (thread) {
				return thread.id;
			}));
			pins.forEach(function (pin, id) {
				if (!ids.has(id)) {
					pin.node.remove();
					pins.delete(id);
				}
			});
			threads.forEach(function (thread, index) {
				var pin = pins.get(thread.id);
				if (!pin) {
					var node = h("button", { class: "pin", type: "button", hidden: true, onclick: function () {
						openThread(thread.id);
					} });
					pinsLayer.append(node);
					pin = { node: node, target: null, checkedAt: 0 };
					pins.set(thread.id, pin);
				}
				var first = thread.comments[0] ? thread.comments[0].text : "";
				pin.node.textContent = String(index + 1);
				pin.node.title = first;
				pin.node.setAttribute("aria-label", "Comment " + (index + 1) + ": " + first);
				pin.node.classList.toggle("resolved", thread.status === "resolved");
			});
			updateBadges();
			if (state.panel === "threads" || state.panel === "thread") renderPanel();
		}

		function openThread(id) {
			state.threadId = id;
			openPanel("thread");
		}

		function openPanel(kind) {
			state.panel = kind;
			renderPanel();
		}

		function closePanel() {
			state.panel = null;
			state.threadId = null;
			panel.hidden = true;
			syncPressed();
		}

		function renderPanel() {
			if (state.panel === "logs") renderLogsPanel();
			else if (state.panel === "designer") {
				if (designer.element.parentNode !== panel) panel.replaceChildren(designer.element);
				designer.render();
			}
			else if (state.panel === "thread" && findThread(state.threadId)) renderThreadDetail(findThread(state.threadId));
			else renderThreadList();
			panel.setAttribute("aria-label", state.panel === "logs" ? "Logs" : state.panel === "designer" ? "Customize telescope" : "Comments");
			panel.hidden = false;
			syncPressed();
		}

		function renderThreadList() {
			state.panel = "threads";
			var threads = pageThreads();
			var body = h("div", { class: "panel-body" });
			if (!threads.length) {
				body.append(h("div", { class: "empty" }, "No comments on this page yet. Pick Comment, then click anything on the page."));
			}
			threads.forEach(function (thread, index) {
				var first = thread.comments[0] ? thread.comments[0].text : "";
				var meta = h("div", { class: "line mono muted" }, thread.nodeId ? XoNodeId.split(thread.nodeId)[0] || "" : "Whole page");
				var chips = h("div", { class: "line chips" });
				if (thread.status === "resolved") chips.append(h("span", { class: "chip" }, "Resolved"));
				if (isOrphaned(thread)) chips.append(h("span", { class: "chip warn" }, "Element not found"));
				var media = attachmentSummary(thread);
				if (media) chips.append(h("span", { class: "chip" }, media));
				if (otherVersion(thread)) chips.append(h("span", { class: "chip" }, "on " + thread.version));
				if (thread.comments.length > 1) chips.append(h("span", { class: "chip" }, thread.comments.length - 1 + " replies"));
				body.append(h("button", { class: "item", type: "button", onclick: function () {
					openThread(thread.id);
				} },
				h("span", { class: "num" + (thread.status === "resolved" ? " resolved" : "") }, String(index + 1)),
				h("span", { class: "grow" }, h("span", { class: "text" }, first), meta, chips)));
			});
			panel.replaceChildren(
				h("div", { class: "panel-head" },
					h("div", { class: "grow" }, h("div", { class: "title" }, "Comments"), h("div", { class: "mono muted" }, state.path)),
					closeButton()),
				body,
			);
		}

		function renderThreadDetail(thread) {
			var number = pageThreads().indexOf(thread) + 1;
			var comments = h("div", {});
			thread.comments.forEach(function (comment) {
				comments.append(h("div", { class: "comment" },
					h("div", { class: "head" }, h("strong", {}, comment.author || AUTHOR), h("span", { class: "muted" }, ago(comment.createdAt))),
					h("p", {}, comment.text),
					comment.attachments && comment.attachments.length ? attachmentsView(comment.attachments) : null));
			});
			var reply = h("textarea", { class: "field", placeholder: "Reply…", "aria-label": "Reply" });
			var replyButton = h("button", { class: "btn primary", type: "button" }, "Reply");
			function sendReply() {
				var text = reply.value.trim();
				if (!text) return;
				replyButton.disabled = true;
				request("POST", "/threads/" + thread.id + "/comments", { text: text, author: AUTHOR })
					.then(function (data) {
						replaceThread(data.thread);
						renderPanel();
					})
					.catch(function (error) {
						showToast(error.message, true);
					})
					.finally(function () {
						replyButton.disabled = false;
					});
			}
			replyButton.addEventListener("click", sendReply);
			reply.addEventListener("keydown", function (event) {
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) sendReply();
			});

			var target = targetOf(thread);
			var status = h("div", { class: "line chips" });
			if (thread.status === "resolved") status.append(h("span", { class: "chip" }, "Resolved"));
			if (otherVersion(thread)) status.append(h("span", { class: "chip" }, "Left on " + thread.version));
			if (!thread.nodeId) status.append(h("span", { class: "chip" }, "Whole page"));
			else if (!target) status.append(h("span", { class: "chip warn" }, "Element not found on this page"));
			if (thread.selectionRange && thread.selectionRange.text) {
				status.append(h("div", { class: "quote" }, "“" + thread.selectionRange.text + "”"));
			}

			panel.replaceChildren(
				h("div", { class: "panel-head" },
					h("button", { class: "btn", type: "button", "aria-label": "All comments", onclick: function () {
						openPanel("threads");
					} }, icon("back")),
					h("div", { class: "grow" },
						h("div", { class: "title" }, "Comment " + number),
						h("div", { class: "mono muted" }, thread.nodeId ? XoNodeId.split(thread.nodeId)[0] || "" : state.path)),
					closeButton()),
				h("div", { class: "panel-body" },
					status,
					comments,
					h("div", { class: "row" }, reply),
					h("div", { class: "row end" }, replyButton)),
				h("div", { class: "panel-foot" },
					h("div", { class: "row" },
						h("button", { class: "btn", type: "button", disabled: !target, onclick: function () {
							showOnPage(target);
						} }, icon("target"), "Show"),
						h("button", { class: "btn", type: "button", onclick: function () {
							setStatus(thread, thread.status === "resolved" ? "open" : "resolved");
						} }, thread.status === "resolved" ? "Reopen" : "Resolve"),
						h("button", { class: "btn", type: "button", onclick: function (event) {
							askAgent({ ask: threadAsk(thread), element: target, attachments: threadAttachmentIds(thread), button: event.currentTarget });
						} }, icon("send"), "Ask the agent"),
						h("button", { class: "btn danger", type: "button", onclick: function () {
							deleteThread(thread);
						} }, "Delete"))),
			);
		}

		function attachmentsView(list) {
			var wrap = h("div", { class: "attachments" });
			list.forEach(function (attachment) {
				if (attachment.kind === "video") {
					var video = h("video", { class: "clip", src: attachment.url, controls: true, preload: "metadata", playsinline: true });
					fixDuration(video);
					wrap.append(video);
				} else {
					wrap.append(h("a", { class: "shot", href: attachment.url, target: "_blank", rel: "noopener", title: "Open full size" },
						h("img", { src: attachment.url, alt: "Screenshot", loading: "lazy" })));
				}
			});
			return wrap;
		}

		/** A thread started on another version of this app; comments are shared across versions. */
		function otherVersion(thread) {
			return hasVersions() && thread.version && thread.version !== config.appVersion;
		}

		function attachmentSummary(thread) {
			var images = 0;
			var videos = 0;
			thread.comments.forEach(function (comment) {
				(comment.attachments || []).forEach(function (attachment) {
					if (attachment.kind === "video") videos += 1;
					else images += 1;
				});
			});
			var parts = [];
			if (images) parts.push(images + (images === 1 ? " screenshot" : " screenshots"));
			if (videos) parts.push(videos + (videos === 1 ? " recording" : " recordings"));
			return parts.join(", ");
		}

		function threadAttachmentIds(thread) {
			var ids = [];
			thread.comments.forEach(function (comment) {
				(comment.attachments || []).forEach(function (attachment) {
					if (ids.length < 10) ids.push(attachment.id);
				});
			});
			return ids;
		}

		function setStatus(thread, status) {
			request("PATCH", "/threads/" + thread.id, { status: status })
				.then(function (data) {
					replaceThread(data.thread);
					renderThreads();
					showToast(status === "resolved" ? "Resolved" : "Reopened");
				})
				.catch(function (error) {
					showToast(error.message, true);
				});
		}

		function deleteThread(thread) {
			request("DELETE", "/threads/" + thread.id)
				.then(function () {
					state.threads = state.threads.filter(function (item) {
						return item.id !== thread.id;
					});
					openPanel("threads");
					renderThreads();
					showToast("Comment deleted");
				})
				.catch(function (error) {
					showToast(error.message, true);
				});
		}

		function replaceThread(updated) {
			state.threads = state.threads.map(function (thread) {
				return thread.id === updated.id ? updated : thread;
			});
		}

		function findThread(id) {
			return state.threads.find(function (thread) {
				return thread.id === id;
			});
		}

		function threadAsk(thread) {
			return thread.comments.map(function (comment) {
				return (comment.author || AUTHOR) + ": " + comment.text;
			}).join("\n");
		}

		function showOnPage(target) {
			if (!target) return;
			target.scrollIntoView({ block: "center", behavior: "smooth" });
			setMode("inspect");
			select(target);
		}

		// ------------------------------------------------------------ capture

		function screenshot() {
			closePopovers();
			setMode("idle");
			return shootAndReview(null, null);
		}

		function captureElement(target) {
			return shootAndReview(padded(target.getBoundingClientRect(), 8), target);
		}

		function shootAndReview(rect, element) {
			var check = capture.support();
			if (!check.ok) return Promise.resolve(showToast(check.reason, true));
			return capture.grab({ rect: rect }).then(
				function (shot) {
					openReview({ kind: "image", shot: shot, element: element, area: Boolean(rect) && !element });
				},
				function (error) {
					showToast(error.message, true);
				},
			);
		}

		/** Area mode: the page is covered by a crosshair layer; drag for a region, click for one element. */
		function startArea() {
			var check = capture.support();
			if (!check.ok) return showToast(check.reason, true);
			setMode("idle");
			// Ask to share now, while the click still counts as the user's; the selection can take its time.
			capture.ensureStream().then(
				function () {
					state.mode = "area";
					areaBox.hidden = true;
					areaSize.hidden = true;
					areaLayer.classList.remove("dragging");
					areaLayer.hidden = false;
				},
				function (error) {
					showToast(error.message, true);
				},
			);
		}

		function endArea() {
			areaLayer.hidden = true;
			if (state.mode === "area") state.mode = "idle";
		}

		function setUpArea() {
			var drag = null;
			areaLayer.addEventListener("pointerdown", function (event) {
				if (event.button !== 0) return;
				event.preventDefault();
				areaLayer.setPointerCapture(event.pointerId);
				drag = { x: event.clientX, y: event.clientY, moved: false };
			});
			areaLayer.addEventListener("pointermove", function (event) {
				if (drag) {
					if (!drag.moved && Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) < 6) return;
					drag.moved = true;
					var rect = rectBetween(drag, event);
					areaLayer.classList.add("dragging");
					showAreaBox(rect, "drag");
					areaSize.textContent = Math.round(rect.width) + " × " + Math.round(rect.height);
					areaSize.style.left = rect.left + "px";
					areaSize.style.top = Math.max(4, rect.top - 24) + "px";
					areaSize.hidden = false;
					return;
				}
				var element = elementAt(event.clientX, event.clientY);
				if (element) showAreaBox(element.getBoundingClientRect(), "element");
				else areaBox.hidden = true;
			});
			function finish(event) {
				if (!drag) return;
				var started = drag;
				drag = null;
				var rect = started.moved ? rectBetween(started, event) : null;
				var element = started.moved ? null : elementAt(event.clientX, event.clientY);
				setMode("idle");
				if (rect) {
					if (rect.width >= 4 && rect.height >= 4) shootAndReview(rect, null);
				} else if (element) {
					shootAndReview(padded(element.getBoundingClientRect(), 8), element);
				} else {
					shootAndReview(null, null);
				}
			}
			areaLayer.addEventListener("pointerup", finish);
			areaLayer.addEventListener("pointercancel", function () {
				drag = null;
				areaLayer.classList.remove("dragging");
			});
		}

		function showAreaBox(rect, kind) {
			areaBox.className = "area-box " + kind;
			place(areaBox, rect);
			areaBox.hidden = false;
		}

		/** The page element under a point, looking through the capture layer; the page itself counts as none. */
		function elementAt(x, y) {
			var nodes = doc.elementsFromPoint(x, y);
			for (var i = 0; i < nodes.length; i++) {
				var node = nodes[i];
				if (node === host) continue;
				if (node === doc.documentElement || node === doc.body) return null;
				return node;
			}
			return null;
		}

		function recordPrefs() {
			var saved = {};
			try {
				saved = JSON.parse(readLocal("record") || "{}") || {};
			} catch (error) {
				saved = {};
			}
			return { mic: saved.mic === true, clicks: saved.clicks !== false };
		}

		function openRecordMenu() {
			closeNavMenu();
			toast.hidden = true;
			var prefs = recordPrefs();
			var mic = checkbox("Record my microphone", prefs.mic);
			var clicks = checkbox("Show my clicks", prefs.clicks);
			recordMenu.replaceChildren(
				h("div", { class: "menu-title" }, "Record this tab"),
				mic.row,
				clicks.row,
				h("div", { class: "menu-note" }, "Up to " + Math.round(XoCapture.MAX_RECORDING_MS / 60000) + " minutes. Stop from the bar or with Alt+Shift+R."),
				h("div", { class: "row end" },
					h("button", { class: "btn", type: "button", onclick: closeRecordMenu }, "Cancel"),
					h("button", { class: "btn primary", type: "button", onclick: function () {
						var next = { mic: mic.input.checked, clicks: clicks.input.checked };
						writeLocal("record", JSON.stringify(next));
						closeRecordMenu();
						startRecording(next);
					} }, icon("record"), "Start recording")),
			);
			recordMenu.hidden = false;
			placeMenu(recordMenu, toolButtons.record);
		}

		function closeRecordMenu() {
			recordMenu.hidden = true;
		}

		function startRecording(prefs) {
			if (state.recording || state.starting) return;
			var check = capture.support();
			if (!check.ok) return showToast(check.reason, true);
			setMode("idle");
			state.starting = true;
			capture
				.record({
					audio: prefs.mic,
					onTick: function (ms) {
						if (state.recording && state.recording.timer) state.recording.timer.textContent = recordingClock(ms);
					},
					onWarning: function (message) {
						showToast(message, true);
					},
				})
				.then(
					function (controls) {
						state.recording = { controls: controls, prefs: prefs, timer: null };
						controls.done.then(finishedRecording, function (error) {
							state.recording = null;
							renderBar();
							showToast("Recording failed: " + error.message, true);
						});
						renderBar();
					},
					function (error) {
						showToast(error.message, true);
					},
				)
				.finally(function () {
					state.starting = false;
				});
		}

		function recordingControls() {
			var controls = state.recording.controls;
			var paused = controls.paused();
			var timer = h("span", { class: "timer", "aria-live": "off" }, recordingClock(controls.elapsed()));
			state.recording.timer = timer;
			return [
				h("span", { class: "rec" }, h("span", { class: "rec-dot" + (paused ? " paused" : "") }), paused ? "Paused" : "Recording"),
				timer,
				toolButton("pause", paused ? "play" : "pause", paused ? "Resume" : "Pause", paused ? "Resume recording" : "Pause recording", function () {
					if (controls.paused()) controls.resume();
					else controls.pause();
					renderBar();
				}),
				(function () {
					var stop = toolButton("stop", "stop", "Stop", "Stop and review (Alt+Shift+R)", function () {
						controls.stop();
					});
					stop.classList.add("stop");
					return stop;
				})(),
				(function () {
					var discard = toolButton("discard", "trash", "Discard", "Throw this recording away", function () {
						controls.cancel();
					});
					discard.classList.add("icon-only");
					return discard;
				})(),
			];
		}

		function recordingClock(ms) {
			return clock(ms) + " / " + clock(state.recording ? state.recording.controls.maxMs : XoCapture.MAX_RECORDING_MS);
		}

		function finishedRecording(result) {
			state.recording = null;
			renderBar();
			if (!result) return showToast("Recording discarded");
			if (!result.blob.size) return showToast("The recording came out empty", true);
			showToast("Saving the recording…", false, true);
			upload(result.blob).then(
				function (uploaded) {
					toast.hidden = true;
					openReview({ kind: "video", upload: uploaded, durationMs: result.durationMs });
				},
				function (error) {
					showToast("Couldn't save the recording: " + error.message, true);
				},
			);
		}

		function ripple(x, y) {
			var dot = h("div", { class: "ripple" });
			dot.style.left = x + "px";
			dot.style.top = y + "px";
			ripples.append(dot);
			page.setTimeout(function () {
				dot.remove();
			}, 700);
		}

		function upload(blob) {
			return fetch(config.api + "/uploads", {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": blob.type || "application/octet-stream" },
				body: blob,
			})
				.then(parseResponse)
				.then(function (data) {
					return data.upload;
				});
		}

		// ------------------------------------------------------------ review

		/** A capture on its way out: mark it up, add a note, then send, save, copy, download or discard it. */
		function openReview(item) {
			closePopovers();
			closeComposer();
			clearSelection();
			setMode("idle");
			var review = {
				kind: item.kind,
				element: item.element || null,
				upload: item.upload || null,
				durationMs: item.durationMs || 0,
				editor: null,
				kept: false,
				busy: false,
			};
			state.review = review;
			var counts = countLogs();
			var note = h("textarea", { class: "field", placeholder: "What should change? (optional)", "aria-label": "Note" });
			var attachLogs = h("input", { type: "checkbox" });
			attachLogs.checked = counts.errors > 0;
			var media;
			if (item.kind === "image") {
				review.editor = XoAnnotate.create({
					source: item.shot.canvas,
					scale: item.shot.scale,
					h: h,
					icon: icon,
					onChange: function () {
						// A new mark means the uploaded copy is stale.
						review.upload = null;
					},
				});
				media = review.editor.element;
			} else {
				var video = h("video", { class: "review-video", src: item.upload.url, controls: true, playsinline: true, preload: "metadata" });
				fixDuration(video);
				media = h("div", { class: "annotate-stage" }, video);
			}
			var title = item.kind === "video"
				? "Recording · " + clock(item.durationMs)
				: item.element ? "Element screenshot" : item.area ? "Area screenshot" : "Screenshot";
			var chips = h("div", { class: "chips" }, h("span", { class: "chip mono" }, state.path), h("span", { class: "chip" }, page.innerWidth + " × " + page.innerHeight));
			if (item.element) chips.append(h("span", { class: "chip mono" }, label(item.element)));
			if (item.shot && item.shot.whole) chips.append(h("span", { class: "chip warn" }, "Whole tab: this frame couldn't be cropped"));
			var logLine = counts.total
				? h("label", { class: "check" }, attachLogs, h("span", {}, "Attach the page's logs (" + describeCounts(counts) + ")"))
				: h("div", { class: "muted" }, "Nothing logged on this page.");
			review.note = note;
			review.attachLogs = attachLogs;
			var actions = [
				h("button", { class: "btn primary", type: "button", title: "⌘/Ctrl+Enter", onclick: reviewAsk }, icon("send"), "Ask the agent"),
				h("button", { class: "btn", type: "button", onclick: reviewComment }, icon("comment"), "Comment"),
			];
			var more = [
				item.kind === "image" ? h("button", { class: "btn", type: "button", onclick: reviewCopy }, icon("copy"), "Copy") : null,
				h("button", { class: "btn", type: "button", onclick: reviewDownload }, icon("download"), "Download"),
				h("button", { class: "btn danger", type: "button", onclick: reviewDiscard }, icon("trash"), "Discard"),
			].filter(Boolean);
			review.buttons = actions.concat(more);
			var dialog = h("div", { class: "review", role: "dialog", "aria-modal": "true", "aria-label": title },
				h("div", { class: "review-head" },
					h("div", { class: "grow" }, h("div", { class: "title" }, title), h("div", { class: "muted" }, appName() + " · " + page.location.host)),
					h("button", { class: "btn", type: "button", "aria-label": "Discard and close", title: "Discard", onclick: reviewDiscard }, icon("close"))),
				h("div", { class: "review-body" },
					h("div", { class: "review-media" }, media),
					h("div", { class: "review-side" },
						h("div", { class: "side-label" }, "Note"),
						note,
						h("div", { class: "side-label" }, "Context"),
						chips,
						logLine,
						h("div", { class: "side-label" }, "Share"),
						h("div", { class: "review-actions" }, actions),
						h("div", { class: "review-actions" }, more),
						h("div", { class: "hint" }, item.kind === "image"
							? "Draw on the image: A arrow, B box, D draw, H hide. ⌘/Ctrl+Z undoes."
							: "Saved to this app's uploads. Discard deletes it."))));
			dialog.addEventListener("keydown", function (event) {
				if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
					event.preventDefault();
					reviewAsk();
					return;
				}
				if (event.key === "Escape") {
					event.preventDefault();
					if (!note.value.trim() && !(review.editor && review.editor.edited()) && review.kind === "image") reviewDiscard();
					else showToast("Discard closes this without saving it", true);
					return;
				}
				if (event.target === note) return;
				if (review.editor && review.editor.key(event)) event.preventDefault();
			});
			reviewLayer.replaceChildren(dialog);
			reviewLayer.hidden = false;
			if (review.editor) {
				page.requestAnimationFrame(function () {
					if (state.review === review) review.editor.fit();
				});
			}
			note.focus({ preventScroll: true });
		}

		function closeReview() {
			state.review = null;
			reviewLayer.hidden = true;
			reviewLayer.replaceChildren();
		}

		function reviewUpload(review) {
			if (review.upload) return Promise.resolve(review.upload);
			return review.editor.toBlob("image/png").then(upload).then(function (uploaded) {
				review.upload = uploaded;
				return uploaded;
			});
		}

		function reviewBusy(review, busy) {
			review.busy = busy;
			review.buttons.forEach(function (button) {
				button.disabled = busy;
			});
		}

		function reviewAsk() {
			var review = state.review;
			if (!review || review.busy) return;
			reviewBusy(review, true);
			reviewUpload(review)
				.then(function (uploaded) {
					return askAgent({
						ask: review.note.value,
						element: review.element,
						attachments: [uploaded.id],
						logs: review.attachLogs.checked ? logsForAgent() : undefined,
						quiet: true,
					});
				})
				.then(function (sent) {
					if (!sent) return;
					review.kept = true;
					closeReview();
					showToast("Sent to the agent");
				}, function (error) {
					showToast(error.message, true);
				})
				.finally(function () {
					reviewBusy(review, false);
				});
		}

		function reviewComment() {
			var review = state.review;
			if (!review || review.busy) return;
			reviewBusy(review, true);
			var fallback = review.kind === "video" ? "Recording (" + clock(review.durationMs) + ")" : "Screenshot";
			reviewUpload(review)
				.then(function (uploaded) {
					var target = review.element && review.element.isConnected ? review.element : null;
					return createThread(threadBody(target, review.note.value.trim() || fallback, [uploaded.id]));
				})
				.then(function (thread) {
					review.kept = true;
					closeReview();
					openThread(thread.id);
					showToast("Comment added");
				}, function (error) {
					showToast(error.message, true);
				})
				.finally(function () {
					reviewBusy(review, false);
				});
		}

		function reviewCopy() {
			var review = state.review;
			var clipboard = page.navigator.clipboard;
			if (!review || !review.editor) return;
			if (!clipboard || typeof clipboard.write !== "function" || typeof page.ClipboardItem !== "function") {
				showToast("Copying images isn't supported here", true);
				return;
			}
			clipboard.write([new page.ClipboardItem({ "image/png": review.editor.toBlob("image/png") })]).then(
				function () {
					showToast("Image copied");
				},
				function () {
					showToast("Clipboard access was refused", true);
				},
			);
		}

		function reviewDownload() {
			var review = state.review;
			if (!review) return;
			var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
			var name = "xo-" + appName() + "-" + stamp + (review.kind === "video" ? "." + extensionOf(review.upload.type) : ".png");
			var ready = review.kind === "video" ? Promise.resolve(review.upload.url) : review.editor.toBlob("image/png").then(function (blob) {
				return page.URL.createObjectURL(blob);
			});
			ready.then(function (href) {
				var link = h("a", { href: href, download: name, hidden: true });
				layer.append(link);
				link.click();
				link.remove();
				if (href.indexOf("blob:") === 0) {
					page.setTimeout(function () {
						page.URL.revokeObjectURL(href);
					}, 10000);
				}
				showToast("Downloading " + name);
			});
		}

		function reviewDiscard() {
			var review = state.review;
			if (!review) return;
			if (review.upload && !review.kept) {
				request("DELETE", "/uploads/" + review.upload.id).catch(function () {
					// Already gone.
				});
			}
			closeReview();
		}

		/** WebM files from MediaRecorder carry no duration, so a player can't seek until it has one. */
		function fixDuration(video) {
			video.addEventListener("loadedmetadata", function () {
				if (video.duration !== Infinity) return;
				video.currentTime = 1e101;
				video.addEventListener("durationchange", function reset() {
					if (video.duration === Infinity) return;
					video.removeEventListener("durationchange", reset);
					video.currentTime = 0;
				});
			});
		}

		// ------------------------------------------------------------ logs

		function countLogs() {
			var counts = { errors: 0, warnings: 0, network: 0, total: 0 };
			logs.list().forEach(function (entry) {
				counts.total += 1;
				if (entry.level === "error") counts.errors += 1;
				if (entry.level === "warn") counts.warnings += 1;
				if (entry.kind === "network") counts.network += 1;
			});
			return counts;
		}

		function describeCounts(counts) {
			var parts = [];
			if (counts.errors) parts.push(counts.errors + (counts.errors === 1 ? " error" : " errors"));
			if (counts.warnings) parts.push(counts.warnings + (counts.warnings === 1 ? " warning" : " warnings"));
			return parts.join(", ") || counts.total + " entries";
		}

		/** The log as the agent gets it: the latest entries, stack traces cut short. */
		function logsForAgent() {
			return logs.list().slice(-100).map(function (entry) {
				return {
					kind: entry.kind,
					level: entry.level,
					message: entry.message,
					url: entry.url,
					status: entry.status,
					source: entry.source,
					stack: entry.stack ? String(entry.stack).slice(0, 1200) : undefined,
					time: new Date(entry.time).toISOString(),
				};
			});
		}

		function logMatches(entry, filter) {
			if (filter === "error" || filter === "warn") return entry.level === filter;
			if (filter === "network") return entry.kind === "network";
			return true;
		}

		function renderLogsPanel() {
			var tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Filter" });
			var body = h("div", { class: "panel-body" });
			fillLogs(tabs, body);
			var ask = h("input", { class: "field", type: "text", placeholder: "Ask the agent about these…", "aria-label": "Ask the agent about the logs" });
			ask.value = countLogs().errors ? "Fix these errors" : "";
			var send = h("button", { class: "btn primary", type: "button" }, icon("send"), "Send");
			function sendLogs() {
				var entries = logsForAgent();
				if (!entries.length) return showToast("There is nothing in the log to send", true);
				askAgent({ ask: ask.value || "Look into these logs", logs: entries, button: send, sentMessage: "Sent " + entries.length + " log entries to the agent" });
			}
			send.addEventListener("click", sendLogs);
			ask.addEventListener("keydown", function (event) {
				if (event.key === "Enter") sendLogs();
			});
			panel.replaceChildren(
				h("div", { class: "panel-head" },
					h("div", { class: "grow" }, h("div", { class: "title" }, "Logs"), h("div", { class: "muted" }, "Errors, warnings and failed requests since the page loaded")),
					closeButton()),
				tabs,
				body,
				h("div", { class: "panel-foot" },
					h("div", { class: "row" }, ask),
					h("div", { class: "row" },
						send,
						h("button", { class: "btn", type: "button", onclick: function () {
							copyText(JSON.stringify({ page: state.path, logs: logsForAgent(), environment: environment() }, null, 2), "Copied the log");
						} }, icon("copy"), "Copy"),
						h("button", { class: "btn", type: "button", onclick: function () {
							logs.clear();
							renderPanel();
						} }, "Clear"))),
			);
			state.logsView = { tabs: tabs, body: body };
		}

		/** Just the tabs and the list, so new entries never disturb what is being typed below them. */
		function fillLogs(tabs, body) {
			var entries = logs.list().reverse();
			tabs.replaceChildren.apply(tabs, LOG_FILTERS.map(function (filter) {
				var count = entries.filter(function (entry) {
					return logMatches(entry, filter[0]);
				}).length;
				return h("button", {
					class: "tab",
					type: "button",
					role: "tab",
					"aria-selected": String(state.logFilter === filter[0]),
					onclick: function () {
						state.logFilter = filter[0];
						fillLogs(tabs, body);
					},
				}, filter[1], count ? h("span", { class: "count" + (filter[0] === "error" ? " error" : filter[0] === "warn" ? " warn" : "") }, String(count)) : null);
			}));
			var shown = entries.filter(function (entry) {
				return logMatches(entry, state.logFilter);
			});
			body.replaceChildren();
			if (!shown.length) {
				body.append(h("div", { class: "empty" }, entries.length ? "Nothing matches this filter." : "Nothing logged since the page loaded. Errors, warnings, failed requests and blocked resources show up here."));
			}
			shown.slice(0, 200).forEach(function (entry) {
				var detail = [
					entry.source ? h("div", { class: "mono muted" }, entry.source) : null,
					entry.kind === "network" && entry.url ? h("div", { class: "mono muted" }, entry.url) : null,
					entry.stack ? h("pre", { class: "stack mono" }, entry.stack) : null,
				].filter(Boolean);
				body.append(h("details", { class: "log" },
					h("summary", {},
						h("span", { class: "level " + (entry.level || "") }),
						h("span", { class: "log-text" }, entry.message),
						h("span", { class: "muted log-time" }, time(entry.time))),
					detail.length ? h("div", { class: "log-detail" }, detail) : h("div", { class: "log-detail muted" }, kindName(entry.kind))));
			});
		}

		function kindName(kind) {
			return { console: "Logged by the page", error: "Uncaught error", csp: "Content Security Policy", network: "Request" }[kind] || kind;
		}

		// ------------------------------------------------------------ customize

		function checkbox(text, on) {
			var input = h("input", { type: "checkbox" });
			input.checked = on;
			return { input: input, row: h("label", { class: "check" }, input, h("span", {}, text)) };
		}

		function runtimeList() {
			var list = h("div", { class: "tool-list" });
			runtimeTools.forEach(function (tool) {
				list.append(h("div", { class: "tool-row" },
					h("span", { class: "grow" }, icon(tool.icon), h("span", {}, tool.label), h("span", { class: "chip mono" }, tool.id))));
			});
			return [list, h("div", { class: "hint" }, "The page adds these with window.__xo_toolbar.addTool(); they aren't part of the saved design.")];
		}

		// ------------------------------------------------------------ prompts and page tools

		/** A saved prompt: sent about the whole page, or about the selected (or next picked) element. */
		function runPrompt(item) {
			var sent = "Sent “" + item.label + "” to the agent";
			if (item.scope === "page") return askAgent({ ask: item.prompt, sentMessage: sent });
			if (state.selected) return askAgent({ ask: item.prompt, element: state.selected, sentMessage: sent });
			setMode("inspect");
			state.pendingPrompt = item;
			showToast("Pick an element for “" + item.label + "”");
		}

		/** `window.__xo_toolbar.addTool({ id, label, icon, title, onClick })`, from the page. */
		function addTool(tool) {
			if (!tool || typeof tool.onClick !== "function") {
				page.console.warn("[telescope] addTool needs { id, label, onClick }");
				return;
			}
			var id = String(tool.id || tool.label || "tool").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "tool";
			var name = String(tool.label || tool.id || "Tool").replace(/\s+/g, " ").trim().slice(0, 24);
			runtimeTools.set(id, {
				id: id,
				label: name,
				icon: typeof tool.icon === "string" && Object.prototype.hasOwnProperty.call(XoUi.ICONS, tool.icon) ? tool.icon : "sparkles",
				title: String(tool.title || name).slice(0, 120),
				onClick: tool.onClick,
			});
			renderBar();
			if (state.panel === "designer") renderPanel();
		}

		function removeTool(id) {
			var key = String(id || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
			if (runtimeTools.delete(key)) {
				renderBar();
				if (state.panel === "designer") renderPanel();
			}
		}

		function runPageTool(tool) {
			var context = {
				app: config.project || "",
				page: state.path,
				element: state.selected || null,
				toast: function (message) {
					showToast(String(message));
				},
				ask: function (text) {
					return askAgent({ ask: text, element: state.selected || undefined });
				},
				screenshot: function () {
					return capture.grab({}).then(function (shot) {
						return XoCapture.toBlob(shot.canvas);
					});
				},
			};
			try {
				var result = tool.onClick(context);
				if (result && typeof result.then === "function") {
					result.then(null, function (error) {
						showToast((error && error.message) || tool.label + " failed", true);
					});
				}
			} catch (error) {
				showToast((error && error.message) || tool.label + " failed", true);
			}
		}

		// ------------------------------------------------------------ agent

		/** What an agent needs to act on an element, in the shape Replit, Stagewise and Claude Code converged on. */
		function describeElement(target) {
			var rect = target.getBoundingClientRect();
			var styles = page.getComputedStyle(target);
			var html = target.outerHTML;
			return {
				kind: "xo.element/v1",
				page: state.path,
				url: page.location.href,
				pageTitle: doc.title,
				nodeId: XoNodeId.build(target),
				label: label(target),
				tag: target.nodeName.toLowerCase(),
				id: target.id || undefined,
				classes: Array.prototype.slice.call(target.classList, 0, 12),
				text: XoNodeId.normalize(target.textContent).slice(0, 280) || undefined,
				attributes: pickAttributes(target),
				rect: { x: round(rect.left), y: round(rect.top), width: round(rect.width), height: round(rect.height) },
				styles: {
					display: styles.display,
					position: styles.position,
					color: styles.color,
					backgroundColor: effectiveBackground(target),
					fontFamily: styles.fontFamily,
					fontSize: styles.fontSize,
					fontWeight: styles.fontWeight,
					lineHeight: styles.lineHeight,
					padding: styles.padding,
					margin: styles.margin,
					border: styles.border,
					borderRadius: styles.borderRadius,
					gap: styles.gap,
				},
				html: html.length > 1500 ? html.slice(0, 1500) + "…" : html,
				viewport: { width: page.innerWidth, height: page.innerHeight, devicePixelRatio: page.devicePixelRatio },
			};
		}

		/** Where the request came from: enough for an agent to reproduce what the person saw. */
		function environment() {
			var nav = page.navigator;
			var zone;
			try {
				zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			} catch (error) {
				zone = undefined;
			}
			return {
				url: page.location.href,
				app: config.project || undefined,
				appVersion: config.appVersion || undefined,
				previewId: config.previewId || undefined,
				viewport: { width: page.innerWidth, height: page.innerHeight, devicePixelRatio: page.devicePixelRatio },
				userAgent: nav.userAgent,
				language: nav.language,
				colorScheme: page.matchMedia && page.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
				timeZone: zone,
				time: new Date().toISOString(),
			};
		}

		/** Hands a request to the agent: text, optionally an element, captures and logs. */
		function askAgent(input) {
			var question = String(input.ask || "").trim();
			var attachments = input.attachments || [];
			if (!question && !attachments.length) {
				showToast("Type what you want the agent to do first", true);
				return Promise.resolve(false);
			}
			if (input.button) input.button.disabled = true;
			return request("POST", "/agent", {
				ask: question,
				page: state.path,
				element: input.element ? describeElement(input.element) : undefined,
				attachments: attachments.length ? attachments : undefined,
				logs: input.logs,
				environment: environment(),
			})
				.then(function () {
					if (!input.quiet) showToast(input.sentMessage || "Sent to the agent");
					return true;
				}, function (error) {
					showToast(error.message, true);
					return false;
				})
				.finally(function () {
					if (input.button) input.button.disabled = false;
				});
		}

		function copyForAgent(target) {
			copyText(JSON.stringify({ element: describeElement(target) }, null, 2), "Copied for the agent");
		}

		function copyText(text, done) {
			var clipboard = page.navigator.clipboard;
			if (!clipboard) {
				showToast("Clipboard is not available here", true);
				return;
			}
			clipboard.writeText(text).then(
				function () {
					showToast(done);
				},
				function () {
					showToast("Clipboard access was refused", true);
				},
			);
		}

		// ------------------------------------------------------------ positions

		/** One pass per frame keeps boxes, popovers and pins on their elements through scrolling and layout changes. */
		function tick(now) {
			if (destroyed) return;
			var inspecting = state.mode === "inspect" || state.mode === "comment";
			if (inspecting && state.hovered && state.hovered !== state.selected && state.hovered.isConnected) {
				var hoveredRect = state.hovered.getBoundingClientRect();
				place(hoverBox, hoveredRect);
				hoverBox.hidden = false;
				if (!tip.hidden) placeNear(tip, hoveredRect);
			} else {
				hoverBox.hidden = true;
			}
			if (state.selected) {
				if (!state.selected.isConnected) {
					clearSelection();
				} else {
					var selectedRect = state.selected.getBoundingClientRect();
					place(selectBox, selectedRect);
					selectBox.hidden = false;
					placeNear(card, selectedRect);
				}
			}
			if (state.composer) placeComposer();
			if (state.open) updatePins(now);
			if (logsDirty && state.panel === "logs" && state.logsView) {
				logsDirty = false;
				fillLogs(state.logsView.tabs, state.logsView.body);
			}
			frameRequest = page.requestAnimationFrame(tick);
		}

		function updatePins(now) {
			pins.forEach(function (pin, id) {
				var thread = findThread(id);
				if (!thread) return;
				if (!thread.nodeId) {
					// A comment on the whole page has no pin; it is listed under Threads.
					pin.node.hidden = true;
					return;
				}
				if (!pin.target || !pin.target.isConnected || now - pin.checkedAt > 1000) {
					var found = XoNodeId.resolve(thread.nodeId, doc, thread.anchor);
					pin.target = found ? found.element : null;
					pin.checkedAt = now;
				}
				if (!pin.target) {
					pin.node.hidden = true;
					return;
				}
				var rect = pin.target.getBoundingClientRect();
				var anchor = thread.anchor || {};
				var x = rect.left + rect.width * (anchor.offsetX != null ? anchor.offsetX : 1);
				var y = rect.top + rect.height * (anchor.offsetY != null ? anchor.offsetY : 0);
				var visible = (rect.width > 0 || rect.height > 0) && x > -13 && y > -13 && x < page.innerWidth + 13 && y < page.innerHeight + 13;
				pin.node.hidden = !visible;
				if (visible) {
					pin.node.style.left = x + "px";
					pin.node.style.top = y + "px";
				}
			});
		}

		function placeComposer() {
			var draft = state.composer;
			if (!draft) return;
			if (!draft.target.isConnected) {
				closeComposer();
				return;
			}
			var rect = draft.target.getBoundingClientRect();
			var x = rect.left + rect.width * draft.offsetX;
			var y = rect.top + rect.height * draft.offsetY;
			placeNear(composer, { left: x, right: x, top: y, bottom: y, width: 0, height: 0 });
		}

		function targetOf(thread) {
			if (!thread.nodeId) return null;
			var pin = pins.get(thread.id);
			if (pin && pin.target && pin.target.isConnected) return pin.target;
			var found = XoNodeId.resolve(thread.nodeId, doc, thread.anchor);
			return found ? found.element : null;
		}

		function isOrphaned(thread) {
			return Boolean(thread.nodeId) && !targetOf(thread);
		}

		function watchPage() {
			if (!host.isConnected) doc.documentElement.appendChild(host);
			syncNavPath();
			if (page.location.pathname === state.path) return;
			state.path = page.location.pathname;
			clearSelection();
			closeComposer();
			if (state.panel === "thread") openPanel("threads");
			renderThreads();
			loadThreads();
		}

		// ------------------------------------------------------------ helpers

		function request(method, path, body) {
			return fetch(config.api + path, {
				method: method,
				credentials: "same-origin",
				headers: body ? { "content-type": "application/json" } : undefined,
				body: body ? JSON.stringify(body) : undefined,
			}).then(parseResponse);
		}

		function parseResponse(response) {
			return response.json().catch(function () {
				return {};
			}).then(function (data) {
				if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ")");
				return data;
			});
		}

		/** A short message next to the bar; `sticky` keeps it until the next one. */
		function showToast(message, isError, sticky) {
			toast.textContent = message;
			toast.classList.toggle("error", Boolean(isError));
			toast.hidden = false;
			var barRect = bar.getBoundingClientRect();
			var center = barRect.left + barRect.width / 2;
			toast.style.left = clamp(center - toast.offsetWidth / 2, 8, page.innerWidth - toast.offsetWidth - 8) + "px";
			toast.style.top = isTopDock() ? barRect.bottom + 10 + "px" : "auto";
			toast.style.bottom = isTopDock() ? "auto" : page.innerHeight - barRect.top + 10 + "px";
			page.clearTimeout(toastTimer);
			if (!sticky) {
				toastTimer = page.setTimeout(function () {
					toast.hidden = true;
				}, isError ? 4000 : 2400);
			}
		}

		function closeButton() {
			return h("button", { class: "btn", type: "button", "aria-label": "Close", onclick: closePanel }, icon("close"));
		}

		function swatch(color) {
			var node = h("span", { class: "swatch" });
			node.style.background = color;
			return node;
		}

		function place(node, rect) {
			node.style.left = rect.left + "px";
			node.style.top = rect.top + "px";
			node.style.width = rect.width + "px";
			node.style.height = rect.height + "px";
		}

		/** Below the rectangle when there is room, otherwise above; always inside the viewport. */
		function placeNear(node, rect) {
			var gap = 10;
			var width = node.offsetWidth;
			var height = node.offsetHeight;
			var top = rect.bottom + gap;
			if (top + height > page.innerHeight - 8) top = rect.top - height - gap;
			top = Math.max(8, Math.min(top, page.innerHeight - height - 8));
			var left = Math.max(8, Math.min(rect.left, page.innerWidth - width - 8));
			node.style.left = left + "px";
			node.style.top = top + "px";
		}

		function offsetsWithin(target, event) {
			var rect = target.getBoundingClientRect();
			return {
				offsetX: rect.width ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0,
				offsetY: rect.height ? clamp((event.clientY - rect.top) / rect.height, 0, 1) : 0,
			};
		}

		function padded(rect, by) {
			var left = Math.max(0, rect.left - by);
			var top = Math.max(0, rect.top - by);
			var right = Math.min(page.innerWidth, rect.right + by);
			var bottom = Math.min(page.innerHeight, rect.bottom + by);
			return { left: left, top: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
		}

		function rectBetween(a, b) {
			var left = Math.min(a.x, b.clientX);
			var top = Math.min(a.y, b.clientY);
			return { left: left, top: top, width: Math.abs(b.clientX - a.x), height: Math.abs(b.clientY - a.y) };
		}

		function pageElement(event) {
			var path = event.composedPath();
			for (var i = 0; i < path.length; i++) {
				var node = path[i];
				if (node && node.nodeType === 1 && node !== doc.documentElement) return node;
			}
			return null;
		}

		function isOurs(event) {
			return event.composedPath().indexOf(host) >= 0;
		}

		function block(event) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}

		function listen(target, type, handler, listenerOptions) {
			target.addEventListener(type, handler, listenerOptions);
			cleanups.push(function () {
				target.removeEventListener(type, handler, listenerOptions);
			});
		}

		function effectiveBackground(target) {
			for (var node = target; node && node.nodeType === 1; node = node.parentElement) {
				var color = page.getComputedStyle(node).backgroundColor;
				if (color && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color)) return color;
			}
			return "rgb(255, 255, 255)";
		}

		function pickAttributes(target) {
			var names = ["role", "aria-label", "data-testid", "href", "type", "name", "placeholder", "alt", "title"];
			var out = {};
			names.forEach(function (name) {
				var value = target.getAttribute(name);
				if (value) out[name] = value.slice(0, 160);
			});
			return out;
		}

		function appName() {
			return config.project || "app";
		}

		function readSession(key) {
			try {
				return page.sessionStorage.getItem("xo-toolbar:" + key);
			} catch (error) {
				return null;
			}
		}

		function writeSession(key, value) {
			try {
				page.sessionStorage.setItem("xo-toolbar:" + key, value);
			} catch (error) {
				// Storage can be blocked; the toolbar just forgets its state on reload.
			}
		}

		function readLocal(key) {
			try {
				return page.localStorage.getItem("xo-toolbar:" + key);
			} catch (error) {
				return null;
			}
		}

		function writeLocal(key, value) {
			try {
				page.localStorage.setItem("xo-toolbar:" + key, value);
			} catch (error) {
				// Blocked storage: the design is fetched again on the next load.
			}
		}

		/** A read-only snapshot for tests and debugging, including every visible control and where it is. */
		function debug() {
			function rectOf(node) {
				if (!node || node.hidden || !node.isConnected) return null;
				var rect = node.getBoundingClientRect();
				return { x: round(rect.left), y: round(rect.top), width: round(rect.width), height: round(rect.height) };
			}
			var review = state.review;
			return {
				booted: true,
				app: config.project || null,
				appVersion: config.appVersion || null,
				open: state.open,
				mode: state.mode,
				panel: state.panel,
				page: state.path,
				hovered: state.hovered ? label(state.hovered) : null,
				selected: state.selected ? label(state.selected) : null,
				composing: state.composer ? label(state.composer.target) : null,
				tipVisible: !tip.hidden,
				cardVisible: !card.hidden,
				toast: toast.hidden ? null : toast.textContent,
				layout: clone(state.layout),
				layoutSource: state.layoutSource,
				saveStatus: state.saveStatus,
				tools: Object.keys(toolButtons),
				pageTools: Array.from(runtimeTools.keys()),
				bar: rectOf(bar),
				barClasses: bar.className,
				accent: layer.style.getPropertyValue("--accent"),
				panelRect: rectOf(panel),
				appMenu: rectOf(appMenu),
				nav: navParts ? {
					version: config.appVersion || "main",
					project: appName(),
					path: navParts.path.value,
					menu: state.navMenu,
					rects: { version: rectOf(navParts.version), project: rectOf(navParts.project), path: rectOf(navParts.path) },
					items: appMenu.hidden ? null : Array.prototype.map.call(appMenu.querySelectorAll(".menu-section, .menu-item, .menu-note"), function (node) {
						return node.href ? node.textContent + " -> " + node.href : node.textContent;
					}),
				} : null,
				recordMenu: rectOf(recordMenu),
				card: rectOf(card),
				composer: rectOf(composer),
				tip: rectOf(tip),
				logo: rectOf(logoButton),
				area: state.mode === "area",
				sharing: capture.isSharing(),
				recording: state.recording ? { elapsed: state.recording.controls.elapsed(), paused: state.recording.controls.paused() } : null,
				review: review ? {
					kind: review.kind,
					marks: review.editor ? review.editor.count() : 0,
					upload: review.upload,
					canvas: review.editor ? { width: review.editor.canvas.width, height: review.editor.canvas.height, shown: rectOf(review.editor.canvas) } : null,
				} : null,
				logs: countLogs(),
				threads: pageThreads().map(function (thread, index) {
					var pin = pins.get(thread.id);
					return {
						number: index + 1,
						id: thread.id,
						status: thread.status,
						text: thread.comments[0] ? thread.comments[0].text : "",
						nodeId: thread.nodeId,
						attachments: threadAttachmentIds(thread).length,
						pinVisible: Boolean(pin && !pin.node.hidden),
						pinAt: pin && !pin.node.hidden ? { x: parseFloat(pin.node.style.left), y: parseFloat(pin.node.style.top) } : null,
					};
				}),
				controls: controls(),
			};
		}

		function controls() {
			var out = [];
			Array.prototype.forEach.call(root.querySelectorAll("button, a, input, textarea, label, summary, img, video"), function (node) {
				var rect = node.getBoundingClientRect();
				if (!rect.width || !rect.height) return;
				var zone = node.closest(".review, .panel, .bar, .card, .composer, .menu, .area");
				out.push({
					tag: node.nodeName.toLowerCase(),
					within: zone ? zone.className.split(" ")[0] : "",
					text: XoNodeId.normalize(node.textContent).slice(0, 60),
					label: node.getAttribute("aria-label") || "",
					title: node.getAttribute("title") || "",
					pressed: node.getAttribute("aria-pressed"),
					checked: node.getAttribute("aria-checked") || (node.type === "checkbox" || node.type === "radio" ? String(node.checked) : null),
					disabled: Boolean(node.disabled),
					src: node.getAttribute("src") || undefined,
					loaded: node.nodeName === "IMG" ? node.complete && node.naturalWidth > 0 : node.nodeName === "VIDEO" ? node.readyState >= 1 : undefined,
					x: round(rect.left + rect.width / 2),
					y: round(rect.top + rect.height / 2),
					width: round(rect.width),
					height: round(rect.height),
				});
			});
			return out;
		}

		function destroy() {
			destroyed = true;
			page.cancelAnimationFrame(frameRequest);
			page.clearTimeout(toastTimer);
			page.clearTimeout(saveTimer);
			if (state.recording) state.recording.controls.cancel();
			capture.release();
			cleanups.forEach(function (cleanup) {
				cleanup();
			});
			root.replaceChildren();
		}
	}

	// -------------------------------------------------------------- formatting

	function label(element) {
		var text = element.nodeName.toLowerCase();
		if (element.id) text += "#" + element.id;
		var classes = Array.prototype.slice.call(element.classList, 0, 3);
		if (classes.length) text += "." + classes.join(".");
		return text;
	}

	function size(rect) {
		return round(rect.width) + " × " + round(rect.height);
	}

	function round(value) {
		return Math.round(value);
	}

	function clamp(value, min, max) {
		return Math.min(max, Math.max(min, value));
	}

	function firstFamily(family) {
		return String(family).split(",")[0].replace(/["']/g, "").trim();
	}

	function hex(color) {
		var match = /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(color);
		// lab(), oklch() and other modern spaces stay as written, with shorter numbers.
		if (!match) return String(color).replace(/(-?\d+\.\d{2})\d+/g, "$1");
		var value = "#" + [match[1], match[2], match[3]].map(function (part) {
			return Number(part).toString(16).padStart(2, "0");
		}).join("");
		return match[4] !== undefined && Number(match[4]) < 1 ? value + " · " + Math.round(Number(match[4]) * 100) + "%" : value;
	}

	function clone(value) {
		return JSON.parse(JSON.stringify(value));
	}

	/** A cached design, if it still has the shape this version of the toolbar expects. */
	function parseLayout(text) {
		if (!text) return null;
		try {
			var layout = JSON.parse(text);
			if (!layout || !layout.dock || POSITIONS.indexOf(layout.dock.position) < 0 || !Array.isArray(layout.items)) return null;
			if (!layout.theme || !XoUi.hexToRgb(layout.theme.accent)) return null;
			return layout;
		} catch (error) {
			return null;
		}
	}

	function clock(ms) {
		var seconds = Math.max(0, Math.floor(ms / 1000));
		return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
	}

	function time(stamp) {
		var date = new Date(stamp);
		return [date.getHours(), date.getMinutes(), date.getSeconds()].map(function (part) {
			return String(part).padStart(2, "0");
		}).join(":");
	}

	function extensionOf(type) {
		return type === "video/mp4" ? "mp4" : "webm";
	}

	function ago(iso) {
		var seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
		if (seconds < 45) return "just now";
		if (seconds < 3600) return Math.round(seconds / 60) + " min ago";
		if (seconds < 86400) return Math.round(seconds / 3600) + " h ago";
		return Math.round(seconds / 86400) + " d ago";
	}

	/** Stand-in when the loader predates the log: nothing is ever logged. */
	function emptyLog() {
		return {
			list: function () {
				return [];
			},
			subscribe: function () {
				return function () {};
			},
			clear: function () {},
		};
	}
})();
