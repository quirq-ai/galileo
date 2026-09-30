/**
 * Which local servers are listening, and from which folder. Read with lsof
 * (macOS and Linux); where lsof is missing, nothing is found and the gateway
 * starts its own servers instead.
 */
import { execFile } from "node:child_process";
import http from "node:http";

const LSOF_TIMEOUT_MS = 4000;

/** Listening TCP sockets: [{ pid, host, port }], for every process or only the given process group. */
export async function listListeners({ group } = {}) {
	const args = ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"];
	if (group) args.unshift("-a", "-g", String(group));
	const output = await lsof(args);
	const found = [];
	let pid = 0;
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n")) {
			const match = /^(.*):(\d+)$/.exec(line.slice(1));
			if (match && pid) found.push({ pid, host: match[1], port: Number(match[2]) });
		}
	}
	return found;
}

/** Each process's working directory. */
export async function workingDirectories(pids) {
	const unique = [...new Set(pids)].filter(Boolean);
	if (!unique.length) return new Map();
	const output = await lsof(["-a", "-d", "cwd", "-p", unique.join(","), "-Fpn"]);
	const found = new Map();
	let pid = 0;
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid) found.set(pid, line.slice(1));
	}
	return found;
}

function lsof(args) {
	return new Promise((resolve) => {
		execFile("lsof", args, { timeout: LSOF_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
			// lsof exits 1 when nothing matches; a missing lsof leaves nothing to report.
			resolve(typeof stdout === "string" ? stdout : "");
		});
	});
}

/** The loopback address a listener answers on: IPv6 for `[::1]`, else IPv4. */
export function loopbackFor(host) {
	return host === "[::1]" ? "[::1]" : "127.0.0.1";
}

/** Whether an HTTP server answers at `origin` (any status counts), within `timeoutMs`. */
export function answers(origin, timeoutMs = 600) {
	return new Promise((resolve) => {
		const url = new URL(origin);
		const req = http.request(
			{ hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port, method: "HEAD", path: "/", timeout: timeoutMs },
			(res) => {
				res.resume();
				resolve(true);
			},
		);
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(false));
		req.end();
	});
}
