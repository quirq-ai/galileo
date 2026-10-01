#!/usr/bin/env node
/**
 * Runs the sample app, twice (a live build and a dev build), and galileo with
 * two apps registered:
 *
 *   http://localhost:4100/             galileo's home: every route, live, and how it works
 *   http://localhost:4100/launcher     the launcher: apps, versions, toolbar designs
 *   http://acme.localhost:4100/        Acme Notes, its default version (dev)
 *   http://dev.acme.localhost:4100/    Acme Notes, dev build on :4174
 *   http://live.acme.localhost:4100/   Acme Notes, live build on :4173
 *   http://acme.localhost:4100/live    picks the live version by path
 *   http://xo.localhost:4100/          whatever serves :3000 (xo-client, when it runs)
 *
 * http://localhost:4173 is Acme Notes as its own server sends it: no toolbar,
 * and it refuses to be framed.
 *
 * PORT, SAMPLE_PORT and SAMPLE_DEV_PORT pick other ports. A sample port that
 * is taken falls back to a free one, so two demos can run at once.
 * XO_GATEWAY_DATA keeps a demo's data somewhere other than data/: two demos
 * must not share it, because each rewrites its files whole.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGateway, logApp } from "./src/server.mjs";
import { createSampleApp } from "./sample-app/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const gatewayPort = Number(process.env.PORT ?? 4100);
const dataDir = process.env.XO_GATEWAY_DATA ? path.resolve(HERE, process.env.XO_GATEWAY_DATA) : undefined;

const livePort = await listen(createSampleApp({ build: "live" }), Number(process.env.SAMPLE_PORT ?? 4173));
console.log(`[sample-app] Acme Notes, live build, as served: http://localhost:${livePort}`);
const devPort = await listen(createSampleApp({ build: "dev" }), Number(process.env.SAMPLE_DEV_PORT ?? 4174));
console.log(`[sample-app] Acme Notes, dev build, as served: http://localhost:${devPort}`);

// The first version given for an app is its default, unless the launcher has since chosen another.
const gateway = createGateway({
	targets: [
		{ name: "acme", version: "dev", upstream: `http://127.0.0.1:${devPort}` },
		{ name: "acme", version: "live", upstream: `http://127.0.0.1:${livePort}` },
		{ name: "xo", version: "dev", upstream: "http://localhost:3000" },
	],
	dataDir,
});
gateway.server.listen(gatewayPort, "127.0.0.1", () => {
	console.log(`[galileo] home: http://localhost:${gatewayPort}/`);
	console.log(`[galileo] launcher: http://localhost:${gatewayPort}/launcher`);
	if (dataDir) console.log(`[gateway] data kept in ${dataDir}`);
	for (const target of gateway.registry.list()) logApp(target, gatewayPort);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => gateway.close().finally(() => process.exit(0)));
}

/** Listens on `port`, or on a free port when that one is taken; resolves to the port it got. */
function listen(server, port) {
	return new Promise((resolve, reject) => {
		const retry = (error) => {
			if (error.code !== "EADDRINUSE") return reject(error);
			console.log(`[sample-app] :${port} is taken, so a free port instead`);
			server.once("error", reject);
			server.listen(0, "127.0.0.1");
		};
		server.once("error", retry);
		server.once("listening", () => {
			server.off("error", retry);
			server.off("error", reject);
			resolve(server.address().port);
		});
		server.listen(port, "127.0.0.1");
	});
}
