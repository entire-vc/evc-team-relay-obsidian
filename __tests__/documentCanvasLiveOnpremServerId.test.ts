/**
 * Regression test for (hardening follow-up to /):
 * Document and CanvasDocument used to capture `onpremServerId` once, as a constructor
 * argument passed straight through to `ProviderBacked`, instead of reading it
 * live off their parent VaultShare the way VaultShare itself already
 * does (see the doc comment on `ProviderBacked.getOnpremServerId()`).
 *
 * `onpremServerId` is assigned to a VaultShare's config AFTER the folder
 * (and its documents) are constructed at some call sites — a document built
 * before that assignment would otherwise be permanently pinned to whatever
 * value existed at construction time (usually `undefined`, i.e. the default
 * server), even after the folder is later attributed to a specific on-prem
 * server. `getOnpremServerId()` is the single seam both classes route every
 * token request through, so asserting on it directly (rather than driving a
 * full `getProviderToken()` call, which needs a real ResourceAddress/tokenStore/vault)
 * exercises exactly the fixed code path.
 *
 * Duck-typed via `Object.create(...Prototype)` rather than a real
 * `new Document(...)`/`new CanvasDocument(...)`, matching the existing convention in
 * syncDocumentWebsocketOrdering.test.ts — a full construction needs the
 * entire VaultShare/vault/IndexedDB machinery this test has no interest in.
 */

import { describe, test, expect } from "@jest/globals";
import { Document } from "../src/Document";
import { CanvasDocument } from "../src/CanvasDocument";

describe("Document/CanvasDocument read onpremServerId live off their parent, not captured at construction", () => {
	test("Document.getOnpremServerId() reflects a value assigned to the parent AFTER construction", () => {
		const parentSettings: { onpremServerId?: string } = { onpremServerId: undefined };
		const fakeDoc = Object.create(Document.prototype) as Document;
		Object.defineProperty(fakeDoc, "_parent", {
			value: { config: parentSettings },
		});

		// At "construction" time the folder isn't yet attributed to a server.
		expect(
			(fakeDoc as unknown as { getOnpremServerId(): string | undefined }).getOnpremServerId(),
		).toBeUndefined();

		// Assigned only AFTER the document exists — exactly the ordering the
		// real createShare()/share-attribution call sites produce.
		parentSettings.onpremServerId = "server-b";

		expect(
			(fakeDoc as unknown as { getOnpremServerId(): string | undefined }).getOnpremServerId(),
		).toBe("server-b");
	});

	test("CanvasDocument.getOnpremServerId() reflects a value assigned to the parent AFTER construction", () => {
		const parentSettings: { onpremServerId?: string } = { onpremServerId: undefined };
		const fakeCanvas = Object.create(CanvasDocument.prototype) as CanvasDocument;
		Object.defineProperty(fakeCanvas, "_parent", {
			value: { config: parentSettings },
		});

		expect(
			(
				fakeCanvas as unknown as { getOnpremServerId(): string | undefined }
			).getOnpremServerId(),
		).toBeUndefined();

		parentSettings.onpremServerId = "server-b";

		expect(
			(
				fakeCanvas as unknown as { getOnpremServerId(): string | undefined }
			).getOnpremServerId(),
		).toBe("server-b");
	});
});
