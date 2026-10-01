/**
 * Screenshots and recordings, stored per app under `data/uploads/<app>/` and
 * served back on that app's own host at `/__xo/uploads/<file>`, so the
 * toolbar can show them under the page's own `img-src 'self'` and an agent can
 * open them by path.
 */
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

const EXTENSIONS = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"video/webm": "webm",
	"video/mp4": "mp4",
};
const TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, extension]) => [extension, type]));
const FILE_NAME = /^u_[a-z0-9]+\.(png|jpg|webp|webm|mp4)$/;

export function createUploads(dataDir) {
	const root = path.join(dataDir, "uploads");

	function folder(app) {
		const dir = path.join(root, app);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	function describe(app, fileName, size) {
		return {
			id: fileName.replace(/\.[a-z0-9]+$/, ""),
			file: fileName,
			url: `/__xo/uploads/${fileName}`,
			path: path.join(root, app, fileName),
			type: TYPES[path.extname(fileName).slice(1)],
			kind: fileName.endsWith(".webm") || fileName.endsWith(".mp4") ? "video" : "image",
			size,
		};
	}

	return {
		/** Streams a request body to disk, refusing unknown types and anything over the size limit. */
		async save(app, req) {
			const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
			const extension = EXTENSIONS[type];
			if (!extension) throw status(415, `Uploads must be one of: ${Object.keys(EXTENSIONS).join(", ")}`);
			const declared = Number(req.headers["content-length"] ?? 0);
			if (declared > MAX_UPLOAD_BYTES) throw status(413, "Upload too large");

			const fileName = `u_${Date.now().toString(36)}${randomBytes(4).toString("hex")}.${extension}`;
			const target = path.join(folder(app), fileName);
			const temp = `${target}.part`;
			let size = 0;
			const limit = new Transform({
				transform(chunk, _encoding, done) {
					size += chunk.length;
					if (size > MAX_UPLOAD_BYTES) done(status(413, "Upload too large"));
					else done(null, chunk);
				},
			});
			try {
				await pipeline(req, limit, createWriteStream(temp));
			} catch (error) {
				await rm(temp, { force: true });
				throw error.status ? error : status(400, `Upload failed: ${error.message}`);
			}
			if (size === 0) {
				await rm(temp, { force: true });
				throw status(400, "The upload was empty");
			}
			await rename(temp, target);
			return describe(app, fileName, size);
		},

		/** An upload of this app by id, or `undefined`; ids from other apps never resolve. */
		async find(app, id) {
			if (typeof id !== "string" || !/^u_[a-z0-9]+$/.test(id)) return undefined;
			for (const extension of Object.values(EXTENSIONS)) {
				const fileName = `${id}.${extension}`;
				try {
					const info = await stat(path.join(root, app, fileName));
					return describe(app, fileName, info.size);
				} catch {
					// Not this extension; try the next.
				}
			}
			return undefined;
		},

		/** Deletes an upload of this app, as when a capture is discarded. */
		async remove(app, id) {
			const upload = await this.find(app, id);
			if (!upload) return false;
			await rm(upload.path, { force: true });
			return true;
		},

		/** Serves a stored file with byte ranges, so recordings can be seeked in a <video>. */
		async serve(app, fileName, req, res) {
			if (!FILE_NAME.test(fileName)) return false;
			const file = path.join(root, app, fileName);
			let info;
			try {
				info = await stat(file);
			} catch {
				return false;
			}
			const type = TYPES[path.extname(fileName).slice(1)];
			const headers = {
				"content-type": type,
				"accept-ranges": "bytes",
				"cache-control": "private, max-age=3600",
				"x-content-type-options": "nosniff",
			};
			const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
			if (!range || (range[1] === "" && range[2] === "")) {
				res.writeHead(200, { ...headers, "content-length": info.size });
				createReadStream(file).pipe(res);
				return true;
			}
			let start = range[1] === "" ? Math.max(0, info.size - Number(range[2])) : Number(range[1]);
			let end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
			if (start > end || start >= info.size) {
				res.writeHead(416, { "content-range": `bytes */${info.size}` });
				res.end();
				return true;
			}
			res.writeHead(206, { ...headers, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}` });
			createReadStream(file, { start, end }).pipe(res);
			return true;
		},
	};
}

function status(code, message) {
	return Object.assign(new Error(message), { status: code });
}
