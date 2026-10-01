/**
 * The pure rules of a files source: which request paths are refused before
 * the disk is touched, which real paths are inside a source, and how a file
 * says what it is. Serving is tested end to end in galileo.test.mjs. `npm test`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { escapeHtml, insideSource, looksLikeText, pathSegments, typeOf } from "../src/files.mjs";

describe("request paths", () => {
	test("are decoded into the names they walk through", () => {
		assert.deepEqual(pathSegments("/"), []);
		assert.deepEqual(pathSegments("/docs/plan%20v2.md"), ["docs", "plan v2.md"]);
		assert.deepEqual(pathSegments("//a///b/"), ["a", "b"]);
	});

	test("are refused when they reach a hidden name, climb out, or hold a backslash or NUL", () => {
		for (const pathname of ["/.env", "/a/.git/config", "/..", "/a/%2e%2e/b", "/a%2f..%2fb", "/a%5cb", "/a%00b", "/%zz"]) {
			assert.equal(pathSegments(pathname), null, pathname);
		}
	});
});

describe("what is inside a source", () => {
	test("anything below its root, whatever the root is, the disk's own included", () => {
		assert.equal(insideSource("/a/site", "/a/site"), true);
		assert.equal(insideSource("/a/site", "/a/site/sub/x.md"), true);
		assert.equal(insideSource("/", "/etc/hosts"), true);
	});

	test("never a place outside it, or a hidden name a link leads to", () => {
		assert.equal(insideSource("/a/site", "/a/outside.txt"), false);
		assert.equal(insideSource("/a/site", "/a/site-other/x"), false);
		assert.equal(insideSource("/a/site", "/a/site/.env"), false);
		assert.equal(insideSource("/a/site", "/a/site/.git/config"), false);
		assert.equal(insideSource("/a/site", "/a/site/sub/.secret/x"), false);
	});
});

describe("what a file is", () => {
	test("its type comes from its extension", () => {
		assert.equal(typeOf("a/b/page.HTML"), "text/html; charset=utf-8");
		assert.equal(typeOf("clip.webm"), "video/webm");
		assert.equal(typeOf("notes.md"), undefined);
	});

	test("a file with no type is text when it holds no NUL byte", () => {
		assert.equal(looksLikeText(Buffer.from("all:\n\techo hi\n")), true);
		assert.equal(looksLikeText(Buffer.from([1, 0, 2])), false);
	});

	test("text shown in a page is escaped", () => {
		assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
	});
});
