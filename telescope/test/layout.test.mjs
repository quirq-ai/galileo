/**
 * The toolbar design schema: whatever the designer, a hand-edited file or a
 * page sends, the gateway keeps a valid design. `npm test`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BUILT_IN_TOOLS, DEFAULT_LAYOUT, MAX_ITEMS, defaultLayout, normalizeLayout } from "../layout.mjs";

describe("toolbar designs", () => {
	test("anything that isn't a design becomes the default one", () => {
		for (const input of [undefined, null, "bar", 3, [], {}]) {
			assert.deepEqual(normalizeLayout(input), defaultLayout());
		}
	});

	test("the default design carries every built-in tool, capture tools included", () => {
		const types = DEFAULT_LAYOUT.items.map((item) => item.type).filter((type) => type !== "separator");
		assert.deepEqual([...types].sort(), [...BUILT_IN_TOOLS].sort());
		assert.throws(() => {
			DEFAULT_LAYOUT.dock = {};
		}, "the shared default can't be changed by accident");
	});

	test("dock, labels, start-open and accent are kept when valid and defaulted when not", () => {
		const kept = normalizeLayout({ dock: { position: "top-right", labels: false, startOpen: false }, theme: { accent: "#FF8A3D" }, items: [] });
		assert.deepEqual(kept.dock, { position: "top-right", labels: false, startOpen: false });
		assert.equal(kept.theme.accent, "#ff8a3d");
		assert.deepEqual(kept.items, []);

		const fixed = normalizeLayout({ dock: { position: "middle", labels: "yes" }, theme: { accent: "red" } });
		assert.deepEqual(fixed.dock, DEFAULT_LAYOUT.dock);
		assert.equal(fixed.theme.accent, DEFAULT_LAYOUT.theme.accent);
	});

	test("built-in tools appear once, unknown tools are dropped, separators only sit between tools", () => {
		const layout = normalizeLayout({
			items: [
				{ type: "separator" },
				{ type: "inspect" },
				{ type: "separator" },
				{ type: "separator" },
				{ type: "screenshot" },
				{ type: "inspect" },
				{ type: "teleport" },
				"record",
				{ type: "logs" },
				{ type: "separator" },
			],
		});
		assert.deepEqual(layout.items, [{ type: "inspect" }, { type: "separator" }, { type: "screenshot" }, { type: "logs" }]);
	});

	test("links need a label and an http(s) address; prompts need text and get a scope", () => {
		const layout = normalizeLayout({
			items: [
				{ type: "link", label: "  Storybook  ", icon: "book", href: "http://localhost:6006" },
				{ type: "link", label: "Evil", href: "javascript:alert(1)" },
				{ type: "link", label: "", href: "https://example.com" },
				{ type: "prompt", label: "Polish", icon: "not-an-icon", prompt: "Tighten the spacing", scope: "everything" },
				{ type: "prompt", label: "Empty", prompt: "   " },
				{ type: "prompt", label: "Audit", prompt: "Check contrast on this page", scope: "page" },
			],
		});
		assert.deepEqual(layout.items, [
			{ type: "link", id: "storybook", label: "Storybook", icon: "book", href: "http://localhost:6006/" },
			{ type: "prompt", id: "polish", label: "Polish", icon: "sparkles", prompt: "Tighten the spacing", scope: "element" },
			{ type: "prompt", id: "audit", label: "Audit", icon: "sparkles", prompt: "Check contrast on this page", scope: "page" },
		]);
	});

	test("custom tools get unique ids, and text is trimmed to size", () => {
		const layout = normalizeLayout({
			items: [
				{ type: "prompt", label: "Fix", prompt: "a" },
				{ type: "prompt", label: "Fix", prompt: "b" },
				{ type: "prompt", id: "fix", label: "x".repeat(60), prompt: "y".repeat(2000) },
			],
		});
		assert.deepEqual(layout.items.map((item) => item.id), ["fix", "fix-2", "fix-3"]);
		assert.equal(layout.items[2].label.length, 24);
		assert.equal(layout.items[2].prompt.length, 1000);
	});

	test("a design holds a bounded number of items", () => {
		const items = Array.from({ length: 60 }, (_, index) => ({ type: "link", label: `Link ${index}`, href: `http://localhost/${index}` }));
		assert.equal(normalizeLayout({ items }).items.length, MAX_ITEMS);
	});
});
