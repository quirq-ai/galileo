/*!
 * telescope's designer: the editor for a telescope design.
 *
 * telescope shows it in its Customize panel, and a host can mount it on its
 * own settings page, as galileo's launcher does. It edits a copy of the
 * design and hands every change to the host at once (`commit`); the host
 * applies and saves it, then reports back through `setLayout` and
 * `setStatus`. Undo steps back through this editor's changes.
 *
 * `XoDesigner.preview` draws a still picture of a design (a page with the bar
 * where it docks), for hosts that edit a design away from the app it belongs to.
 */
var XoDesigner = (function () {
	"use strict";

	/** The dock picker's order: the top row, then the bottom row. */
	var GRID = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];
	var ACCENTS = ["#83d63a", "#4096ff", "#9b6dff", "#ff8a3d", "#ff5fa2", "#2dd4bf", "#f2f2f2"];
	var KINDS = { link: "Link", prompt: "Agent prompt" };
	var PREVIEW_WIDTH = 1280;
	var PREVIEW_HEIGHT = 800;

	var STYLES = [
		".designer { display: flex; flex-direction: column; flex: 1; min-height: 0; }",
		".section { margin-bottom: 16px; }",
		".section-title { margin: 0 0 8px; }",
		".dock-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }",
		".dock-option { all: unset; display: flex; align-items: center; justify-content: center; height: 46px; border-radius: 8px;",
		"  cursor: pointer; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); }",
		".dock-option:hover { background: rgba(255, 255, 255, 0.09); }",
		".dock-option[aria-checked='true'] { border-color: var(--accent); background: var(--accent-soft); }",
		".dock-option:focus-visible, .swatch-btn:focus-visible, .icon-choice:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }",
		".mini-screen { position: relative; width: 48px; height: 30px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.3); }",
		".mini-bar { position: absolute; width: 18px; height: 5px; border-radius: 3px; background: var(--accent); }",
		".toggles { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; }",
		".toggles .check { padding: 4px 0; }",
		".swatches { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }",
		".swatch-btn { all: unset; width: 22px; height: 22px; border-radius: 50%; cursor: pointer; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.3); }",
		".swatch-btn[aria-checked='true'] { outline: 2px solid #eef2ea; outline-offset: 2px; }",
		".color-input { width: 30px; height: 24px; padding: 0; border: 0; background: none; cursor: pointer; }",
		".tool-list { display: flex; flex-direction: column; gap: 3px; }",
		".tool-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 8px; background: rgba(255, 255, 255, 0.035); }",
		".tool-row.dragging { background: var(--accent-soft); box-shadow: 0 0 0 1px var(--accent-line); }",
		".tool-row .grow { display: flex; align-items: center; gap: 6px; }",
		".tool-row.is-sep .grow { color: var(--faint); }",
		".grip { all: unset; display: inline-flex; padding: 3px; border-radius: 4px; color: var(--faint); cursor: grab; touch-action: none; }",
		".grip .icon { stroke-width: 2.4; }",
		".mini { all: unset; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;",
		"  border-radius: 6px; cursor: pointer; color: #c9d1c1; }",
		".mini:hover { background: rgba(255, 255, 255, 0.1); }",
		".mini[disabled] { opacity: 0.25; cursor: default; }",
		".add-row { display: flex; flex-wrap: wrap; gap: 6px; }",
		".custom-form { margin-top: 12px; padding: 12px; border-radius: 10px; background: rgba(255, 255, 255, 0.04);",
		"  border: 1px solid rgba(255, 255, 255, 0.08); }",
		".form-field { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; }",
		".icon-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; }",
		".icon-choice { all: unset; display: flex; align-items: center; justify-content: center; height: 28px; border-radius: 6px;",
		"  cursor: pointer; background: rgba(255, 255, 255, 0.05); }",
		".icon-choice[aria-checked='true'] { background: var(--accent); color: var(--accent-ink); }",
		".form-error { margin-top: 8px; color: #ffb4a8; }",
		"textarea.json { min-height: 340px; font-size: 11.5px; line-height: 1.5; }",
		".status { font-size: 11.5px; }",
		".preview-frame { position: relative; width: 100%; aspect-ratio: 16 / 10; overflow: hidden; border-radius: 10px;",
		"  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12); background: #f4f5f1; }",
		".preview-screen { position: absolute; top: 0; left: 0; transform-origin: 0 0; background: #f4f5f1; }",
		".preview-screen .bar { position: absolute; max-width: calc(100% - 24px); pointer-events: none; }",
		".mock-nav { position: absolute; top: 0; left: 0; right: 0; height: 64px; background: #ffffff; border-bottom: 1px solid #e3e6df; }",
		".mock-block { position: absolute; border-radius: 12px; background: #e6e9e2; }",
		".mock-block.dark { background: #cfd5c9; }",
	].join("\n");

	/**
	 * options.ui                XoUi.create(doc)
	 * options.layout, .source   the design and where it comes from ("app", "gateway" or "built-in")
	 * options.title             heading; options.subtitle is a string or a function of the source
	 * options.describe(source)  what the status line says before anything changes
	 * options.commit(layout, message)                  apply and save a changed design
	 * options.apply(json)  → Promise<{ layout, source }>   replace it with edited JSON
	 * options.reset()      → Promise<{ layout, source }>   drop it (inherit, or go back to the built-in design)
	 * options.canReset(source), options.resetLabel, options.resetDone
	 * options.previewAccent(color)   a color being picked, before it is chosen
	 * options.extras()     more sections: [{ title, content }]
	 * options.onClose()    shows a close button
	 * options.toast(message, isError)
	 */
	function create(options) {
		var ui = options.ui;
		var h = ui.h;
		var icon = ui.icon;
		var append = ui.appendChild;
		var view = ui.doc.defaultView;
		var layout = clone(options.layout);
		var source = options.source || "built-in";
		var history = [];
		var form = null;
		var json = null;
		var status = "";
		var resetArmed = false;
		var statusNode = null;
		var element = h("div", { class: "designer" });

		return {
			element: element,
			render: render,
			change: change,
			undo: undo,
			layout: function () {
				return clone(layout);
			},
			source: function () {
				return source;
			},
			/** The host's design changed (saved and normalized, loaded, or changed elsewhere). */
			setLayout: function (next, nextSource) {
				layout = clone(next);
				if (nextSource) source = nextSource;
				if (element.isConnected) render();
			},
			setStatus: setStatus,
		};

		// ------------------------------------------------------------ changes

		function change(mutate, message) {
			var next = clone(layout);
			mutate(next);
			history.push(clone(layout));
			if (history.length > 40) history.shift();
			layout = next;
			resetArmed = false;
			options.commit(clone(next), message);
			if (element.isConnected) render();
		}

		function undo() {
			var previous = history.pop();
			if (!previous) return;
			layout = previous;
			options.commit(clone(previous), "Undone");
			if (element.isConnected) render();
		}

		function reset() {
			if (!resetArmed) {
				resetArmed = true;
				render();
				view.setTimeout(function () {
					if (!resetArmed) return;
					resetArmed = false;
					if (element.isConnected) render();
				}, 4000);
				return;
			}
			resetArmed = false;
			var before = clone(layout);
			options.reset().then(
				function (result) {
					history.push(before);
					layout = clone(result.layout);
					source = result.source || source;
					status = "";
					if (element.isConnected) render();
					toast(options.resetDone || "Reset");
				},
				function (error) {
					setStatus("Couldn't reset: " + error.message);
				},
			);
		}

		function setStatus(text) {
			status = text;
			if (statusNode && statusNode.isConnected) statusNode.textContent = text || describe();
		}

		function describe() {
			return options.describe ? options.describe(source) : "";
		}

		function toast(message, isError) {
			if (options.toast) options.toast(message, isError);
		}

		// ------------------------------------------------------------ render

		function render() {
			// Re-rendering keeps the scroll position and the focused control.
			var oldBody = element.querySelector(".panel-body");
			var scroll = oldBody ? oldBody.scrollTop : 0;
			var root = element.getRootNode();
			var active = root && root.activeElement;
			var focusKey = active && element.contains(active) ? active.getAttribute("data-key") : null;

			var body = h("div", { class: "panel-body" });
			if (json) {
				append(body, jsonEditor());
			} else {
				append(body, [
					section("Dock", dockPicker(), h("div", { class: "toggles" },
						toggle("labels", "Show labels", layout.dock.labels, function (on) {
							change(function (next) {
								next.dock.labels = on;
							});
						}),
						toggle("start-open", "Open on page load", layout.dock.startOpen, function (on) {
							change(function (next) {
								next.dock.startOpen = on;
							});
						}))),
					section("Color", colorPicker()),
					section("Tools", toolList(), h("div", { class: "hint" }, "Drag a handle or use the arrows to reorder. Every change is saved as you make it.")),
					section("Add", addButtons(), form ? customForm() : null),
					(options.extras ? options.extras() : []).map(function (extra) {
						return section(extra.title, extra.content);
					}),
				]);
			}
			statusNode = h("span", { class: "muted status", role: "status" }, status || describe());
			var subtitle = typeof options.subtitle === "function" ? options.subtitle(source) : options.subtitle;
			element.replaceChildren(
				h("div", { class: "panel-head" },
					h("div", { class: "grow" },
						h("div", { class: "title" }, options.title),
						subtitle ? h("div", { class: "mono muted" }, subtitle) : null),
					options.onClose ? h("button", { class: "btn", type: "button", "aria-label": "Close", "data-key": "close", onclick: options.onClose }, icon("close")) : null),
				body,
				h("div", { class: "panel-foot" },
					h("div", { class: "row" },
						h("button", { class: "btn", type: "button", "data-key": "undo", disabled: !history.length, onclick: undo }, icon("undo"), "Undo"),
						options.canReset && options.canReset(source)
							? h("button", { class: "btn" + (resetArmed ? " danger" : ""), type: "button", "data-key": "reset", onclick: reset },
								resetArmed ? "Click again to confirm" : options.resetLabel || "Reset")
							: null,
						h("button", { class: "btn", type: "button", "data-key": "json", "aria-pressed": String(Boolean(json)), onclick: toggleJson },
							icon("code"), json ? "Visual editor" : "Edit JSON")),
					h("div", { class: "row" }, statusNode)),
			);
			body.scrollTop = scroll;
			if (focusKey) {
				var again = element.querySelector('[data-key="' + focusKey.replace(/"/g, "") + '"]');
				if (again && !again.disabled) again.focus({ preventScroll: true });
			}
		}

		function section(title) {
			var node = h("div", { class: "section" }, h("div", { class: "section-title" }, title));
			for (var i = 1; i < arguments.length; i++) append(node, arguments[i]);
			return node;
		}

		function dockPicker() {
			var grid = h("div", { class: "dock-grid", role: "radiogroup", "aria-label": "Dock position" });
			GRID.forEach(function (position) {
				var mini = h("span", { class: "mini-bar" });
				XoUi.dockAt(mini, position, { top: "3px", bottom: "3px", side: "4px" });
				grid.append(h("button", {
					class: "dock-option",
					type: "button",
					role: "radio",
					"data-key": "dock:" + position,
					"aria-checked": String(layout.dock.position === position),
					"aria-label": positionLabel(position),
					title: positionLabel(position),
					onclick: function () {
						if (layout.dock.position === position) return;
						change(function (next) {
							next.dock.position = position;
						});
					},
				}, h("span", { class: "mini-screen" }, mini)));
			});
			return grid;
		}

		function colorPicker() {
			var current = layout.theme.accent;
			var row = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Accent color" });
			ACCENTS.forEach(function (color) {
				var button = h("button", {
					class: "swatch-btn",
					type: "button",
					role: "radio",
					"data-key": "accent:" + color,
					"aria-checked": String(color === current),
					"aria-label": "Accent " + color,
					title: color,
					onclick: function () {
						setAccent(color);
					},
				});
				button.style.background = color;
				row.append(button);
			});
			var custom = h("input", { class: "color-input", type: "color", "data-key": "accent:custom", "aria-label": "Custom accent color", title: "Any color" });
			custom.value = current;
			var shown = h("span", { class: "mono muted" }, current);
			custom.addEventListener("input", function () {
				shown.textContent = custom.value;
				if (options.previewAccent) options.previewAccent(custom.value);
			});
			custom.addEventListener("change", function () {
				setAccent(custom.value);
			});
			row.append(custom, shown);
			return row;
		}

		function setAccent(color) {
			var value = String(color).toLowerCase();
			if (value === layout.theme.accent) return;
			change(function (next) {
				next.theme.accent = value;
			});
		}

		function toolList() {
			var list = h("div", { class: "tool-list" });
			var items = layout.items;
			var separators = 0;
			items.forEach(function (item, index) {
				var custom = Boolean(KINDS[item.type]);
				var name = itemName(item);
				// Controls are keyed by the item, not its index, so focus follows an item as it moves.
				var key = item.type === "separator" ? "separator#" + separators++ : item.id || item.type;
				var grip = h("button", { class: "grip", type: "button", "data-key": key + ":grip", title: "Drag to reorder, or use ↑ ↓", "aria-label": "Reorder " + name }, icon("grip"));
				var row = h("div", { class: "tool-row" + (item.type === "separator" ? " is-sep" : ""), "data-index": String(index) },
					grip,
					item.type === "separator"
						? h("span", { class: "grow" }, "Separator")
						: h("span", { class: "grow" }, icon(itemIcon(item)), h("span", {}, name), custom ? h("span", { class: "chip" }, KINDS[item.type]) : null),
					custom ? mini(key + ":edit", "pen", "Edit " + name, function () {
						openForm(item.type, index);
					}) : null,
					mini(key + ":up", "up", "Move " + name + " up", function () {
						moveItem(index, index - 1);
					}, index === 0),
					mini(key + ":down", "down", "Move " + name + " down", function () {
						moveItem(index, index + 1);
					}, index === items.length - 1),
					mini(key + ":remove", "close", "Remove " + name, function () {
						change(function (next) {
							next.items.splice(index, 1);
						}, "Removed " + name);
					}));
				grip.addEventListener("pointerdown", function (event) {
					dragRow(event, grip, row, list);
				});
				grip.addEventListener("keydown", function (event) {
					if (event.key === "ArrowUp" && index > 0) moveItem(index, index - 1);
					else if (event.key === "ArrowDown" && index < items.length - 1) moveItem(index, index + 1);
					else return;
					event.preventDefault();
				});
				list.append(row);
			});
			if (!items.length) list.append(h("div", { class: "empty" }, "The bar is empty. Add tools below."));
			return list;
		}

		function moveItem(from, to) {
			if (to < 0 || to >= layout.items.length || from === to) return;
			change(function (next) {
				var moved = next.items.splice(from, 1)[0];
				next.items.splice(to, 0, moved);
			});
		}

		/** Drag a row by its handle: the list reorders under the pointer, and the design follows on release. */
		function dragRow(event, grip, row, list) {
			if (event.button !== 0) return;
			event.preventDefault();
			grip.setPointerCapture(event.pointerId);
			row.classList.add("dragging");
			var from = Number(row.getAttribute("data-index"));
			function onMove(moveEvent) {
				var rows = Array.prototype.filter.call(list.children, function (node) {
					return node !== row && node.classList.contains("tool-row");
				});
				var before = null;
				for (var i = 0; i < rows.length; i++) {
					var rect = rows[i].getBoundingClientRect();
					if (moveEvent.clientY < rect.top + rect.height / 2) {
						before = rows[i];
						break;
					}
				}
				if (before) {
					if (row.nextSibling !== before) list.insertBefore(row, before);
				} else if (list.lastChild !== row) {
					list.append(row);
				}
			}
			function onUp() {
				grip.removeEventListener("pointermove", onMove);
				grip.removeEventListener("pointerup", onUp);
				grip.removeEventListener("pointercancel", onUp);
				row.classList.remove("dragging");
				var order = Array.prototype.map.call(list.querySelectorAll(".tool-row"), function (node) {
					return Number(node.getAttribute("data-index"));
				});
				var to = order.indexOf(from);
				if (to !== from) moveItem(from, to);
				else render();
			}
			grip.addEventListener("pointermove", onMove);
			grip.addEventListener("pointerup", onUp);
			grip.addEventListener("pointercancel", onUp);
		}

		function addButtons() {
			var items = layout.items;
			var full = items.length >= XoToolbarSchema.maxItems;
			var present = {};
			items.forEach(function (item) {
				present[item.type] = true;
			});
			var row = h("div", { class: "add-row" });
			XoToolbarSchema.tools.forEach(function (type) {
				if (present[type]) return;
				var info = XoUi.TOOLS[type];
				row.append(h("button", { class: "btn", type: "button", "data-key": "add:" + type, disabled: full, title: info.title, onclick: function () {
					change(function (next) {
						next.items.push({ type: type });
					}, "Added " + info.label);
				} }, icon("plus"), info.label));
			});
			row.append(
				h("button", { class: "btn", type: "button", "data-key": "add:separator", disabled: full, onclick: function () {
					change(function (next) {
						next.items.push({ type: "separator" });
					});
				} }, icon("plus"), "Separator"),
				h("button", { class: "btn", type: "button", "data-key": "add:link", disabled: full, title: "A button that opens a page, like Storybook or your docs", onclick: function () {
					openForm("link", -1);
				} }, icon("link"), "Link"),
				h("button", { class: "btn", type: "button", "data-key": "add:prompt", disabled: full, title: "A button that sends a saved prompt to the agent", onclick: function () {
					openForm("prompt", -1);
				} }, icon("sparkles"), "Agent prompt"),
			);
			if (full) row.append(h("div", { class: "hint" }, "The bar holds " + XoToolbarSchema.maxItems + " items at most."));
			return row;
		}

		function openForm(type, index) {
			var existing = index >= 0 ? layout.items[index] : null;
			form = {
				type: type,
				index: index,
				label: existing ? existing.label : "",
				icon: existing ? existing.icon : type === "link" ? "link" : "sparkles",
				href: existing && existing.href ? existing.href : "",
				prompt: existing && existing.prompt ? existing.prompt : "",
				scope: existing && existing.scope ? existing.scope : "element",
				error: "",
			};
			render();
			var field = element.querySelector(".custom-form input");
			if (field) {
				field.focus({ preventScroll: true });
				field.scrollIntoView({ block: "nearest" });
			}
		}

		function customForm() {
			var isLink = form.type === "link";
			var labelInput = h("input", { class: "field", type: "text", maxlength: "24", "data-key": "form:label", placeholder: isLink ? "Storybook" : "Polish", "aria-label": "Label" });
			labelInput.value = form.label;
			labelInput.addEventListener("input", function () {
				form.label = labelInput.value;
			});
			var choices = XoToolbarSchema.icons.map(function (name) {
				return h("button", {
					class: "icon-choice",
					type: "button",
					role: "radio",
					"aria-checked": String(form.icon === name),
					"aria-label": name,
					title: name,
					onclick: function () {
						form.icon = name;
						choices.forEach(function (choice) {
							choice.setAttribute("aria-checked", String(choice.getAttribute("aria-label") === name));
						});
					},
				}, icon(name));
			});
			var fields = [
				formField("Label", labelInput),
				formField("Icon", h("div", { class: "icon-grid", role: "radiogroup", "aria-label": "Icon" }, choices)),
			];
			if (isLink) {
				var hrefInput = h("input", { class: "field mono", type: "url", "data-key": "form:href", placeholder: "http://localhost:6006/", "aria-label": "Address" });
				hrefInput.value = form.href;
				hrefInput.addEventListener("input", function () {
					form.href = hrefInput.value;
				});
				fields.push(formField("Opens", hrefInput));
			} else {
				var promptInput = h("textarea", { class: "field", "data-key": "form:prompt", placeholder: "Tighten the spacing and type of this element to match the design system", "aria-label": "Prompt" });
				promptInput.value = form.prompt;
				promptInput.addEventListener("input", function () {
					form.prompt = promptInput.value;
				});
				var scopes = h("div", { class: "toggles" },
					radio("scope", "The element I pick", form.scope === "element", function () {
						form.scope = "element";
					}),
					radio("scope", "The whole page", form.scope === "page", function () {
						form.scope = "page";
					}));
				fields.push(formField("Prompt", promptInput), formField("About", scopes));
			}
			return h("div", { class: "custom-form" },
				h("div", { class: "section-title" }, (form.index >= 0 ? "Edit " : "New ") + (isLink ? "link" : "agent prompt")),
				fields,
				form.error ? h("div", { class: "form-error", role: "alert" }, form.error) : null,
				h("div", { class: "row end" },
					h("button", { class: "btn", type: "button", "data-key": "form:cancel", onclick: function () {
						form = null;
						render();
					} }, "Cancel"),
					h("button", { class: "btn primary", type: "button", "data-key": "form:submit", onclick: submitForm }, form.index >= 0 ? "Save" : "Add to bar")));
		}

		function submitForm() {
			var name = form.label.trim().replace(/\s+/g, " ").slice(0, 24);
			if (!name) return formError("Give it a label");
			var existing = form.index >= 0 ? layout.items[form.index] : null;
			var item = { type: form.type, id: existing && existing.id ? existing.id : uniqueId(name), label: name, icon: form.icon };
			if (form.type === "link") {
				var href;
				try {
					href = new URL(form.href.trim());
				} catch (error) {
					return formError("Enter a full address, like http://localhost:6006/");
				}
				if (href.protocol !== "http:" && href.protocol !== "https:") return formError("Links must start with http:// or https://");
				item.href = href.href;
			} else {
				var prompt = form.prompt.trim();
				if (!prompt) return formError("Write what the agent should do");
				item.prompt = prompt.slice(0, 1000);
				item.scope = form.scope === "page" ? "page" : "element";
			}
			var index = form.index;
			form = null;
			change(function (next) {
				if (index >= 0) next.items[index] = item;
				else next.items.push(item);
			}, (index >= 0 ? "Updated " : "Added ") + name);
		}

		function formError(message) {
			form.error = message;
			render();
		}

		function uniqueId(name) {
			var base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "tool";
			var taken = {};
			layout.items.forEach(function (item) {
				if (item.id) taken[item.id] = true;
			});
			var id = base;
			for (var n = 2; taken[id]; n += 1) id = base + "-" + n;
			return id;
		}

		function toggleJson() {
			json = json ? null : { text: JSON.stringify(layout, null, 2), error: "" };
			render();
		}

		function jsonEditor() {
			var area = h("textarea", { class: "field json mono", "data-key": "json:text", spellcheck: "false", "aria-label": "telescope design as JSON" });
			area.value = json.text;
			area.addEventListener("input", function () {
				json.text = area.value;
			});
			return [
				h("div", { class: "hint" },
					"Tools: " + XoToolbarSchema.tools.join(", ") + ", separator, link { label, icon, href }, prompt { label, icon, prompt, scope }. " +
					"Docks: " + GRID.join(", ") + ". Icons: " + XoToolbarSchema.icons.join(", ") + "."),
				area,
				json.error ? h("div", { class: "form-error", role: "alert" }, json.error) : null,
				h("div", { class: "row end" },
					h("button", { class: "btn", type: "button", onclick: toggleJson }, "Cancel"),
					h("button", { class: "btn primary", type: "button", "data-key": "json:apply", onclick: applyJson }, "Apply")),
			];
		}

		function applyJson() {
			var parsed;
			try {
				parsed = JSON.parse(json.text);
			} catch (error) {
				json.error = "That isn't valid JSON: " + error.message;
				render();
				return;
			}
			var before = clone(layout);
			options.apply(parsed).then(
				function (result) {
					history.push(before);
					layout = clone(result.layout);
					source = result.source || source;
					json = null;
					status = "";
					render();
					toast("Design applied");
				},
				function (error) {
					if (json) json.error = error.message;
					render();
				},
			);
		}

		// ------------------------------------------------------------ controls

		function toggle(key, text, on, onchange) {
			var input = h("input", { type: "checkbox", "data-key": "toggle:" + key });
			input.checked = on;
			input.addEventListener("change", function () {
				onchange(input.checked);
			});
			return h("label", { class: "check" }, input, h("span", {}, text));
		}

		function radio(name, text, on, onchange) {
			var input = h("input", { type: "radio", name: name });
			input.checked = on;
			input.addEventListener("change", function () {
				if (input.checked) onchange();
			});
			return h("label", { class: "check" }, input, h("span", {}, text));
		}

		function formField(text, control) {
			return h("div", { class: "form-field" }, h("span", { class: "side-label" }, text), control);
		}

		function mini(key, iconName, text, onclick, disabled) {
			return h("button", { class: "mini", type: "button", "data-key": key, "aria-label": text, title: text, disabled: Boolean(disabled), onclick: onclick }, icon(iconName));
		}
	}

	/**
	 * A still picture of a design: a page, drawn at 1280 × 800 and scaled to its
	 * box, with the bar docked where the design puts it. Call `fit()` after the
	 * frame is in the document and when it resizes.
	 */
	function preview(ui, layout, options) {
		var h = ui.h;
		var icon = ui.icon;
		var frame = h("div", { class: "preview-frame xo", role: "img", "aria-label": "Preview: the bar docked " + positionLabel(layout.dock.position).toLowerCase() });
		var screen = h("div", { class: "preview-screen" });
		screen.style.width = PREVIEW_WIDTH + "px";
		screen.style.height = PREVIEW_HEIGHT + "px";
		screen.append(h("div", { class: "mock-nav" }));
		[
			[96, 120, 640, 44, true],
			[96, 184, 520, 20],
			[96, 216, 460, 20],
			[96, 290, 330, 190],
			[475, 290, 330, 190],
			[854, 290, 330, 190],
			[96, 530, 1088, 160],
		].forEach(function (spec) {
			var block = h("div", { class: "mock-block" + (spec[4] ? " dark" : "") });
			block.style.left = spec[0] + "px";
			block.style.top = spec[1] + "px";
			block.style.width = spec[2] + "px";
			block.style.height = spec[3] + "px";
			screen.append(block);
		});
		var bar = h("div", { class: "bar" + (layout.dock.labels ? "" : " no-labels") });
		var extras = h("div", { class: "extras" });
		XoUi.visibleItems(layout.items).forEach(function (item) {
			if (item.type === "separator") return extras.append(h("span", { class: "sep" }));
			if (item.type === "apps") {
				return extras.append(h("span", { class: "nav" },
					h("span", { class: "nav-seg nav-version" }, h("span", { class: "dot up" }), "dev", icon("chevron")),
					h("span", { class: "nav-sep" }, "·"),
					h("span", { class: "nav-seg" }, h("span", { class: "nav-text" }, options && options.app ? options.app : "app"), icon("chevron")),
					h("span", { class: "nav-sep" }, "·"),
					h("span", { class: "nav-path" }, "/")));
			}
			var info = XoUi.TOOLS[item.type];
			extras.append(h("span", { class: "tool" }, icon(info ? info.icon : item.icon), h("span", { class: "label" }, info ? info.label : item.label)));
		});
		extras.append(h("span", { class: "tool icon-only" }, icon("customize")));
		bar.append(h("span", { class: "logo" }, "XO"), extras);
		XoUi.dockAt(bar, layout.dock.position, { top: "14px", bottom: "18px", side: "16px" });
		screen.append(bar);
		frame.append(screen);
		XoUi.theme(frame, layout.theme.accent);
		return {
			element: frame,
			fit: function () {
				var width = frame.clientWidth || PREVIEW_WIDTH;
				screen.style.transform = "scale(" + width / PREVIEW_WIDTH + ")";
			},
		};
	}

	function itemName(item) {
		if (item.type === "separator") return "Separator";
		if (XoUi.TOOLS[item.type]) return XoUi.TOOLS[item.type].label;
		return item.label || item.type;
	}

	function itemIcon(item) {
		return XoUi.TOOLS[item.type] ? XoUi.TOOLS[item.type].icon : item.icon;
	}

	function positionLabel(position) {
		var parts = String(position).split("-");
		return parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + " " + parts[1];
	}

	function clone(value) {
		return JSON.parse(JSON.stringify(value));
	}

	return { create: create, preview: preview, positionLabel: positionLabel, STYLES: STYLES, GRID: GRID };
})();
