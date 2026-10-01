/*!
 * telescope's bridge: the one script galileo adds to each HTML page a source
 * serves. When telescope shows the page in its frame, the bridge tells it
 * where the page is (its address and title) whenever that changes, so the bar
 * and telescope's own address follow the page. Outside a frame it does
 * nothing.
 *
 * galileo lets only its own origins frame a source, so what the bridge posts
 * reaches telescope and nothing else. It never wraps the page's own functions:
 * it looks at the address a few times a second instead.
 *
 * Links to another origin, which the frame can't show, open in a tab of their
 * own; links to other sources on galileo stay in the frame.
 */
(function () {
	"use strict";
	if (window.parent === window || window.__galileo_bridge) return;
	window.__galileo_bridge = true;

	var LOOK_MS = 300;
	/** galileo's port and its sources' domain, from this page's own address: `acme.localhost:4100`. */
	var sourceHost = new RegExp("^[a-z0-9-]+\\.localhost" + (location.port ? ":" + location.port : "") + "$");
	var last = "";
	var leavingUntil = 0;

	function report(href) {
		var message = { galileo: "where", href: href || location.href, title: document.title };
		var key = message.href + "\n" + message.title;
		if (key === last) return;
		last = key;
		try {
			window.parent.postMessage(message, "*");
		} catch (error) {
			// The frame is going away: there is no one to tell.
		}
	}

	setInterval(function () {
		if (Date.now() > leavingUntil) report();
	}, LOOK_MS);
	addEventListener("popstate", function () {
		report();
	});
	addEventListener("hashchange", function () {
		report();
	});
	// A page restored from the back-forward cache says where it is again.
	addEventListener("pageshow", function (event) {
		if (!event.persisted) return;
		last = "";
		report();
	});

	addEventListener("click", function (event) {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
		if (!link || link.hasAttribute("download")) return;
		var target = (link.getAttribute("target") || "").toLowerCase();
		if (target && target !== "_self") return;
		var url;
		try {
			url = new URL(link.href, location.href);
		} catch (error) {
			return;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		if (url.origin === location.origin) {
			// It may lead to something that isn't a page, a file or an image, which
			// has no bridge to say where it is: say it now.
			leavingUntil = Date.now() + 3000;
			report(url.href);
			return;
		}
		if (url.protocol === "http:" && sourceHost.test(url.host)) return;
		event.preventDefault();
		window.open(url.href, "_blank", "noopener");
	});

	report();
})();
