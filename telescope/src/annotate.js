/*!
 * XO annotate: marks drawn on a screenshot before it is shared.
 *
 * Arrows, boxes, freehand lines and solid "hide" blocks for anything private.
 * Marks are kept as shapes in the screenshot's own pixels, so undo is exact
 * and the exported PNG is full resolution whatever size it is shown at.
 */
var XoAnnotate = (function () {
	"use strict";

	var TOOLS = [
		{ id: "arrow", label: "Arrow", key: "a" },
		{ id: "box", label: "Box", key: "b" },
		{ id: "pen", label: "Draw", key: "d" },
		{ id: "redact", label: "Hide", key: "h" },
	];
	var COLORS = [
		{ value: "#ff4d4f", name: "Red" },
		{ value: "#ffc53d", name: "Yellow" },
		{ value: "#83d63a", name: "Green" },
		{ value: "#4096ff", name: "Blue" },
		{ value: "#ffffff", name: "White" },
	];

	var STYLES = [
		".annotate { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }",
		".annotate-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 8px 10px;",
		"  border-bottom: 1px solid rgba(255, 255, 255, 0.08); }",
		".annotate-tools .btn[aria-pressed='true'] { background: var(--accent); color: var(--accent-ink); }",
		".annotate-colors { display: inline-flex; gap: 6px; margin: 0 6px; }",
		".annotate-color { all: unset; width: 18px; height: 18px; border-radius: 50%; cursor: pointer;",
		"  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35); }",
		".annotate-color[aria-checked='true'] { outline: 2px solid #eef2ea; outline-offset: 2px; }",
		".annotate-color:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
		".annotate-stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;",
		"  padding: 14px; overflow: hidden; background: #0a0c09; }",
		".annotate-canvas { display: block; cursor: crosshair; touch-action: none; border-radius: 4px;",
		"  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12), 0 10px 30px rgba(0, 0, 0, 0.45); }",
		".annotate-spacer { flex: 1; }",
	].join("\n");

	/**
	 * options.source   the screenshot, a canvas at full resolution
	 * options.scale    screenshot pixels per CSS pixel, to show it at its natural size
	 * options.h, options.icon   the toolbar's element and icon helpers
	 * options.onChange called after every edit
	 */
	function create(options) {
		var h = options.h;
		var icon = options.icon;
		var source = options.source;
		var naturalScale = options.scale || 1;
		var shapes = [];
		var current = null;
		var tool = "arrow";
		var color = COLORS[0].value;
		var width = Math.max(3, Math.round(Math.max(source.width, source.height) / 360));

		var canvas = h("canvas", { class: "annotate-canvas", "aria-label": "Screenshot. Drag to mark it up." });
		canvas.width = source.width;
		canvas.height = source.height;
		var context = canvas.getContext("2d");

		var toolButtons = {};
		var toolRow = h("div", { class: "annotate-tools", role: "toolbar", "aria-label": "Mark up the screenshot" });
		TOOLS.forEach(function (item) {
			var button = h("button", {
				class: "btn",
				type: "button",
				title: item.label + " (" + item.key.toUpperCase() + ")",
				"aria-pressed": String(item.id === tool),
				onclick: function () {
					setTool(item.id);
				},
			}, icon(item.id), item.label);
			toolButtons[item.id] = button;
			toolRow.append(button);
		});
		var colorButtons = [];
		var colors = h("span", { class: "annotate-colors", role: "radiogroup", "aria-label": "Color" });
		COLORS.forEach(function (item) {
			var button = h("button", {
				class: "annotate-color",
				type: "button",
				role: "radio",
				title: item.name,
				"aria-label": item.name,
				"aria-checked": String(item.value === color),
				onclick: function () {
					setColor(item.value);
				},
			});
			button.style.background = item.value;
			button.dataset.color = item.value;
			colorButtons.push(button);
			colors.append(button);
		});
		var undoButton = h("button", { class: "btn", type: "button", title: "Undo (⌘/Ctrl+Z)", disabled: true, onclick: undo }, icon("undo"), "Undo");
		var clearButton = h("button", { class: "btn", type: "button", title: "Remove every mark", disabled: true, onclick: clear }, "Clear");
		toolRow.append(colors, h("span", { class: "annotate-spacer" }), undoButton, clearButton);

		var stage = h("div", { class: "annotate-stage" }, canvas);
		var element = h("div", { class: "annotate" }, toolRow, stage);

		canvas.addEventListener("pointerdown", function (event) {
			if (event.button !== 0) return;
			event.preventDefault();
			canvas.setPointerCapture(event.pointerId);
			var point = toImage(event);
			current = { tool: tool, color: color, width: width, points: [point, point] };
			render();
		});
		canvas.addEventListener("pointermove", function (event) {
			if (!current) return;
			var point = toImage(event);
			if (current.tool === "pen") current.points.push(point);
			else current.points[1] = point;
			render();
		});
		function finish() {
			if (!current) return;
			var shape = current;
			current = null;
			if (large(shape)) {
				shapes.push(shape);
				changed();
			}
			render();
		}
		canvas.addEventListener("pointerup", finish);
		canvas.addEventListener("pointercancel", finish);

		render();

		return {
			element: element,
			fit: fit,
			undo: undo,
			edited: function () {
				return shapes.length > 0;
			},
			count: function () {
				return shapes.length;
			},
			/** Handles the editor's own keys; returns true when it used the key. */
			key: function (event) {
				if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
					undo();
					return true;
				}
				if (event.metaKey || event.ctrlKey || event.altKey) return false;
				for (var i = 0; i < TOOLS.length; i++) {
					if (event.key.toLowerCase() === TOOLS[i].key) {
						setTool(TOOLS[i].id);
						return true;
					}
				}
				return false;
			},
			toBlob: function (type) {
				current = null;
				render();
				return XoCapture.toBlob(canvas, type);
			},
			canvas: canvas,
		};

		function setTool(id) {
			tool = id;
			Object.keys(toolButtons).forEach(function (key) {
				toolButtons[key].setAttribute("aria-pressed", String(key === id));
			});
		}

		function setColor(value) {
			color = value;
			colorButtons.forEach(function (button) {
				button.setAttribute("aria-checked", String(button.dataset.color === value));
			});
		}

		function undo() {
			if (!shapes.length) return;
			shapes.pop();
			changed();
			render();
		}

		function clear() {
			if (!shapes.length) return;
			shapes = [];
			changed();
			render();
		}

		function changed() {
			undoButton.disabled = shapes.length === 0;
			clearButton.disabled = shapes.length === 0;
			if (options.onChange) options.onChange();
		}

		/** Shown at its natural size when it fits, scaled down to the stage otherwise. */
		function fit() {
			var availableWidth = Math.max(40, stage.clientWidth - 28);
			var availableHeight = Math.max(40, stage.clientHeight - 28);
			var naturalWidth = source.width / naturalScale;
			var naturalHeight = source.height / naturalScale;
			var ratio = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
			canvas.style.width = Math.round(naturalWidth * ratio) + "px";
			canvas.style.height = Math.round(naturalHeight * ratio) + "px";
		}

		function toImage(event) {
			var rect = canvas.getBoundingClientRect();
			return {
				x: ((event.clientX - rect.left) / rect.width) * canvas.width,
				y: ((event.clientY - rect.top) / rect.height) * canvas.height,
			};
		}

		function large(shape) {
			var first = shape.points[0];
			var last = shape.points[shape.points.length - 1];
			if (shape.tool === "pen") return shape.points.length > 2;
			return Math.abs(last.x - first.x) + Math.abs(last.y - first.y) > width * 2;
		}

		function render() {
			context.clearRect(0, 0, canvas.width, canvas.height);
			context.drawImage(source, 0, 0);
			shapes.forEach(draw);
			if (current) draw(current);
		}

		function draw(shape) {
			var a = shape.points[0];
			var b = shape.points[shape.points.length - 1];
			context.save();
			context.strokeStyle = shape.color;
			context.fillStyle = shape.color;
			context.lineWidth = shape.width;
			context.lineCap = "round";
			context.lineJoin = "round";
			// A dark halo keeps marks readable on light and dark pages alike.
			context.shadowColor = "rgba(0, 0, 0, 0.35)";
			context.shadowBlur = shape.width;
			if (shape.tool === "box") {
				context.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
			} else if (shape.tool === "redact") {
				context.shadowBlur = 0;
				context.fillStyle = "#111410";
				context.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
			} else if (shape.tool === "pen") {
				context.beginPath();
				context.moveTo(shape.points[0].x, shape.points[0].y);
				for (var i = 1; i < shape.points.length; i++) context.lineTo(shape.points[i].x, shape.points[i].y);
				context.stroke();
			} else {
				arrow(a, b, shape.width);
			}
			context.restore();
		}

		function arrow(from, to, lineWidth) {
			var angle = Math.atan2(to.y - from.y, to.x - from.x);
			var head = Math.max(lineWidth * 4, 14);
			var length = Math.hypot(to.x - from.x, to.y - from.y);
			var shaftEnd = length > head ? { x: to.x - Math.cos(angle) * head * 0.8, y: to.y - Math.sin(angle) * head * 0.8 } : from;
			context.beginPath();
			context.moveTo(from.x, from.y);
			context.lineTo(shaftEnd.x, shaftEnd.y);
			context.stroke();
			context.beginPath();
			context.moveTo(to.x, to.y);
			context.lineTo(to.x - Math.cos(angle - 0.45) * head, to.y - Math.sin(angle - 0.45) * head);
			context.lineTo(to.x - Math.cos(angle + 0.45) * head, to.y - Math.sin(angle + 0.45) * head);
			context.closePath();
			context.fill();
		}
	}

	return { create: create, STYLES: STYLES, TOOLS: TOOLS, COLORS: COLORS };
})();
