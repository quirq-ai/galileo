/**
 * telescope's server side, for the host that carries it (galileo):
 *
 *   createTelescope  what telescope keeps, and its routes under `/__xo/`
 *   inject           which responses carry telescope's tag, and how their headers change
 *
 * The browser side, its bundles and design schema, is `../index.mjs`.
 */
export { createTelescope } from "./api.mjs";
export {
	LOADER_PATH,
	SKIP_HEADER,
	SKIP_PARAM,
	XO_PREFIX,
	loaderTag,
	responseHeaders,
	shouldInject,
	upstreamRequestHeaders,
} from "./inject.mjs";
