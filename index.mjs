/**
 * galileo as a library, for a server that mounts it on its own port, as
 * xo-client does. `createGateway()` returns `owns(req)`, `handle(req, res)`
 * and `upgrade(req, socket, head)`; the server hands the gateway whatever it
 * owns and answers everything else itself.
 */
export { createGateway, logApp } from "./src/server.mjs";
export { appUrl, ownsRequest, parseTargetSpec } from "./src/targets.mjs";
