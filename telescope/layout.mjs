/**
 * telescope's design schema: what the bar may contain and where it docks.
 * telescope owns it; galileo stores designs and checks every one it saves
 * with `normalizeLayout`, and the browser code gets the lists and the default
 * design from `index.mjs`.
 *
 * A design is plain JSON:
 *
 *   {
 *     "version": 1,
 *     "dock":  { "position": "bottom-center", "labels": true, "startOpen": true },
 *     "theme": { "accent": "#83d63a" },
 *     "items": [
 *       { "type": "apps" }, { "type": "separator" }, { "type": "inspect" }, …,
 *       { "type": "link", "id": "storybook", "label": "Storybook", "icon": "book", "href": "http://sb.localhost:4100/" },
 *       { "type": "prompt", "id": "polish", "label": "Polish", "icon": "sparkles",
 *         "prompt": "Tighten the spacing and type of this element", "scope": "element" }
 *     ]
 *   }
 *
 * `normalizeLayout` accepts anything and returns a valid design: unknown tools
 * are dropped, built-in tools appear at most once, text is trimmed to size,
 * and links must be http(s).
 */

export const BUILT_IN_TOOLS = ["apps", "inspect", "comment", "threads", "screenshot", "area", "record", "logs"];
export const CUSTOM_TOOLS = ["link", "prompt"];
export const DOCK_POSITIONS = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];
export const CUSTOM_ICONS = ["link", "book", "sparkles", "bug", "terminal", "star", "rocket", "chat", "globe", "code", "wand", "flag"];
export const MAX_ITEMS = 24;

export const DEFAULT_LAYOUT = deepFreeze({
	version: 1,
	dock: { position: "bottom-center", labels: true, startOpen: true },
	theme: { accent: "#83d63a" },
	items: [
		{ type: "apps" },
		{ type: "separator" },
		{ type: "inspect" },
		{ type: "comment" },
		{ type: "threads" },
		{ type: "separator" },
		{ type: "screenshot" },
		{ type: "area" },
		{ type: "record" },
		{ type: "logs" },
	],
});

export function defaultLayout() {
	return JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
}

export function normalizeLayout(input) {
	const source = isObject(input) ? input : {};
	const dock = isObject(source.dock) ? source.dock : {};
	const theme = isObject(source.theme) ? source.theme : {};
	return {
		version: 1,
		dock: {
			position: DOCK_POSITIONS.includes(dock.position) ? dock.position : DEFAULT_LAYOUT.dock.position,
			labels: typeof dock.labels === "boolean" ? dock.labels : DEFAULT_LAYOUT.dock.labels,
			startOpen: typeof dock.startOpen === "boolean" ? dock.startOpen : DEFAULT_LAYOUT.dock.startOpen,
		},
		theme: {
			accent: /^#[0-9a-f]{6}$/i.test(String(theme.accent ?? "")) ? theme.accent.toLowerCase() : DEFAULT_LAYOUT.theme.accent,
		},
		items: Array.isArray(source.items) ? normalizeItems(source.items) : defaultLayout().items,
	};
}

function normalizeItems(items) {
	const out = [];
	const seenBuiltIns = new Set();
	const seenIds = new Set();
	for (const raw of items) {
		if (out.length >= MAX_ITEMS) break;
		if (!isObject(raw)) continue;
		const type = String(raw.type ?? "");
		if (type === "separator") {
			// No doubled separators, and none at the very start.
			if (out.length && out[out.length - 1].type !== "separator") out.push({ type });
			continue;
		}
		if (BUILT_IN_TOOLS.includes(type)) {
			if (seenBuiltIns.has(type)) continue;
			seenBuiltIns.add(type);
			out.push({ type });
			continue;
		}
		if (!CUSTOM_TOOLS.includes(type)) continue;
		const custom = normalizeCustom(type, raw, seenIds);
		if (custom) {
			seenIds.add(custom.id);
			out.push(custom);
		}
	}
	while (out.length && out[out.length - 1].type === "separator") out.pop();
	return out;
}

function normalizeCustom(type, raw, seenIds) {
	const label = clip(raw.label, 24);
	if (!label) return null;
	let id = slug(raw.id) || slug(label) || "tool";
	for (let n = 2; seenIds.has(id); n += 1) id = `${slug(raw.id) || slug(label) || "tool"}-${n}`;
	const icon = CUSTOM_ICONS.includes(raw.icon) ? raw.icon : type === "link" ? "link" : "sparkles";
	if (type === "link") {
		const href = safeHref(raw.href);
		return href ? { type, id, label, icon, href } : null;
	}
	const prompt = clip(raw.prompt, 1000);
	if (!prompt) return null;
	return { type, id, label, icon, prompt, scope: raw.scope === "page" ? "page" : "element" };
}

function safeHref(value) {
	try {
		const url = new URL(String(value ?? "").trim());
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

function clip(value, max) {
	return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function slug(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
}

function deepFreeze(value) {
	for (const inner of Object.values(value)) {
		if (typeof inner === "object" && inner !== null) deepFreeze(inner);
	}
	return Object.freeze(value);
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
