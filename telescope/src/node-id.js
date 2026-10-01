/*!
 * Element anchors for comments and agent requests.
 *
 * `build` describes an element the way Vercel's toolbar does: up to four CSS
 * selectors joined by commas (stopping at the nearest id or walking to the
 * root, with or without the first class, adding :nth-of-type only where a tag
 * repeats). XO adds one more, from a stable test attribute (`data-testid`) on
 * the element or its nearest ancestor, and keeps only the variants that point
 * at this exact element today.
 *
 * `resolve` tries the variants one at a time, most stable first, then falls
 * back to the element's text, so a comment survives most edits an agent makes.
 */
var XoNodeId = (function () {
	"use strict";

	var STABLE_ATTRIBUTES = ["data-testid", "data-test", "data-cy"];

	function escapeIdentifier(value) {
		return String(value).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
	}

	function idSelector(id) {
		return /^[0-9]/.test(id) ? "[id=" + JSON.stringify(id) + "]" : "#" + escapeIdentifier(id);
	}

	/** One step of a path: the tag, maybe its first class, and :nth-of-type when the tag repeats before it. */
	function step(element, includeClasses) {
		var tag = element.nodeName.toLowerCase();
		var firstClass = includeClasses && element.classList.length ? element.classList.item(0) : null;
		var part = firstClass ? tag + "." + escapeIdentifier(firstClass) : tag;
		var position = 1;
		var classIsUnique = Boolean(firstClass);
		for (var sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
			if (sibling.nodeName === element.nodeName) position += 1;
			if (firstClass && sibling.classList.contains(firstClass)) classIsUnique = false;
		}
		if (position !== 1 && !classIsUnique) part += ":nth-of-type(" + position + ")";
		return part;
	}

	function path(element, options) {
		var parts = [];
		for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
			if (node.id) {
				parts.unshift(idSelector(node.id));
				if (!options.proceedAfterId) break;
				continue;
			}
			if (node.nodeName.toLowerCase() === "html") {
				if (!parts.length) parts.push("html");
				break;
			}
			parts.unshift(step(node, options.includeClasses));
		}
		return parts.join(">");
	}

	/** The element or its nearest ancestor with a test attribute, then the path down from it. */
	function stablePath(element) {
		var below = [];
		for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
			for (var i = 0; i < STABLE_ATTRIBUTES.length; i++) {
				var value = node.getAttribute(STABLE_ATTRIBUTES[i]);
				if (value) {
					below.unshift("[" + STABLE_ATTRIBUTES[i] + "=" + JSON.stringify(value) + "]");
					return below.join(">");
				}
			}
			below.unshift(step(node, false));
		}
		return "";
	}

	function build(element) {
		if (!element || element.nodeType !== 1) return "";
		var doc = element.ownerDocument;
		var candidates = [
			stablePath(element),
			path(element, { proceedAfterId: false, includeClasses: false }),
			path(element, { proceedAfterId: true, includeClasses: false }),
			path(element, { proceedAfterId: false, includeClasses: true }),
			path(element, { proceedAfterId: true, includeClasses: true }),
		];
		var seen = {};
		var exact = [];
		var valid = [];
		for (var i = 0; i < candidates.length; i++) {
			var selector = candidates[i];
			if (!selector || seen[selector]) continue;
			seen[selector] = true;
			var found;
			try {
				found = doc.querySelector(selector);
			} catch (error) {
				continue;
			}
			valid.push(selector);
			if (found === element) exact.push(selector);
		}
		return (exact.length ? exact : valid).join(",");
	}

	/** Splits a selector list on its top-level commas, respecting quotes, brackets and escapes. */
	function split(list) {
		var out = [];
		var current = "";
		var quote = "";
		var depth = 0;
		var text = String(list || "");
		for (var i = 0; i < text.length; i++) {
			var ch = text[i];
			if (ch === "\\") {
				current += ch + (text[i + 1] || "");
				i += 1;
				continue;
			}
			if (quote) {
				if (ch === quote) quote = "";
				current += ch;
				continue;
			}
			if (ch === '"' || ch === "'") quote = ch;
			else if (ch === "[" || ch === "(") depth += 1;
			else if (ch === "]" || ch === ")") depth -= 1;
			else if (ch === "," && depth === 0) {
				if (current) out.push(current);
				current = "";
				continue;
			}
			current += ch;
		}
		if (current) out.push(current);
		return out;
	}

	function normalize(value) {
		return String(value || "").replace(/\s+/g, " ").trim();
	}

	function textQuote(element) {
		return normalize(element.textContent).slice(0, 80);
	}

	/** The element a stored anchor points at today, and how it was found; `null` when it is gone. */
	function resolve(nodeId, doc, anchor) {
		var selectors = split(nodeId);
		for (var i = 0; i < selectors.length; i++) {
			try {
				var found = doc.querySelector(selectors[i]);
				if (found) return { element: found, by: i === 0 ? "selector" : "fallback selector", selector: selectors[i] };
			} catch (error) {
				// A selector that no longer parses is skipped, like any other miss.
			}
		}
		if (anchor && anchor.textQuote) {
			var tag = anchor.tag && /^[a-z][a-z0-9-]*$/.test(anchor.tag) ? anchor.tag : "*";
			var best = null;
			var bestLength = Infinity;
			var nodes = doc.querySelectorAll(tag);
			for (var j = 0; j < nodes.length; j++) {
				var content = normalize(nodes[j].textContent);
				if (content.indexOf(anchor.textQuote) === 0 && content.length < bestLength) {
					best = nodes[j];
					bestLength = content.length;
				}
			}
			if (best) return { element: best, by: "text", selector: "" };
		}
		return null;
	}

	return { build: build, resolve: resolve, split: split, textQuote: textQuote, normalize: normalize };
})();
