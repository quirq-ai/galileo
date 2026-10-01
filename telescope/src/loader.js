/*!
 * telescope's loader: the script galileo carries into every page.
 *
 *   <script async data-xo-toolbar data-explicit-opt-in="true" data-preview-id="…"
 *           nonce="…" src="/__xo/toolbar/loader.js"></script>
 *
 * Modeled on Vercel's feedback.js. It reads its own tag, decides whether to
 * show, then builds telescope's shape:
 *
 *   <xo-toolbar>                     fixed, top-left, top of the z-order
 *     #shadow-root (closed)          the UI is drawn here, out of reach of page scripts and CSS
 *       <iframe hidden srcdoc>       runs app.js: same origin as the page, separate globals
 *
 * The app's JavaScript never shares globals with the page, yet it can read the
 * page's DOM and draw into the shadow root because the frame is same-origin.
 *
 * It also starts the page's log: errors, warnings, failed requests and blocked
 * resources from this point on, kept for bug reports and the agent. Requests
 * are read from the page's resource timings, so `fetch` is never wrapped.
 *
 * Pages can add their own buttons to the bar:
 *
 *   window.__xo_toolbar.addTool({ id: "flags", label: "Flags", icon: "flag",
 *     onClick: function (context) { context.toast("Hello"); } });
 *
 * It is safe to call before telescope has booted. `xo-toolbar:ready` fires
 * on `window` once it has.
 */
