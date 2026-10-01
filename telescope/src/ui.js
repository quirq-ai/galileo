/*!
 * telescope's UI kit: what telescope, its design editor and a host's settings page share.
 *
 * Icons, the built-in tools' names, the base stylesheet, an element helper
 * bound to a document, and the accent theme. Everything here works under a
 * strict Content Security Policy: styles are adopted as constructed
 * stylesheets and set through the CSSOM, never as style attributes.
 */
var XoUi = (function () {
	"use strict";

	var SVG_NS = "http://www.w3.org/2000/svg";

	var ICONS = {
		inspect: "M3.5 2.5 12.5 7 8.6 8.4 7 12.5Z",
		comment: "M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.5 13.5V11H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
		threads: "M3 4.5h10M3 8h10M3 11.5h6",
		screenshot: "M2.5 5.5a1 1 0 0 1 1-1h1.8l1-1.5h3.4l1 1.5h1.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1ZM8 6.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z",
		area: "M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11M7 2.5h2M7 13.5h2M2.5 7v2M13.5 7v2",
		record: "M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z",
		logs: "M2.5 4h7M2.5 7h7M2.5 10h4.5M12.5 4v5M12.5 11.8v.4",
		customize: "M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M10 3v3M6 10v3",
		close: "M4.5 4.5l7 7m0-7-7 7",
		parent: "M8 13V3.5M4.5 7 8 3.5 11.5 7",
		up: "M8 12.5V3.5M4.5 7 8 3.5 11.5 7",
		down: "M8 3.5v9M4.5 9 8 12.5 11.5 9",
		send: "M14 2 2.5 7l4.5 2 2 4.5Z",
		copy: "M5.5 5.5h7v7h-7ZM3.5 10.5v-7h7",
		back: "M9.5 3.5 5 8l4.5 4.5",
		target: "M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z",
		chevron: "M4.5 6.5 8 10l3.5-3.5",
		pause: "M6 4v8M10 4v8",
		trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9",
		download: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10",
		plus: "M8 3.5v9M3.5 8h9",
		grip: "M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01",
		undo: "M5.5 6.5H10a3 3 0 0 1 0 6H6.5M5.5 6.5 8 4M5.5 6.5 8 9",
		arrow: "M3 13 12.5 3.5M7 3.5h5.5V9",
		box: "M3 4h10v8H3Z",
		pen: "M3 13l.5-2.5L10.5 3.5l2 2-7 7ZM9 5l2 2",
		redact: "M2.5 5h11v6h-11Z",
		link: "M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1",
		book: "M8 4.5C6.5 3.5 4.5 3.3 2.5 3.5V12c2-.2 4 0 5.5 1 1.5-1 3.5-1.2 5.5-1V3.5c-2-.2-4 0-5.5 1ZM8 4.5V13",
		sparkles: "M7 2.5l1.2 3.3L11.5 7 8.2 8.2 7 11.5 5.8 8.2 2.5 7l3.3-1.2ZM12 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6Z",
		bug: "M5.5 5.5a2.5 2.5 0 0 1 5 0M4.5 7h7v3a3.5 3.5 0 0 1-7 0ZM8 7v6.5M2.5 8.5h2M11.5 8.5h2M3 12l1.8-1M13 12l-1.8-1M3.5 5l1.5 1.5M12.5 5 11 6.5",
		terminal: "M2.5 3.5h11v9h-11ZM5 6.5l2 1.5-2 1.5M8.5 10h2.5",
		star: "M8 2.5l1.7 3.6 3.8.5-2.8 2.6.7 3.8L8 11.2 4.6 13l.7-3.8-2.8-2.6 3.8-.5Z",
		rocket: "M9.5 3c2-1 4-.5 4-.5s.5 2-.5 4L9.5 10 6 6.5ZM6 6.5H3.5L2.5 8l3 .5M9.5 10v2.5L8 13.5l-.5-3M5 11c-1 .5-1.5 2-1.5 2s1.5-.5 2-1.5",
		chat: "M3 3.5h10v7H7l-3 2.5v-2.5H3ZM5.5 6.5h5M5.5 8.5h3",
		globe: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2.5 8h11M8 2.5C6.3 4 5.5 5.8 5.5 8s.8 4 2.5 5.5C9.7 12 10.5 10.2 10.5 8S9.7 4 8 2.5Z",
		code: "M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5",
		wand: "M2.5 13.5l8-8M9 4l3 3M12.5 2v2M11.5 3h2M5 2.5v2M4 3.5h2M13 9.5v2M12 10.5h2",
		flag: "M3.5 13.5v-11M3.5 3h7L9 5.5 10.5 8h-7",
	};
	/** Filled shapes drawn on top of an icon's strokes (or alone). */
	var FILLED = {
		record: "M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z",
		play: "M5.5 3.5v9l7-4.5Z",
		stop: "M4.5 4.5h7v7h-7Z",
		redact: "M4.5 7h7v2h-7Z",
	};

	/** The built-in tools a design can place on the bar, as the bar and the editor name them. */
	var TOOLS = {
		apps: { label: "Navbar", icon: "globe", title: "Version, app and page path" },
		inspect: { label: "Inspect", icon: "inspect", title: "Inspect elements (Alt+Shift+I)", toggle: true },
		comment: { label: "Comment", icon: "comment", title: "Comment on an element (Alt+Shift+C)", toggle: true },
		threads: { label: "Threads", icon: "threads", title: "Comments on this page", toggle: true },
		screenshot: { label: "Screenshot", icon: "screenshot", title: "Screenshot the page (Alt+Shift+S)" },
		area: { label: "Area", icon: "area", title: "Capture an area or one element (Alt+Shift+A)" },
		record: { label: "Record", icon: "record", title: "Record the page (Alt+Shift+R)" },
		logs: { label: "Logs", icon: "logs", title: "Errors, warnings and failed requests (Alt+Shift+L)", toggle: true },
	};

	var STYLES = [
		":host { all: initial; }",
		"[hidden] { display: none !important; }",
		".xo { --accent: #83d63a; --accent-ink: #10150c; --accent-fg: #83d63a; --accent-text: #d9f5bb;",
		"  --accent-soft: rgba(131, 214, 58, 0.12); --accent-mid: rgba(131, 214, 58, 0.22); --accent-line: rgba(131, 214, 58, 0.34);",
		"  --surface: #111410; --field: #1b2018; --text: #eef2ea; --muted: #9ca693; --faint: #7f8977;",
		"  color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;",
		"  font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }",
		".xo * { box-sizing: border-box; }",
		".mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }",
		".muted { color: var(--muted); }",
		".grow { flex: 1; min-width: 0; }",
		".head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }",
		".title { font-weight: 600; color: var(--accent-text); overflow-wrap: anywhere; }",
		".line { margin-top: 4px; overflow-wrap: anywhere; }",
		".hint { margin-top: 8px; color: var(--faint); font-size: 11.5px; }",
		".row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }",
		".row.end { justify-content: flex-end; }",
		".empty { padding: 24px 4px; color: var(--muted); }",
		".side-label, .section-title { color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }",
		".btn { all: unset; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;",
		"  border-radius: 7px; background: rgba(255, 255, 255, 0.08); color: #e6ecdf; cursor: pointer; white-space: nowrap;",
		"  font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1; }",
		".btn:hover { background: rgba(255, 255, 255, 0.14); }",
		".btn.primary { background: var(--accent); color: var(--accent-ink); font-weight: 600; }",
		".btn.primary:hover { filter: brightness(1.08); }",
		".btn.danger { color: #ffb4a8; }",
		".btn[disabled] { opacity: 0.5; cursor: default; }",
		".btn[aria-pressed='true'] { background: rgba(255, 255, 255, 0.16); }",
		".btn:focus-visible, .tool:focus-visible, .logo:focus-visible, .mini:focus-visible, .grip:focus-visible, .tab:focus-visible {",
		"  outline: 2px solid var(--accent-fg); outline-offset: 2px; }",
		".icon { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6;",
		"  stroke-linecap: round; stroke-linejoin: round; }",
		".icon .fill { fill: currentColor; stroke: none; }",
		".field { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 7px 10px; border-radius: 8px;",
		"  background: var(--field); border: 1px solid rgba(255, 255, 255, 0.14); color: var(--text);",
		"  font-family: inherit; font-size: 13px; line-height: 1.45; white-space: pre-wrap; }",
		".field:focus { border-color: var(--accent-fg); }",
		"textarea.field { min-height: 72px; }",
		".field::placeholder { color: var(--faint); }",
		".chip { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11px;",
		"  background: rgba(255, 255, 255, 0.08); color: #c9d1c1; overflow-wrap: anywhere; }",
		".chip.warn { background: rgba(255, 176, 92, 0.16); color: #ffc58a; }",
		".chips { display: flex; flex-wrap: wrap; gap: 6px; }",
		".check { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; }",
		".check input { margin: 0; accent-color: var(--accent); }",
		".count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px;",
		"  padding: 0 5px; border-radius: 9px; background: var(--accent-mid); color: var(--accent-text); font-size: 11px; }",
		".count.error { background: rgba(255, 107, 94, 0.24); color: #ffb4a8; }",
		".count.warn { background: rgba(255, 176, 92, 0.2); color: #ffc58a; }",
		".dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #6c7566; }",
		".dot.up { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-mid); }",
		".panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 12px 14px;",
		"  border-bottom: 1px solid rgba(255, 255, 255, 0.08); }",
		".panel-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 14px 14px; }",
		".panel-foot { padding: 10px 14px 12px; border-top: 1px solid rgba(255, 255, 255, 0.08); }",
		".panel-foot .row:first-child { margin-top: 0; }",
		// The bar and its tools, shared by the toolbar and every preview of a design.
		".bar { position: fixed; z-index: 5; display: flex; align-items: center; gap: 2px; width: max-content;",
		"  max-width: calc(100vw - 16px); padding: 4px; pointer-events: auto; background: var(--surface);",
		"  border: 1px solid var(--accent-line); border-radius: 999px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.38); }",
		// Too wide for one row: the XO handle stays first and the tools wrap beside it.
		".bar.wrap { align-items: flex-start; }",
		".bar.wrap .extras { flex: 1; min-width: 0; flex-wrap: wrap; }",
		".bar.wrap { border-radius: 18px; }",
		".tool, .logo { all: unset; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px;",
		"  border-radius: 999px; color: #dfe6d8; cursor: pointer; font-family: inherit; font-size: 12.5px; font-weight: 500;",
		"  white-space: nowrap; text-decoration: none; }",
		".tool:hover, .logo:hover { background: rgba(255, 255, 255, 0.09); }",
		".tool[aria-pressed='true'] { background: var(--accent); color: var(--accent-ink); }",
		".tool[aria-pressed='true'] .count { background: rgba(16, 21, 12, 0.2); color: var(--accent-ink); }",
		".logo { padding: 0 10px; color: var(--accent-fg); font-weight: 800; letter-spacing: -0.02em; cursor: grab; touch-action: none; }",
		".bar.no-labels .tool .label, .bar.compact .tool .label, .tool.icon-only .label { display: none; }",
		".bar.no-labels .tool, .bar.compact .tool, .tool.icon-only { padding: 0 9px; }",
		".extras { display: flex; align-items: center; gap: 2px; }",
		".sep { flex: none; width: 1px; height: 18px; margin: 0 4px; background: rgba(255, 255, 255, 0.14); }",
		".app-name { font-weight: 600; max-width: 14ch; overflow: hidden; text-overflow: ellipsis; }",
		".nav { display: inline-flex; align-items: center; gap: 1px; min-width: 0; height: 30px; padding: 0 2px;",
		"  border-radius: 999px; background: rgba(255, 255, 255, 0.06); }",
		".nav-seg { all: unset; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px;",
		"  border-radius: 999px; color: #dfe6d8; cursor: pointer; font-family: inherit; font-size: 12.5px; font-weight: 600;",
		"  white-space: nowrap; }",
		".nav-seg:hover, .nav-seg[aria-expanded='true'] { background: rgba(255, 255, 255, 0.1); }",
		".nav-seg:focus-visible, .nav-path:focus-visible { outline: 2px solid var(--accent-fg, #83d63a); outline-offset: 1px; }",
		".nav-version { color: var(--accent-text, #d9f5bb); }",
		".nav-text { max-width: 16ch; overflow: hidden; text-overflow: ellipsis; }",
		".nav-sep { flex: none; color: var(--faint, #7f8977); user-select: none; }",
		".nav-path { all: unset; display: inline-block; box-sizing: content-box; height: 26px; line-height: 26px; padding: 0 8px;",
		"  min-width: 4ch; max-width: 30ch; border-radius: 999px; color: var(--text, #eef2ea); cursor: text;",
		"  font: 500 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
		".nav-path:hover { background: rgba(255, 255, 255, 0.06); }",
		".nav-path:focus { background: var(--field, #1b2018); }",
		".nav-copy { padding: 0 7px; color: var(--muted, #9ca693); }",
		".bar.compact .nav-text { max-width: 10ch; }",
		".bar.compact .nav-path { max-width: 16ch; }",
		".bar.compact .nav-copy { display: none; }",
	].join("\n");

	/** Element and icon helpers bound to one document (the page's, or a host page's). */
	function create(doc) {
		function h(tag, props) {
			var node = doc.createElement(tag);
			var attributes = props || {};
			Object.keys(attributes).forEach(function (key) {
				var value = attributes[key];
				if (value === undefined || value === null || value === false) return;
				if (key.indexOf("on") === 0) node.addEventListener(key.slice(2), value);
				else if (key === "class") node.className = value;
				else if (key === "hidden") node.hidden = true;
				else if (key === "disabled") node.disabled = true;
				else node.setAttribute(key, value === true ? "" : value);
			});
			for (var i = 2; i < arguments.length; i++) appendChild(node, arguments[i]);
			return node;
		}

		/** Appends nodes, strings and (nested) lists of them; null, undefined and false are skipped. */
		function appendChild(node, child) {
			if (child === null || child === undefined || child === false) return;
			if (Array.isArray(child)) {
				child.forEach(function (item) {
					appendChild(node, item);
				});
				return;
			}
			node.append(child);
		}

		function icon(name) {
			var svg = doc.createElementNS(SVG_NS, "svg");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("class", "icon");
			svg.setAttribute("aria-hidden", "true");
			if (ICONS[name]) {
				var stroke = doc.createElementNS(SVG_NS, "path");
				stroke.setAttribute("d", ICONS[name]);
				svg.appendChild(stroke);
			}
			if (FILLED[name]) {
				var fill = doc.createElementNS(SVG_NS, "path");
				fill.setAttribute("d", FILLED[name]);
				fill.setAttribute("class", "fill");
				svg.appendChild(fill);
			}
			return svg;
		}

		return { doc: doc, h: h, icon: icon, appendChild: appendChild };
	}

	/** The accent color, and the shades derived from it, as CSS variables on `node`. */
	function theme(node, accent) {
		var rgb = hexToRgb(accent) || [131, 214, 58];
		var light = luminance(rgb);
		var set = function (name, value) {
			node.style.setProperty(name, value);
		};
		set("--accent", accent);
		set("--accent-ink", light > 0.36 ? "#10150c" : "#ffffff");
		// Text and focus rings in the accent sit on a near-black surface, so dark accents are lifted.
		set("--accent-fg", light < 0.2 ? mix(rgb, [255, 255, 255], 0.45) : accent);
		set("--accent-text", mix(rgb, [255, 255, 255], 0.7));
		set("--accent-soft", rgba(rgb, 0.12));
		set("--accent-mid", rgba(rgb, 0.22));
		set("--accent-line", rgba(rgb, 0.34));
	}

	function hexToRgb(value) {
		var match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(value));
		return match ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] : null;
	}

	/** WCAG relative luminance, 0 for black to 1 for white. */
	function luminance(rgb) {
		var channels = rgb.map(function (channel) {
			var c = channel / 255;
			return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
		});
		return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
	}

	function mix(a, b, amount) {
		return "rgb(" + a.map(function (channel, i) {
			return Math.round(channel + (b[i] - channel) * amount);
		}).join(", ") + ")";
	}

	function rgba(rgb, alpha) {
		return "rgba(" + rgb.join(", ") + ", " + alpha + ")";
	}

	/** The items a bar shows: known tools, with separators only between them (none first, last or doubled). */
	function visibleItems(items) {
		var out = [];
		(items || []).forEach(function (item) {
			if (item.type === "separator") {
				if (out.length && out[out.length - 1].type !== "separator") out.push(item);
				return;
			}
			if (TOOLS[item.type] || item.type === "link" || item.type === "prompt") out.push(item);
		});
		while (out.length && out[out.length - 1].type === "separator") out.pop();
		return out;
	}

	/** Places a node at one of the six dock positions, `gaps` from the edges. */
	function dockAt(node, position, gaps) {
		var parts = String(position).split("-");
		node.style.top = parts[0] === "top" ? gaps.top : "auto";
		node.style.bottom = parts[0] === "bottom" ? gaps.bottom : "auto";
		node.style.left = parts[1] === "left" ? gaps.side : parts[1] === "center" ? "50%" : "auto";
		node.style.right = parts[1] === "right" ? gaps.side : "auto";
		node.style.transform = parts[1] === "center" ? "translateX(-50%)" : "none";
	}

	return {
		create: create,
		theme: theme,
		dockAt: dockAt,
		visibleItems: visibleItems,
		hexToRgb: hexToRgb,
		ICONS: ICONS,
		FILLED: FILLED,
		TOOLS: TOOLS,
		STYLES: STYLES,
	};
})();
