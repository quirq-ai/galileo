/**
 * galileo as a library: `createGalileo()` returns its server, not yet
 * listening, and the handlers it is made of (`handle`, `upgrade`), for tests
 * and for a program that starts galileo itself.
 */
export { createGalileo, logSource } from "./src/server.mjs";
export { parseLocation, parseSourceSpec, sourceUrl } from "./src/sources.mjs";