(function () {
	"use strict";

	var me = document.currentScript;
	if (!me || window.__xo_toolbar) return;

	var origin = new URL(me.src, location.href).origin;
	// The IDL property still returns the nonce after the browser hides the attribute.
	var nonce = me.nonce || me.getAttribute("nonce") || "";
	var config = {
		version: "0.2.0",
		previewId: me.getAttribute("data-preview-id") || "",
		project: me.getAttribute("data-project") || "",
		// Which version of the app this page came from, and every version the app has.
		appVersion: me.getAttribute("data-app-version") || "",
		appVersions: (me.getAttribute("data-app-versions") || "").split(",").filter(Boolean),
		api: origin + "/__xo/api",
		assets: origin + "/__xo/toolbar",
	};

	if (!shouldShow()) return;

	var logs = createLog(300);
	var host = null;
	var app = null;
	var pendingTools = [];

	window.__xo_toolbar = {
		version: config.version,
		unmount: unmount,
		/** Adds a button to the bar; returns a function that removes it again. */
		addTool: function (tool) {
			var id = tool && tool.id;
			if (app && app.addTool) app.addTool(tool);
			else pendingTools.push(tool);
			return function remove() {
				window.__xo_toolbar && window.__xo_toolbar.removeTool(id);
			};
		},
		removeTool: function (id) {
			pendingTools = pendingTools.filter(function (tool) {
				return !tool || tool.id !== id;
			});
			if (app && app.removeTool) app.removeTool(id);
		},
		/** A copy of the page's log, oldest first. */
		logs: function () {
			return logs.list();
		},
		/** A read-only snapshot of the toolbar's state, for tests and debugging. */
		debug: function () {
			return app && app.debug ? app.debug() : { booted: false };
		},
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", mount, { once: true });
	} else {
		mount();
	}

	/** Explicit opt-in (the gateway always sets it) or a local host; a `__xo_toolbar=0` cookie always wins. */
	function shouldShow() {
		if (/(?:^|;\s*)__xo_toolbar=0(?:;|$)/.test(document.cookie)) return false;
		if (me.getAttribute("data-explicit-opt-in") === "true") return true;
		var hostname = location.hostname;
		return hostname === "localhost" || hostname === "127.0.0.1" || /\.localhost$/.test(hostname);
	}

	function mount() {
		host = document.createElement("xo-toolbar");
		// CSSOM, not a style attribute, so a strict `style-src` doesn't block it.
		host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
		var root = host.attachShadow({ mode: "closed" });

		var frame = document.createElement("iframe");
		frame.hidden = true;
		frame.tabIndex = -1;
		frame.title = "telescope runtime";
		frame.setAttribute("aria-hidden", "true");
		// srcdoc documents inherit the page's origin and its CSP, so the app's
		// script needs the same nonce the loader was given (Vercel copies it too).
		frame.srcdoc =
			'<!doctype html><meta charset="utf-8"><script src="' +
			config.assets +
			'/app.js"' +
			(nonce ? ' nonce="' + nonce.replace(/"/g, "") + '"' : "") +
			"></script>";
		frame.addEventListener(
			"load",
			function () {
				boot(frame, root);
			},
			{ once: true },
		);
		root.appendChild(frame);
		// On <html>, after <body>: outside the part of the page frameworks hydrate.
		document.documentElement.appendChild(host);
	}

	function boot(frame, root) {
		var init = frame.contentWindow && frame.contentWindow.initXoToolbar;
		if (typeof init !== "function") {
			console.warn("[telescope] telescope did not load; the page's Content Security Policy may block it.");
			return;
		}
		app = init({ root: root, host: host, page: window, config: config, logs: logs, unmount: unmount });
		pendingTools.forEach(function (tool) {
			app.addTool(tool);
		});
		pendingTools = [];
		try {
			window.dispatchEvent(new CustomEvent("xo-toolbar:ready", { detail: { version: config.version } }));
		} catch (error) {
			// Nothing listens, or CustomEvent is missing: the tools queue still works.
		}
	}

	function unmount() {
		if (app && app.destroy) app.destroy();
		if (host) host.remove();
		logs.stop();
		host = null;
		app = null;
		delete window.__xo_toolbar;
	}

	// ------------------------------------------------------------------ log

	/**
	 * Errors, warnings and failed requests, newest last, at most `limit` of them.
	 * Console calls pass through unchanged after being noted.
	 */
	function createLog(limit) {
		var entries = [];
		var listeners = [];
		var undo = [];
		var nextId = 1;

		["error", "warn"].forEach(function (level) {
			var original = console[level];
			if (typeof original !== "function") return;
			var wrapped = function () {
				try {
					var error = firstError(arguments);
					add({ kind: "console", level: level, message: format(arguments), stack: error ? clip(error.stack, 2000) : undefined });
				} catch (ignored) {
					// Never let the log break the page's own logging.
				}
				return original.apply(this, arguments);
			};
			console[level] = wrapped;
			undo.push(function () {
				if (console[level] === wrapped) console[level] = original;
			});
		});

		on(window, "error", function (event) {
			var target = event.target;
			if (target && target !== window && target.nodeType === 1) {
				// A script, image, stylesheet or media element failed to load.
				var url = target.currentSrc || target.src || target.href || "";
				if (url) network(url, { level: "error", initiator: target.nodeName.toLowerCase(), failed: true });
				return;
			}
			add({
				kind: "error",
				level: "error",
				message: clip(event.message || "Script error", 2000),
				source: event.filename ? event.filename + ":" + event.lineno + ":" + event.colno : undefined,
				stack: event.error && event.error.stack ? clip(event.error.stack, 2000) : undefined,
			});
		}, true);
		on(window, "unhandledrejection", function (event) {
			var reason = event.reason;
			add({
				kind: "error",
				level: "error",
				message: "Unhandled rejection: " + describe(reason),
				stack: reason && reason.stack ? clip(String(reason.stack), 2000) : undefined,
			});
		});
		on(document, "securitypolicyviolation", function (event) {
			if (event.disposition === "report") return;
			add({
				kind: "csp",
				level: "warn",
				message: "Blocked by Content-Security-Policy (" + event.effectiveDirective + "): " + (event.blockedURI || "inline"),
				source: event.sourceFile ? event.sourceFile + ":" + event.lineNumber : undefined,
			});
		});

		// Failed requests, from the page's own resource timings, including those
		// made before the toolbar loaded.
		if (typeof PerformanceObserver === "function") {
			try {
				var observer = new PerformanceObserver(function (list) {
					list.getEntries().forEach(noteTiming);
				});
				observer.observe({ type: "resource", buffered: true });
				undo.push(function () {
					observer.disconnect();
				});
			} catch (ignored) {
				// Older browsers without buffered observers: no request log.
			}
			try {
				performance.getEntriesByType("navigation").forEach(noteTiming);
			} catch (ignored) {
				// No navigation timing: nothing to note.
			}
		}

		function noteTiming(entry) {
			var status = entry.responseStatus;
			if (!(status >= 400)) return;
			if (entry.name.indexOf(origin + "/__xo/") === 0) return;
			// The browser's own favicon request is not the page's doing.
			if (entry.initiatorType === "other" && /\/favicon\.ico(?:\?|$)/.test(entry.name)) return;
			network(entry.name, {
				level: status >= 500 ? "error" : "warn",
				status: status,
				initiator: entry.entryType === "navigation" ? "document" : entry.initiatorType,
				duration: Math.round(entry.duration),
			});
		}

		/** A failed request is often reported twice (timing and error event); the two are merged. */
		function network(url, fields) {
			var now = Date.now();
			for (var i = entries.length - 1; i >= 0 && now - entries[i].time < 5000; i--) {
				var existing = entries[i];
				if (existing.kind === "network" && existing.url === url) {
					Object.keys(fields).forEach(function (key) {
						if (existing[key] === undefined) existing[key] = fields[key];
					});
					existing.message = networkMessage(existing);
					notify(existing);
					return;
				}
			}
			var entry = { kind: "network", url: url };
			Object.keys(fields).forEach(function (key) {
				entry[key] = fields[key];
			});
			entry.message = networkMessage(entry);
			add(entry);
		}

		function networkMessage(entry) {
			var what = entry.status ? String(entry.status) : "Failed";
			return what + " " + (entry.initiator ? entry.initiator + " " : "") + shortUrl(entry.url);
		}

		function add(entry) {
			entry.id = nextId++;
			entry.time = Date.now();
			entries.push(entry);
			if (entries.length > limit) entries.shift();
			notify(entry);
		}

		function notify(entry) {
			listeners.slice().forEach(function (listener) {
				try {
					listener(entry);
				} catch (ignored) {
					// A broken listener must not stop the others.
				}
			});
		}

		function on(target, type, handler, capture) {
			target.addEventListener(type, handler, capture);
			undo.push(function () {
				target.removeEventListener(type, handler, capture);
			});
		}

		return {
			list: function () {
				return entries.map(function (entry) {
					return Object.assign({}, entry);
				});
			},
			subscribe: function (listener) {
				listeners.push(listener);
				return function () {
					listeners = listeners.filter(function (item) {
						return item !== listener;
					});
				};
			},
			clear: function () {
				entries = [];
				notify(null);
			},
			stop: function () {
				undo.forEach(function (step) {
					step();
				});
				undo = [];
				listeners = [];
			},
		};
	}

	/** Console arguments as one line of text, with `%s`-style substitutions applied, as React logs them. */
	function format(args) {
		var parts = Array.prototype.slice.call(args);
		var out = [];
		if (typeof parts[0] === "string" && /%[sdifoOc]/.test(parts[0])) {
			var template = parts.shift();
			out.push(template.replace(/%([sdifoOc%])/g, function (match, type) {
				if (type === "%") return "%";
				if (!parts.length) return match;
				var value = parts.shift();
				if (type === "c") return "";
				if (type === "d" || type === "i") return String(parseInt(value, 10));
				if (type === "f") return String(parseFloat(value));
				return describe(value);
			}));
		}
		parts.forEach(function (value) {
			out.push(describe(value));
		});
		return clip(out.join(" "), 2000);
	}

	function describe(value) {
		if (typeof value === "string") return value;
		if (value === undefined) return "undefined";
		if (value === null) return "null";
		if (typeof value === "function") return "ƒ " + (value.name || "anonymous") + "()";
		if (typeof value !== "object") return String(value);
		if (typeof value.message === "string" && typeof value.stack === "string") return (value.name || "Error") + ": " + value.message;
		if (value.nodeType === 1) return "<" + value.nodeName.toLowerCase() + (value.id ? "#" + value.id : "") + ">";
		try {
			var seen = [];
			return clip(JSON.stringify(value, function (key, item) {
				if (typeof item === "object" && item !== null) {
					if (seen.indexOf(item) >= 0) return "[circular]";
					seen.push(item);
				}
				return typeof item === "function" ? "ƒ" : item;
			}), 500);
		} catch (error) {
			return Object.prototype.toString.call(value);
		}
	}

	function firstError(args) {
		for (var i = 0; i < args.length; i++) {
			var value = args[i];
			if (value && typeof value === "object" && typeof value.stack === "string") return value;
		}
		return null;
	}

	function shortUrl(url) {
		try {
			var parsed = new URL(url, location.href);
			return parsed.origin === location.origin ? parsed.pathname + parsed.search : parsed.href;
		} catch (error) {
			return String(url);
		}
	}

	function clip(text, max) {
		text = String(text == null ? "" : text);
		return text.length > max ? text.slice(0, max) + "…" : text;
	}
})();
