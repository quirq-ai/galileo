/*!
 * XO capture: screenshots and recordings of the tab the toolbar runs in.
 *
 * Built on the Screen Capture API with the current tab preferred, so Chrome
 * asks once ("share this tab?") and captures the real rendering: canvases,
 * video, cross-origin images and all. The stream is kept for a couple of
 * minutes after each capture, so the next screenshot is instant and needs no
 * second prompt; the browser shows that the tab is being shared meanwhile.
 *
 * Coordinates are the page's viewport pixels. A frame is mapped back onto the
 * viewport at capture time, so a crop lands on the right pixels whatever
 * resolution the browser delivers. Inside a frame (XO's Browser pane) the
 * capture is the whole tab: it is cropped to this frame where the browser
 * supports Region Capture, and otherwise returned whole.
 *
 * All media objects come from the page's own window (`page`), as the page is
 * where the user clicked and whose permissions apply.
 */
var XoCapture = (function () {
	"use strict";

	var IDLE_MS = 2 * 60 * 1000;
	var MAX_RECORDING_MS = 5 * 60 * 1000;

	/**
	 * hooks.hideUi()        hides the toolbar for a clean frame; returns a function that shows it again
	 * hooks.viewportTarget() an always-rendered, viewport-sized <div> to crop a framed page's capture to
	 * hooks.onChange()      sharing or recording started or stopped
	 */
	function create(page, hooks) {
		var stream = null;
		var starting = null;
		var idleTimer = 0;
		var recording = null;
		var cropped = false;

		function support() {
			var devices = page.navigator.mediaDevices;
			if (!devices || typeof devices.getDisplayMedia !== "function") {
				return { ok: false, reason: "This browser can't capture the screen" };
			}
			var policy = page.document.permissionsPolicy || page.document.featurePolicy;
			if (policy && typeof policy.allowsFeature === "function" && !policy.allowsFeature("display-capture")) {
				return {
					ok: false,
					reason: framed()
						? 'Screen capture is off in this frame. Open the page in its own tab, or give the frame allow="display-capture".'
						: "Screen capture is turned off on this page",
				};
			}
			return { ok: true };
		}

		function framed() {
			try {
				return page.top !== page;
			} catch (error) {
				return true;
			}
		}

		function isSharing() {
			return Boolean(stream && stream.active);
		}

		/** The capture stream, asking the user first if there is none. Call it from a click or key press. */
		function ensureStream() {
			if (isSharing()) {
				touch();
				return Promise.resolve({ stream: stream, fresh: false });
			}
			if (starting) return starting;
			var check = support();
			if (!check.ok) return Promise.reject(new Error(check.reason));
			var ratio = page.devicePixelRatio || 1;
			starting = page.navigator.mediaDevices
				.getDisplayMedia({
					// Without an ideal size Chrome scales the tab down; ask for the viewport's real pixels.
					video: {
						displaySurface: "browser",
						width: { ideal: Math.round(page.innerWidth * ratio) },
						height: { ideal: Math.round(page.innerHeight * ratio) },
						frameRate: { ideal: 30, max: 30 },
					},
					audio: false,
					preferCurrentTab: true,
					selfBrowserSurface: "include",
					surfaceSwitching: "exclude",
					monitorTypeSurfaces: "exclude",
				})
				.then(
					function (newStream) {
						stream = newStream;
						var track = stream.getVideoTracks()[0];
						track.addEventListener("ended", release);
						return cropToFrame(track).then(function () {
							starting = null;
							touch();
							hooks.onChange();
							return { stream: stream, fresh: true };
						});
					},
					function (error) {
						starting = null;
						throw friendly(error);
					},
				);
			return starting;
		}

		/** Inside a frame, crop the tab's capture to this frame where Region Capture exists. */
		function cropToFrame(track) {
			cropped = false;
			if (!framed()) return Promise.resolve();
			if (!page.CropTarget || typeof track.cropTo !== "function") return Promise.resolve();
			return page.CropTarget.fromElement(hooks.viewportTarget())
				.then(function (target) {
					return track.cropTo(target);
				})
				.then(
					function () {
						cropped = true;
					},
					function () {
						cropped = false;
					},
				);
		}

		/** Whether frames line up with this page's viewport, so crops can be computed. */
		function alignedWithViewport() {
			return !framed() || cropped;
		}

		/** Stops sharing now; the next capture asks again. */
		function release() {
			page.clearTimeout(idleTimer);
			var active = recording;
			if (active) active.stop();
			if (stream) {
				stream.getTracks().forEach(function (track) {
					track.stop();
				});
			}
			stream = null;
			hooks.onChange();
		}

		function touch() {
			page.clearTimeout(idleTimer);
			idleTimer = page.setTimeout(function () {
				if (!recording) release();
			}, IDLE_MS);
		}

		/**
		 * One frame of the viewport without the toolbar in it, as a canvas.
		 * `rect` (viewport pixels) crops it; without one the whole viewport is kept.
		 */
		function grab(options) {
			var rect = options && options.rect;
			return ensureStream().then(function (started) {
				var restore = hooks.hideUi();
				// A new share makes the browser show its "sharing this tab" bar, which resizes the page.
				return wait(started.fresh ? 400 : 0)
					.then(nextPaint)
					.then(nextPaint)
					.then(function () {
						return wait(80);
					})
					.then(readFrame)
					.then(
						function (source) {
							restore();
							touch();
							return toCanvas(source, rect);
						},
						function (error) {
							restore();
							throw error;
						},
					);
			});
		}

		function readFrame() {
			var track = stream && stream.getVideoTracks()[0];
			if (!track || track.readyState !== "live") return Promise.reject(new Error("Sharing stopped before the capture"));
			if (typeof page.ImageCapture === "function") {
				return timeout(new page.ImageCapture(track).grabFrame(), 2000).catch(fromVideo);
			}
			return fromVideo();
		}

		/** For browsers without ImageCapture: play the stream in a detached video and read it. */
		function fromVideo() {
			var video = page.document.createElement("video");
			video.muted = true;
			video.playsInline = true;
			video.srcObject = stream;
			return video
				.play()
				.then(function () {
					return new Promise(function (resolve) {
						var done = false;
						function finish() {
							if (done) return;
							done = true;
							resolve();
						}
						if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(finish);
						page.setTimeout(finish, 250);
					});
				})
				.then(function () {
					var canvas = page.document.createElement("canvas");
					canvas.width = video.videoWidth;
					canvas.height = video.videoHeight;
					canvas.getContext("2d").drawImage(video, 0, 0);
					video.pause();
					video.srcObject = null;
					return canvas;
				});
		}

		/** Maps the viewport onto the frame (it may be scaled or letterboxed) and cuts out `rect`. */
		function toCanvas(source, rect) {
			var frameWidth = source.width;
			var frameHeight = source.height;
			var region = { x: 0, y: 0, width: frameWidth, height: frameHeight };
			var scale = frameWidth / Math.max(1, page.innerWidth);
			var whole = !alignedWithViewport();
			if (!whole) {
				var viewWidth = page.innerWidth;
				var viewHeight = page.innerHeight;
				scale = Math.min(frameWidth / viewWidth, frameHeight / viewHeight);
				var offsetX = (frameWidth - viewWidth * scale) / 2;
				var offsetY = (frameHeight - viewHeight * scale) / 2;
				var area = rect || { left: 0, top: 0, width: viewWidth, height: viewHeight };
				var left = clamp(area.left, 0, viewWidth);
				var top = clamp(area.top, 0, viewHeight);
				var right = clamp(area.left + area.width, 0, viewWidth);
				var bottom = clamp(area.top + area.height, 0, viewHeight);
				region = {
					x: offsetX + left * scale,
					y: offsetY + top * scale,
					width: Math.max(1, (right - left) * scale),
					height: Math.max(1, (bottom - top) * scale),
				};
			}
			var canvas = page.document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(region.width));
			canvas.height = Math.max(1, Math.round(region.height));
			canvas.getContext("2d").drawImage(source, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
			if (typeof source.close === "function") source.close();
			return { canvas: canvas, scale: scale, whole: whole };
		}

		/**
		 * Starts recording the tab, with the microphone if asked. Resolves to controls:
		 * done, elapsed(), paused(), pause(), resume(), stop() → { blob, durationMs, type }, cancel().
		 */
		function record(options) {
			options = options || {};
			if (recording) return Promise.reject(new Error("Already recording"));
			if (typeof page.MediaRecorder !== "function") return Promise.reject(new Error("This browser can't record the screen"));
			return ensureStream().then(function () {
				var microphone = options.audio
					? page.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).catch(function () {
						if (options.onWarning) options.onWarning("Microphone unavailable: recording without sound");
						return null;
					})
					: Promise.resolve(null);
				return microphone.then(function (mic) {
					var tracks = stream.getVideoTracks().concat(mic ? mic.getAudioTracks() : []);
					var type = pickType(Boolean(mic));
					var recorder = new page.MediaRecorder(new page.MediaStream(tracks), type ? { mimeType: type, videoBitsPerSecond: 5000000 } : undefined);
					var chunks = [];
					var startedAt = Date.now();
					var pausedAt = 0;
					var pausedFor = 0;
					var cancelled = false;
					var ticker = 0;
					var maxMs = options.maxMs || MAX_RECORDING_MS;

					var finished = new Promise(function (resolve, reject) {
						recorder.addEventListener("dataavailable", function (event) {
							if (event.data && event.data.size) chunks.push(event.data);
						});
						recorder.addEventListener("stop", function () {
							page.clearInterval(ticker);
							if (mic) {
								mic.getTracks().forEach(function (track) {
									track.stop();
								});
							}
							var durationMs = elapsed();
							recording = null;
							touch();
							hooks.onChange();
							var mime = (recorder.mimeType || type || "video/webm").split(";")[0];
							resolve(cancelled ? null : { blob: new page.Blob(chunks, { type: mime }), durationMs: durationMs, type: mime });
						});
						recorder.addEventListener("error", function (event) {
							page.clearInterval(ticker);
							recording = null;
							hooks.onChange();
							reject(event.error || new Error("Recording failed"));
						});
					});

					function elapsed() {
						return (pausedAt || Date.now()) - startedAt - pausedFor;
					}

					function stop() {
						if (recorder.state !== "inactive") recorder.stop();
						return finished;
					}

					recording = {
						/** Settles when recording ends for any reason: stop(), cancel() (null), the time limit, or sharing stopped. */
						done: finished,
						elapsed: elapsed,
						maxMs: maxMs,
						withAudio: Boolean(mic),
						paused: function () {
							return recorder.state === "paused";
						},
						pause: function () {
							if (recorder.state !== "recording") return;
							recorder.pause();
							pausedAt = Date.now();
						},
						resume: function () {
							if (recorder.state !== "paused") return;
							pausedFor += Date.now() - pausedAt;
							pausedAt = 0;
							recorder.resume();
						},
						stop: stop,
						cancel: function () {
							cancelled = true;
							return stop();
						},
					};
					page.clearTimeout(idleTimer);
					recorder.start(1000);
					ticker = page.setInterval(function () {
						if (options.onTick) options.onTick(elapsed());
						if (elapsed() >= maxMs) stop();
					}, 250);
					hooks.onChange();
					return recording;
				});
			});
		}

		function pickType(withAudio) {
			var candidates = withAudio
				? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
				: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
			for (var i = 0; i < candidates.length; i++) {
				if (page.MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
			}
			return "";
		}

		function nextPaint() {
			return new Promise(function (resolve) {
				page.requestAnimationFrame(function () {
					resolve();
				});
			});
		}

		function wait(ms) {
			return new Promise(function (resolve) {
				page.setTimeout(resolve, ms);
			});
		}

		function timeout(promise, ms) {
			return new Promise(function (resolve, reject) {
				var timer = page.setTimeout(function () {
					reject(new Error("Timed out"));
				}, ms);
				promise.then(
					function (value) {
						page.clearTimeout(timer);
						resolve(value);
					},
					function (error) {
						page.clearTimeout(timer);
						reject(error);
					},
				);
			});
		}

		return {
			support: support,
			isSharing: isSharing,
			isRecording: function () {
				return Boolean(recording);
			},
			recording: function () {
				return recording;
			},
			framed: framed,
			ensureStream: ensureStream,
			grab: grab,
			record: record,
			release: release,
		};
	}

	/** Errors from the browser, in words a person can act on. */
	function friendly(error) {
		var name = error && error.name;
		if (name === "NotAllowedError") return new Error("Screen capture was cancelled or blocked");
		if (name === "InvalidStateError") return new Error("Click the button again to start capturing");
		if (name === "NotFoundError") return new Error("There was nothing to capture");
		if (name === "NotReadableError") return new Error("The browser couldn't read the screen");
		return new Error((error && error.message) || String(error));
	}

	/** A canvas as a PNG (or another type) blob. */
	function toBlob(canvas, type) {
		return new Promise(function (resolve, reject) {
			canvas.toBlob(function (blob) {
				if (blob) resolve(blob);
				else reject(new Error("Couldn't encode the image"));
			}, type || "image/png");
		});
	}

	function clamp(value, min, max) {
		return Math.min(max, Math.max(min, value));
	}

	return { create: create, toBlob: toBlob, MAX_RECORDING_MS: MAX_RECORDING_MS };
})();
