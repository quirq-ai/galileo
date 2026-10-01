#!/usr/bin/env node
/**
 * The demo: galileo with one source of each shape.
 *
 *   http://localhost:4100/             telescope: the Sources page
 *   http://localhost:4100/s/acme/      Acme Notes, a sample app on a port, under the bar
 *   http://localhost:4100/s/site/      the same site's files, read only: a folder
 *   http://localhost:4100/s/readme/    galileo's README: a single file
 *
 * Acme Notes sends the headers a careful production app sends (X-Frame-Options
 * DENY and a strict nonce policy): the hardest case for framing it and for
 * telescope's bridge. http://localhost:4173/ is Acme Notes as its own server
 * sends it.
 *
 * PORT and SAMPLE_PORT pick other ports; a sample port that is taken falls back
 * to a free one. GALILEO_DATA keeps the demo's list of sources somewhere other
 * than data/.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGalileo, logSource } from "./src/server.mjs";
import { createSampleApp } from "./sample-app/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4100);
const dataDir = process.env.GALILEO_DATA ? path.resolve(HERE, process.env.GALILEO_DATA) : undefined;

const samplePort = await listen(createSampleApp(), Number(process.env.SAMPLE_PORT ?? 4173));
console.log(`[sample-app] Acme Notes, as its own server sends it: http://localhost:${samplePort}`);

const galileo = createGalileo({
	sources: [
		{ name: "acme", type: "port", port: samplePort },
		{ name: "site", type: "files", path: path.join(HERE, "sample-app", "public") },
		{ name: "readme", type: "files", path: path.join(HERE, "README.md") },
	],
	dataDir,
});
galileo.server.on("error", (error) => {
	if (error.code !== "EADDRINUSE") throw error;
	console.error(`[galileo] port ${port} is taken: try PORT=${port + 1} npm run demo`);
	process.exit(1);
});
galileo.server.listen(port, "127.0.0.1", () => {
	console.log(`[galileo] http://localhost:${port}/ telescope: the Sources page, and every source under its bar`);
	if (dataDir) console.log(`[galileo] sources kept in ${dataDir}`);
	for (const source of galileo.sources.list()) logSource(source, port);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => galileo.close().finally(() => process.exit(0)));
}

/** Listens on `port`, or on a free port when that one is taken; resolves to the port it got. */
function listen(server, wanted) {
	return new Promise((resolve, reject) => {
		const retry = (error) => {
			if (error.code !== "EADDRINUSE") return reject(error);
			console.log(`[sample-app] :${wanted} is taken, so a free port instead`);
			server.once("error", reject);
			server.listen(0, "127.0.0.1");
		};
		server.once("error", retry);
		server.once("listening", () => {
			server.off("error", retry);
			server.off("error", reject);
			resolve(server.address().port);
		});
		server.listen(wanted, "127.0.0.1");
	});
}
