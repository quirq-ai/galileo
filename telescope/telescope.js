/*!
 * telescope: galileo's bar along the top, and the router for the view under it.
 *
 * galileo serves one page, and telescope runs all of it. It owns the address:
 *
 *   /sources               the Sources page: add, open and remove sources
 *   /s/<name>/<path>       the source <name> at <path>, in a frame under the bar
 *
 * A source runs on its own origin (`<name>.localhost:4100`), so telescope
 * can't look inside the frame. Each HTML page a source serves loads
 * telescope's bridge instead, which posts the page's address whenever it
 * changes. telescope then keeps the bar, the tab's title and its own address
 * in step, replacing its history entry rather than adding one, since the
 * frame's own navigation already added one.
 *
 * Everything is built with text nodes; no source's text is ever parsed as HTML.
 */
(function () {
	"use strict";

	var STATUS_MS = 5000;
	/**
	 * What a framed source may use. A browser asks for and keeps a delegated
	 * permission for galileo's own origin, so granting the camera to one source
	 * would grant it to all of them: a source that needs more opens on its own.
	 */
	var FRAME_ALLOW = "fullscreen; clipboard-write";
	/** How long telescope waits to hear from the source it just sent the frame to before it listens to anyone again. */
	var EXPECT_MS = 10000;
	/** galileo's port as an address carries it: `:4100`, or nothing on port 80. */
	var portPart = location.port ? ":" + location.port : "";
	var SOURCE_ORIGIN = new RegExp("^http://([a-z0-9-]+)\\.localhost" + portPart + "$");

	var view = byId("view");
	var sourcesPage = byId("sources-page");
	var switcher = byId("switcher");
	var switcherName = byId("switcher-name");
	var switcherDot = byId("switcher-dot");
	var menu = byId("menu");
	var pathForm = byId("path-form");
	var pathInput = byId("path");
	var reloadButton = byId("reload");
	var openLink = byId("open");
	var sourcesLink = document.querySelector(".sources-link");
	var addForm = byId("add");
	var addName = byId("add-name");
	var addLocation = byId("add-location");
	var addButton = byId("add-button");
	var addError = byId("add-error");
	var portsList = byId("ports");
	var filesList = byId("files");

	var state = {
		/** The sources, as the API last described them; `null` until it has, and the same as text, to tell a change. */
		sources: null,
		sourcesText: "",
		route: { page: "sources" },
		/** The one frame every source is shown in, which source it shows, and where, as its bridge last said. */
		frame: null,
		frameName: null,
		framePath: null,
		title: "",
		/** `{ name, until }`: the source telescope just sent the frame to, while the page it left may still speak. */
		expecting: null,
		missing: null,
		statusTimer: 0,
	};

	// ------------------------------------------------------------------ routes

	/** Which view an address means. */
	function parseRoute(url) {
		var pathname = url.pathname;
		if (pathname === "/" || pathname === "/sources" || pathname === "/sources/") return { page: "sources" };
		var match = /^\/s\/([a-z0-9-]+)(\/.*)?$/.exec(pathname);
		if (match) return { page: "source", name: match[1], path: (match[2] || "/") + url.search + url.hash };
		return { page: "missing" };
	}

	/** The address of a view on galileo's host. */
	function routeHref(route) {
		if (route.page === "source") return "/s/" + route.name + route.path;
		return "/sources";
	}

	/** Where a source shows a path, on its own address. */
	function sourceHref(name, path) {
		return "http://" + name + ".localhost" + portPart + path;
	}

	function currentHref() {
		return location.pathname + location.search + location.hash;
	}

	/** Goes to a view, adding a history entry unless `replace` is set. */
	function navigate(route, replace) {
		var href = routeHref(route);
		if (href !== currentHref()) history[replace ? "replaceState" : "pushState"](null, "", href);
		show(route);
	}

	function show(route) {
		state.route = route;
		closeMenu();
		removeMissing();
		if (route.page === "source") showSource(route.name, route.path);
		else if (route.page === "sources") showSources();
		else showMissing();
		renderBar();
	}

	/**
	 * Shows a source at a path, in the one frame every source is shown in.
	 * The frame is sent there in place of its current page, adding no history
	 * entry of its own: telescope's own entry is the step. A frame that was
	 * thrown away would leave its steps in the tab's history, each a Back press
	 * that does nothing.
	 */
	function showSource(name, path) {
		sourcesPage.hidden = true;
		stopStatus();
		var first = !state.frame;
		if (first) {
			state.frame = document.createElement("iframe");
			state.frame.className = "frame";
			state.frame.setAttribute("allow", FRAME_ALLOW);
			view.appendChild(state.frame);
		}
		state.frame.hidden = false;
		state.frame.title = name;
		if (!first && name === state.frameName && path === state.framePath) return;
		if (name !== state.frameName) state.title = "";
		state.frameName = name;
		sendFrame(path, first);
	}

	/** Sends the frame to a path of its current source, in place of the page it shows. */
	function sendFrame(path, first) {
		var href = sourceHref(state.frameName, path);
		state.framePath = path;
		state.expecting = { name: state.frameName, until: Date.now() + EXPECT_MS };
		if (first) {
			// A new frame's first page takes no history entry.
			state.frame.src = href;
			return;
		}
		try {
			state.frame.contentWindow.location.replace(href);
		} catch (error) {
			state.frame.src = href;
		}
	}

	function showSources() {
		if (state.frame) state.frame.hidden = true;
		sourcesPage.hidden = false;
		loadSources();
		startStatus();
	}

	function showMissing() {
		if (state.frame) state.frame.hidden = true;
		sourcesPage.hidden = true;
		stopStatus();
		var link = el("a", { href: "/sources", "data-route": "" }, "Go to the Sources page");
		state.missing = el("div", { class: "missing" }, el("strong", {}, "Nothing here"), el("span", {}, "galileo shows sources at /s/<name>/."), link);
		view.appendChild(state.missing);
	}

	function removeMissing() {
		if (state.missing) state.missing.remove();
		state.missing = null;
	}

	// ------------------------------------------------------------------ the bridge

	/** A page in the frame says where it is: follow it, without a history entry of our own. */
	window.addEventListener("message", function (event) {
		var frame = state.frame;
		if (!frame || event.source !== frame.contentWindow) return;
		var data = event.data;
		if (!data || data.galileo !== "where" || typeof data.href !== "string") return;
		var match = SOURCE_ORIGIN.exec(event.origin);
		if (!match) return;
		var url;
		try {
			url = new URL(data.href);
		} catch (error) {
			return;
		}
		if (url.origin !== event.origin) return;
		// Just after telescope sends the frame to another source, the page it is
		// leaving may still speak: wait to hear from the one it was sent to.
		var expecting = state.expecting;
		if (expecting && match[1] !== expecting.name && Date.now() < expecting.until) return;
		state.expecting = null;
		// A link in one source may lead to another: the frame then shows that one.
		state.frameName = match[1];
		state.framePath = url.pathname + url.search + url.hash;
		state.title = typeof data.title === "string" ? data.title.slice(0, 200) : "";
		frame.title = state.frameName;
		if (state.route.page !== "source") return;
		state.route = { page: "source", name: state.frameName, path: state.framePath };
		var href = routeHref(state.route);
		if (href !== currentHref()) history.replaceState(null, "", href);
		renderBar();
	});

	window.addEventListener("popstate", function () {
		show(parseRoute(location));
	});

	// ------------------------------------------------------------------ the bar

	function renderBar() {
		var route = state.route;
		var onSource = route.page === "source";
		var source = onSource ? findSource(route.name) : null;
		var path = onSource ? state.framePath || route.path : "";
		switcher.disabled = state.sources === null;
		switcherName.textContent = onSource ? route.name : "Sources";
		switcherDot.className = "dot " + (source ? (source.up ? "up" : "down") : "none");
		if (document.activeElement !== pathInput) pathInput.value = path;
		pathInput.disabled = !onSource;
		pathInput.placeholder = onSource ? "/" : "Pick a source";
		reloadButton.disabled = !onSource;
		if (onSource) {
			openLink.href = sourceHref(route.name, path);
			openLink.removeAttribute("aria-disabled");
		} else {
			openLink.removeAttribute("href");
			openLink.setAttribute("aria-disabled", "true");
		}
		if (route.page === "sources") sourcesLink.setAttribute("aria-current", "page");
		else sourcesLink.removeAttribute("aria-current");
		document.title = onSource
			? [state.title === route.name ? "" : state.title, route.name, "galileo"].filter(Boolean).join(" · ")
			: route.page === "sources"
				? "Sources · galileo"
				: "galileo";
	}

	/** A path typed in the bar: on this source, or a whole address of another source. */
	pathForm.addEventListener("submit", function (event) {
		event.preventDefault();
		if (state.route.page !== "source") return;
		var route = typedRoute(pathInput.value, state.route.name);
		pathInput.blur();
		if (route) navigate(route);
		else renderBar();
	});

	pathInput.addEventListener("keydown", function (event) {
		if (event.key !== "Escape") return;
		pathInput.blur();
		renderBar();
	});

	pathInput.addEventListener("focus", function () {
		pathInput.select();
	});

	pathInput.addEventListener("blur", function () {
		renderBar();
	});

	function typedRoute(value, name) {
		var text = String(value || "").trim();
		if (!text) return { page: "source", name: name, path: "/" };
		// An address typed without its scheme: acme.localhost:4100/about.
		if (/^(?:[a-z0-9-]+\.)?localhost(?::\d+)?(?:[/?#]|$)/i.test(text)) text = "http://" + text;
		if (/^[a-z][a-z\d+.-]*:/i.test(text)) {
			// A whole address: a source's own, or one of galileo's; nothing else is shown here.
			try {
				var url = new URL(text);
				var match = SOURCE_ORIGIN.exec(url.origin);
				if (match) return { page: "source", name: match[1], path: url.pathname + url.search + url.hash };
				if (url.origin === location.origin) return parseRoute(url);
			} catch (error) {
				// Not an address after all.
			}
			return null;
		}
		return { page: "source", name: name, path: text.charAt(0) === "/" ? text : "/" + text };
	}

	reloadButton.addEventListener("click", function () {
		if (state.frame && state.route.page === "source") sendFrame(state.framePath || state.route.path);
	});

	switcher.addEventListener("click", function () {
		if (menu.hidden) openMenu();
		else closeMenu();
	});

	function openMenu() {
		menu.hidden = false;
		switcher.setAttribute("aria-expanded", "true");
		menu.style.left = switcher.offsetLeft + "px";
		renderMenu();
		loadSources();
		var first = menu.querySelector(".menu-item");
		if (first) first.focus();
	}

	function closeMenu() {
		if (menu.hidden) return;
		menu.hidden = true;
		switcher.setAttribute("aria-expanded", "false");
	}

	/** Every source, by kind: one click shows it under the bar. */
	function renderMenu() {
		var sources = state.sources || [];
		var children = [];
		[
			["port", "Ports"],
			["files", "Files"],
		].forEach(function (kind) {
			var group = sources.filter(function (source) {
				return source.type === kind[0];
			});
			if (!group.length) return;
			children.push(el("p", { class: "menu-title" }, kind[1]));
			group.forEach(function (source) {
				var item = el(
					"button",
					{ class: "menu-item", type: "button", role: "menuitem", "data-key": "menu:" + source.name },
					el("span", { class: "dot " + statusClass(source), "aria-hidden": "true" }),
					el("span", { class: "menu-name" }, source.name),
					el("span", { class: "menu-detail" }, detail(source)),
				);
				if (state.route.page === "source" && state.route.name === source.name) item.setAttribute("aria-current", "true");
				item.addEventListener("click", function () {
					navigate({ page: "source", name: source.name, path: "/" });
				});
				children.push(item);
			});
		});
		if (!children.length) children.push(el("p", { class: "menu-note" }, state.sources ? "No sources yet." : "Loading sources…"));
		children.push(el("div", { class: "menu-footer" }, el("a", { class: "menu-item", href: "/sources", "data-route": "", role: "menuitem", "data-key": "menu:sources" }, "Add or remove sources")));
		menu.replaceChildren.apply(menu, children);
	}

	menu.addEventListener("keydown", function (event) {
		var items = Array.prototype.slice.call(menu.querySelectorAll(".menu-item"));
		var index = items.indexOf(document.activeElement);
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			var next = items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
			if (next) next.focus();
		}
	});

	document.addEventListener("keydown", function (event) {
		if (event.key === "Escape" && !menu.hidden) {
			closeMenu();
			switcher.focus();
		}
	});

	document.addEventListener("click", function (event) {
		if (!menu.hidden && !menu.contains(event.target) && !switcher.contains(event.target)) closeMenu();
	});

	/** Links marked `data-route` change the view here instead of loading a page. */
	document.addEventListener("click", function (event) {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		var link = event.target.closest ? event.target.closest("a[data-route]") : null;
		if (!link) return;
		event.preventDefault();
		navigate(parseRoute(new URL(link.href)));
	});

	// ------------------------------------------------------------------ sources

	/** Reads the sources; the lists are drawn again only when something changed, and keep the focused control. */
	function loadSources() {
		return api("GET", "/sources").then(
			function (data) {
				var sources = data.sources || [];
				var text = JSON.stringify(sources);
				var changed = state.sources === null || text !== state.sourcesText;
				state.sources = sources;
				state.sourcesText = text;
				if (changed) {
					keepFocus(function () {
						renderSources();
						if (!menu.hidden) renderMenu();
					});
				}
				renderBar();
			},
			function (error) {
				showError("Couldn't read the sources: " + error.message);
			},
		);
	}

	/** The Sources page keeps each source's state current while it is shown. */
	function startStatus() {
		stopStatus();
		state.statusTimer = setInterval(function () {
			if (document.visibilityState === "visible") loadSources();
		}, STATUS_MS);
	}

	function stopStatus() {
		clearInterval(state.statusTimer);
		state.statusTimer = 0;
	}

	document.addEventListener("visibilitychange", function () {
		if (document.visibilityState === "visible" && state.route.page === "sources") loadSources();
	});

	function renderSources() {
		var sources = state.sources || [];
		fillList(
			portsList,
			sources.filter(function (source) {
				return source.type === "port";
			}),
			"No ports yet. Add one by its number, such as 5173.",
		);
		fillList(
			filesList,
			sources.filter(function (source) {
				return source.type === "files";
			}),
			"No files yet. Add a file or a folder by its path, such as ~/notes.",
		);
	}

	function fillList(list, sources, emptyText) {
		var rows = sources.length ? sources.map(sourceRow) : [el("li", { class: "empty" }, emptyText)];
		list.replaceChildren.apply(list, rows);
	}

	function sourceRow(source) {
		var href = "/s/" + source.name + "/";
		var remove = el("button", { type: "button", "aria-label": "Remove " + source.name, "data-key": "remove:" + source.name }, "Remove");
		remove.addEventListener("click", function () {
			remove.disabled = true;
			api("DELETE", "/sources/" + source.name).then(loadSources, function (error) {
				remove.disabled = false;
				showError(error.message);
			});
		});
		return el(
			"li",
			{ class: "item" },
			el("span", { class: "dot " + statusClass(source), "aria-hidden": "true" }),
			el("a", { class: "item-name", href: href, "data-route": "", "data-key": "name:" + source.name }, source.name),
			el("span", { class: "item-detail", title: detail(source) }, detail(source)),
			el("span", { class: "item-state" }, stateText(source)),
			el("span", { class: "item-actions" }, el("a", { href: href, "data-route": "", "data-key": "open:" + source.name }, "Open"), remove),
		);
	}

	addLocation.addEventListener("input", function () {
		if (!addName.dataset.touched) addName.value = suggestName(addLocation.value);
	});

	addName.addEventListener("input", function () {
		addName.dataset.touched = addName.value ? "yes" : "";
	});

	addForm.addEventListener("submit", function (event) {
		event.preventDefault();
		var name = addName.value.trim().toLowerCase();
		var where = addLocation.value.trim();
		if (!where) return showError("Give a port, such as 5173, or a path, such as ~/notes.", addLocation);
		if (!name) return showError("Give the source a name, such as web.", addName);
		addError.hidden = true;
		addButton.disabled = true;
		api("POST", "/sources", { name: name, location: where })
			.then(function () {
				addForm.reset();
				addName.dataset.touched = "";
				return loadSources();
			})
			.catch(function (error) {
				showError(error.message);
			})
			.finally(function () {
				addButton.disabled = false;
			});
	});

	/** A name from a path: its last part, as an address can carry it. Ports are left for you to name. */
	function suggestName(value) {
		var text = String(value || "").trim();
		if (!text || /^\d+$/.test(text) || /:\d+\/?$/.test(text)) return "";
		var last = text.replace(/\/+$/, "").split("/").pop() || "";
		return last
			.replace(/\.[^.]*$/, "")
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/, "");
	}

	function showError(message, field) {
		addError.textContent = message;
		addError.hidden = false;
		if (field) field.focus();
	}

	function findSource(name) {
		return (state.sources || []).filter(function (source) {
			return source.name === name;
		})[0];
	}

	function detail(source) {
		return source.type === "port" ? "localhost:" + source.port : source.path;
	}

	function stateText(source) {
		if (source.type === "port") return source.up ? "answering" : "not answering";
		return source.kind || "missing";
	}

	function statusClass(source) {
		return source.up ? "up" : "down";
	}

	// ------------------------------------------------------------------ helpers

	function api(method, path, body) {
		return fetch("/__xo/api" + path, {
			method: method,
			cache: "no-store",
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		}).then(function (response) {
			return response
				.json()
				.catch(function () {
					return {};
				})
				.then(function (data) {
					if (!response.ok) throw new Error(data.error || "galileo answered " + response.status);
					return data;
				});
		});
	}

	function el(tag, attributes) {
		var node = document.createElement(tag);
		Object.keys(attributes || {}).forEach(function (name) {
			node.setAttribute(name, attributes[name]);
		});
		for (var i = 2; i < arguments.length; i++) {
			var child = arguments[i];
			if (child === null || child === undefined) continue;
			node.append(child instanceof Node ? child : document.createTextNode(String(child)));
		}
		return node;
	}

	function byId(id) {
		return document.getElementById(id);
	}

	/** Draws again, then puts the focus back on the control with the same `data-key`, if it is still there. */
	function keepFocus(draw) {
		var key = document.activeElement && document.activeElement.getAttribute("data-key");
		draw();
		if (!key) return;
		var again = document.querySelector('[data-key="' + CSS.escape(key) + '"]');
		if (again) again.focus();
	}

	// ------------------------------------------------------------------ start

	var first = parseRoute(location);
	if (location.pathname === "/") navigate(first, true);
	else show(first);
	if (state.route.page !== "sources") loadSources();
})();
