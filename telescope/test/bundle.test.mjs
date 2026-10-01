/**
 * The files a host serves: each bundle runs as one classic script and defines
 * what its host calls, with the same schema the package exports. `npm test`.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { describe, test } from "node:test";

import { BUNDLES, readBundle, schema } from "../index.mjs";

describe("bundles", () => {
	test("app.js defines the toolbar and everything it is built from", async () => {
		const context = run(await readBundle("app.js"));
		assert.equal(typeof context.window.initXoToolbar, "function");
		for (const name of ["XoToolbarSchema", "XoUi", "XoNodeId", "XoCapture", "XoAnnotate", "XoDesigner"]) {
			assert.ok(context[name], `${name} is defined`);
		}
	});

	test("designer.js is the editor alone, for a host's settings page", async () => {
		const context = run(await readBundle("designer.js"));
		assert.equal(typeof context.XoDesigner.create, "function");
		assert.equal(typeof context.XoDesigner.preview, "function");
		assert.equal(context.XoCapture, undefined);
		assert.equal(context.window.initXoToolbar, undefined);
	});

	test("loader.js is the one script a page references, and it stands alone", async () => {
		const loader = await readBundle("loader.js");
		assert.match(loader, /document\.currentScript/);
		assert.doesNotMatch(loader, /XoToolbarSchema/);
	});

	test("the browser gets the package's schema, and has a name and an icon for everything in it", async () => {
		const context = run(await readBundle("designer.js"));
		assert.deepEqual(plain(context.XoToolbarSchema), plain(schema()));
		for (const type of schema().tools) {
			const tool = context.XoUi.TOOLS[type];
			assert.ok(tool && tool.label, `${type} has a label`);
			assert.ok(context.XoUi.ICONS[tool.icon] || context.XoUi.FILLED[tool.icon], `${type} has an icon`);
		}
		for (const icon of schema().icons) assert.ok(context.XoUi.ICONS[icon], `the ${icon} icon exists`);
		assert.deepEqual(plain(context.XoDesigner.GRID), plain(schema().positions));
	});

	test("only known bundles are read", async () => {
		assert.deepEqual(Object.keys(BUNDLES), ["loader.js", "app.js", "designer.js"]);
		for (const name of ["../package.json", "ui.js", "__proto__", "constructor"]) {
			assert.equal(await readBundle(name), undefined, name);
		}
	});
});

function run(code) {
	const context = { window: {}, console };
	vm.createContext(context);
	vm.runInContext(code, context);
	return context;
}

/** Values from another vm context have other prototypes; compare them as JSON. */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}
