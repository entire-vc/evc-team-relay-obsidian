/**
 * Obsidian API stand-in for the LIVE harness (__tests__/live/*.test.ts).
 *
 * The Obsidian app API is a TRUE external boundary —
 * it is not the thing under test and cannot be run headless. Everything else
 * in the live harness is real: the relay-server, the control-plane, the HTTP
 * calls, the websockets and the tokens.
 *
 * The one member that matters here is `requestUrl`. In `__tests__/mocks/
 * obsidian.ts` it is a bare `jest.fn()` returning undefined, which is correct
 * for unit tests but would make `src/platformFetch.ts` a no-op — and platformFetch
 * is on the path under test (it is what RelayOnPremAuthProvider,
 * RelayOnPremTokenProvider and RelayOnPremShareClient issue every request
 * through). So here `requestUrl` is a thin adapter over Node's real `fetch`:
 * real sockets, real bytes, real status codes. Nothing is faked; the shape is
 * translated from Obsidian's RequestUrlResponse to fetch's Response, which is
 * exactly what the real Obsidian implementation does.
 *
 * Every other export is re-exported unchanged from the shared unit-test mock
 * so the two stay in step.
 */

export {
	debounce,
	Platform,
	normalizePath,
	TFile,
	TFolder,
	Vault,
	Notice,
	noticeMock,
} from "../mocks/obsidian";
export type { RequestUrlParam, RequestUrlResponse } from "../mocks/obsidian";

import type { RequestUrlParam, RequestUrlResponse } from "../mocks/obsidian";

/**
 * Real network implementation of Obsidian's `requestUrl`.
 *
 * Contract points src/platformFetch.ts depends on:
 *  - never throws on a non-2xx status (platformFetch always passes `throw:false`);
 *  - `headers` is a plain Record<string,string> (platformFetch feeds it to `new Headers()`);
 *  - `text` is the decoded body (platformFetch's `toFetchResponse` re-parses it for `.json()`);
 *  - `arrayBuffer.byteLength === 0` signals an empty body.
 */
export const requestUrl = async (
	param: RequestUrlParam,
): Promise<RequestUrlResponse> => {
	const response = await fetch(param.url, {
		method: param.method ?? "GET",
		headers: param.headers,
		body: param.body as BodyInit | undefined,
	});

	const arrayBuffer = await response.arrayBuffer();
	const text = new TextDecoder().decode(arrayBuffer);

	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});

	return {
		status: response.status,
		headers,
		arrayBuffer,
		text,
		get json() {
			return JSON.parse(text) as unknown;
		},
	};
};
