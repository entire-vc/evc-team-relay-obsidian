// Encodes/decodes the colon-delimited addresses this plugin uses to name a
// relay-hosted resource on the wire: "s3rn:<namespace>:<tag>:<value>[:<tag>:<value>...]".
// The leading "s3rn" segment is written but never read back — parse() discards it — kept
// only so the string self-describes on the wire (WIRE_PREFIX below is a wire-format
// literal, not a naming choice; changing its value would break every already-synced
// document that has one of these addresses persisted inside it). Confirmed nothing in
// this codebase reads a `.namespace`/`.platform` field off a decoded instance either:
// every caller only ever round-trips through ResourceAddress.serialize()/.parse(), never
// inspects the fields directly.

export type EntityId = string;

const WIRE_PREFIX = "s3rn";
const PRODUCT_RELAY = "relay";

export class ProductAddress {
	readonly namespace = PRODUCT_RELAY;
}

export class RelayAddress {
	readonly namespace = PRODUCT_RELAY;
	constructor(public relayGuid: EntityId) {}
}

export class RemoteFolderAddress {
	readonly namespace = PRODUCT_RELAY;
	constructor(
		public relayGuid: EntityId,
		public folderGuid: EntityId,
	) {}
}

export class RemoteDocumentAddress {
	readonly namespace = PRODUCT_RELAY;
	constructor(
		public relayGuid: EntityId,
		public folderGuid: EntityId,
		public documentGuid: EntityId,
	) {}
}

export class RemoteCanvasAddress {
	readonly namespace = PRODUCT_RELAY;
	constructor(
		public relayGuid: EntityId,
		public folderGuid: EntityId,
		public canvasGuid: EntityId,
	) {}
}

export class RemoteFileAddress {
	readonly namespace = PRODUCT_RELAY;
	constructor(
		public relayGuid: EntityId,
		public folderGuid: EntityId,
		public fileGuid: EntityId,
	) {}
}

export class FolderAddress {
	readonly namespace = PRODUCT_RELAY;
	constructor(public folderGuid: EntityId) {}
}

export class DocumentAddress {
	readonly namespace = PRODUCT_RELAY;
	constructor(
		public folderGuid: EntityId,
		public documentGuid: EntityId,
	) {}
}

export class CanvasAddress {
	readonly namespace = PRODUCT_RELAY;
	constructor(
		public folderGuid: EntityId,
		public canvasGuid: EntityId,
	) {}
}

export class FileAddress {
	readonly namespace = PRODUCT_RELAY;
	constructor(
		public folderGuid: EntityId,
		public fileGuid: EntityId,
	) {}
}

export type ResourceAddressType =
	| ProductAddress
	| RelayAddress
	| RemoteFolderAddress
	| RemoteDocumentAddress
	| RemoteCanvasAddress
	| RemoteFileAddress;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUUID(value: string | undefined): value is EntityId {
	return value !== undefined && UUID_RE.test(value);
}

function requireUUID(value: EntityId, what: string): EntityId {
	if (!isUUID(value)) {
		throw new Error(`Invalid ${what} UUID`);
	}
	return value;
}

export class ResourceAddress {
	static isValidUUID(uuid: EntityId): boolean {
		return isUUID(uuid);
	}

	static serialize(entity: ResourceAddressType): string {
		const segments = [WIRE_PREFIX, entity.namespace];

		if ("relayGuid" in entity) {
			// relayGuid can be a UUID or a string identifier (e.g., "relay-onprem")
			if (!entity.relayGuid) {
				throw new Error("Invalid relay ID");
			}
			segments.push("relay", entity.relayGuid);
		}
		if ("folderGuid" in entity) {
			segments.push("folder", requireUUID(entity.folderGuid, "folder"));
		}
		if ("documentGuid" in entity) {
			segments.push("doc", requireUUID(entity.documentGuid, "document"));
		}
		if ("canvasGuid" in entity) {
			segments.push("canvas", requireUUID(entity.canvasGuid, "document"));
		}
		if ("fileGuid" in entity) {
			segments.push("file", requireUUID(entity.fileGuid, "document"));
		}

		return segments.join(":");
	}

	static parse(s3rn: string): ResourceAddressType {
		const parts = s3rn.split(":");
		if (parts.length < 3) {
			throw new Error("Invalid s3rn format");
		}

		const [, product, ...tail] = parts;
		const tags: string[] = [];
		const values: string[] = [];
		for (let i = 0; i < tail.length; i += 2) {
			tags.push(tail[i]);
			values.push(tail[i + 1]);
		}
		const [type0, type1, type2] = tags;
		const [item0, item1, item2] = values;

		const isRelayItem0 = type0 === "relay";
		if (!isRelayItem0 && !isUUID(item0)) {
			throw new Error("Invalid UUID");
		}
		if (item1 !== undefined && !isUUID(item1)) {
			throw new Error("Invalid UUID");
		}
		if (item2 !== undefined && !isUUID(item2)) {
			throw new Error("Invalid UUID");
		}

		const isRelay = product === "relay";
		if (isRelay && type0 === "relay" && type1 === "folder" && type2 === "doc") {
			return new RemoteDocumentAddress(item0, item1, item2);
		}
		if (isRelay && type0 === "relay" && type1 === "folder" && type2 === "canvas") {
			return new RemoteCanvasAddress(item0, item1, item2);
		}
		if (isRelay && type0 === "relay" && type1 === "folder" && type2 === "file") {
			return new RemoteFileAddress(item0, item1, item2);
		}
		if (isRelay && type0 === "relay" && type1 === "folder") {
			return new RemoteFolderAddress(item0, item1);
		}
		if (isRelay && type0 === "folder" && type1 === "document") {
			return new DocumentAddress(item0, item1);
		}
		if (isRelay && type0 === "folder" && type1 === "canvas") {
			return new CanvasAddress(item0, item1);
		}
		if (isRelay && type0 === "folder") {
			return new FolderAddress(item0);
		}
		if (isRelay && type0 === "relay") {
			return new RelayAddress(item0);
		}
		if (type0 === undefined) {
			return new ProductAddress();
		}

		throw new Error("Invalid s3rn format for the given product type");
	}
}
