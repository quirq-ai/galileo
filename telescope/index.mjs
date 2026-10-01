/**
 * telescope, the bar galileo carries into every page: the browser files
 * galileo serves, and the design schema it checks designs with.
 *
 *   loader.js    the one script galileo carries into each page
 *   app.js       telescope itself, which the loader runs in its hidden frame
 *   designer.js  the design editor alone, for a host's own settings page
 *
 * Bundles are plain classic scripts concatenated from `src/`, read fresh on
 * every call so an edit shows on the next page load. Each one that needs the
 * schema starts with `var XoToolbarSchema = {…}`, built from `layout.mjs`, so
 * the browser and the host never disagree on tools, docks or the default design.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILT_IN_TOOLS, CUSTOM_ICONS, CUSTOM_TOOLS, DEFAULT_LAYOUT, DOCK_POSITIONS, MAX_ITEMS } from "./layout.mjs";

export * from "./layout.mjs";

export const VERSION = "0.2.0";
export const SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "src");

/** Each bundle and the files it is made of, in order. `@schema` is the generated schema line. */
export const BUNDLES = Object.freeze({
	"loader.js": ["loader.js"],
	"app.js": ["@schema", "ui.js", "node-id.js", "capture.js", "annotate.js", "designer.js", "app.js"],
	"designer.js": ["@schema", "ui.js", "designer.js"],
});

/** The JavaScript of one bundle, or `undefined` for a name that isn't one. */
export async function readBundle(name) {
	const parts = Object.hasOwn(BUNDLES, name) ? BUNDLES[name] : undefined;
	if (!parts) return undefined;
	const texts = await Promise.all(parts.map((part) => (part === "@schema" ? schemaScript() : readFile(path.join(SOURCE_DIR, part), "utf8"))));
	return texts.join("\n");
}

/** The schema as the browser sees it. */
export function schema() {
	return {
		version: VERSION,
		tools: BUILT_IN_TOOLS,
		customTools: CUSTOM_TOOLS,
		positions: DOCK_POSITIONS,
		icons: CUSTOM_ICONS,
		maxItems: MAX_ITEMS,
		defaultLayout: DEFAULT_LAYOUT,
	};
}

export function schemaScript() {
	return `var XoToolbarSchema = ${JSON.stringify(schema())};\n`;
}
