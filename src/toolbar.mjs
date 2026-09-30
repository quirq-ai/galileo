/**
 * The toolbar the gateway carries is its own project, xo-toolbar. It is found,
 * in this order:
 *
 *   1. XO_TOOLBAR_DIR, a checkout to use instead (for working on another copy)
 *   2. the installed package (`npm install` links ../xo-toolbar)
 *   3. a sibling checkout, ../xo-toolbar, so a fresh clone runs without installing
 *
 * The gateway uses three things from it: `readBundle(name)` for the browser
 * files, `normalizeLayout` and `defaultLayout` to check and fill in designs,
 * and the schema lists it offers the toolbar's editor.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function load() {
	const override = process.env.XO_TOOLBAR_DIR;
	if (override) return importEntry(path.resolve(override, "index.mjs"));
	try {
		return await import("xo-toolbar");
	} catch (error) {
		if (error.code !== "ERR_MODULE_NOT_FOUND" || !String(error.message).includes("xo-toolbar")) throw error;
	}
	const sibling = path.resolve(HERE, "..", "..", "xo-toolbar", "index.mjs");
	if (existsSync(sibling)) return importEntry(sibling);
	throw new Error("xo-toolbar was not found: run `npm install` in galileo, keep a checkout next to it, or set XO_TOOLBAR_DIR.");
}

function importEntry(file) {
	return import(pathToFileURL(file).href);
}

export const toolbar = await load();
