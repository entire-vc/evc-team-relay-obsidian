/**
 * Disposable relay for the M3 scenario: a loopback-only y-protocols server.
 *
 * Stands in for the relay-server (an external boundary), nothing else. It
 * speaks the same framing the client's YSweetProvider does (varuint message
 * type + y-protocols sync payload) over a hand-written RFC 6455 upgrade, so
 * the plugin side runs real sockets and the real provider. Holds one Y.Doc per
 * room in memory and counts completed syncs per connection, so the scenario
 * can assert that the pull ran on two distinct, completed connections.
 */

import * as http from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MESSAGE_SYNC = 0;

interface Peer {
	socket: Duplex;
	room: string;
	id: number;
	buffer: Buffer;
	syncCompleted: boolean;
}

function frame(opcode: number, payload: Uint8Array): Buffer {
	const n = payload.length;
	const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536
		? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff])
		: (() => {
				const b = Buffer.alloc(10);
				b[0] = 0x80 | opcode;
				b[1] = 127;
				b.writeBigUInt64BE(BigInt(n), 2);
				return b;
			})();
	return Buffer.concat([head, payload]);
}

export class DisposableRelay {
	private readonly server = http.createServer((_req, res) => {
		res.writeHead(404).end();
	});
	private readonly docs = new Map<string, Y.Doc>();
	private readonly peers = new Set<Peer>();
	private nextId = 1;
	/** Connections that completed a sync (relay answered a state vector), per room. */
	readonly completedSyncs = new Map<string, number>();
	/** Every upgrade attempt the relay saw, accepted or not. */
	upgrades = 0;
	origin = "";

	constructor(readonly token: string) {
		this.server.on("upgrade", (req, socket: Duplex) => this.onUpgrade(req, socket));
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		const addr = this.server.address();
		if (addr === null || typeof addr === "string") throw new Error("relay has no port");
		this.origin = `ws://127.0.0.1:${addr.port}`;
	}

	async stop(): Promise<void> {
		for (const p of this.peers) p.socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	room(name: string): Y.Doc {
		let doc = this.docs.get(name);
		if (!doc) {
			doc = new Y.Doc();
			this.docs.set(name, doc);
		}
		return doc;
	}

	/** Drop every open socket of a room (a relay restart / network loss); state stays. */
	dropConnections(room: string): void {
		for (const p of [...this.peers]) if (p.room === room) p.socket.destroy();
	}

	private onUpgrade(req: http.IncomingMessage, socket: Duplex): void {
		this.upgrades++;
		const url = new URL(req.url ?? "/", "http://relay.local");
		const key = req.headers["sec-websocket-key"];
		if (url.searchParams.get("token") !== this.token || typeof key !== "string") {
			socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			return;
		}
		const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		const room = decodeURIComponent(url.pathname.replace(/^\//, ""));
		const peer: Peer = { socket, room, id: this.nextId++, buffer: Buffer.alloc(0), syncCompleted: false };
		this.peers.add(peer);
		const doc = this.room(room);
		const onUpdate = (update: Uint8Array, origin: unknown) => {
			if (origin === peer) return;
			const enc = encoding.createEncoder();
			encoding.writeVarUint(enc, MESSAGE_SYNC);
			syncProtocol.writeUpdate(enc, update);
			this.send(peer, encoding.toUint8Array(enc));
		};
		doc.on("update", onUpdate);
		socket.on("data", (chunk: Buffer) => {
			peer.buffer = Buffer.concat([peer.buffer, chunk]);
			this.drain(peer, doc);
		});
		const gone = () => {
			doc.off("update", onUpdate);
			this.peers.delete(peer);
		};
		socket.on("close", gone);
		socket.on("error", gone);
		const enc = encoding.createEncoder();
		encoding.writeVarUint(enc, MESSAGE_SYNC);
		syncProtocol.writeSyncStep1(enc, doc);
		this.send(peer, encoding.toUint8Array(enc));
	}

	private send(peer: Peer, payload: Uint8Array): void {
		if (!peer.socket.destroyed) peer.socket.write(frame(0x2, payload));
	}

	private drain(peer: Peer, doc: Y.Doc): void {
		for (;;) {
			const b = peer.buffer;
			if (b.length < 2) return;
			const opcode = b[0] & 0x0f;
			const masked = (b[1] & 0x80) !== 0;
			let len = b[1] & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (b.length < 4) return;
				len = b.readUInt16BE(2);
				offset = 4;
			} else if (len === 127) {
				if (b.length < 10) return;
				len = Number(b.readBigUInt64BE(2));
				offset = 10;
			}
			const total = offset + (masked ? 4 : 0) + len;
			if (b.length < total) return;
			const payload = Buffer.from(b.subarray(offset + (masked ? 4 : 0), total));
			if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= b[offset + (i % 4)];
			peer.buffer = b.subarray(total);
			if (opcode === 0x8) {
				peer.socket.end(frame(0x8, new Uint8Array(0)));
				return;
			}
			if (opcode === 0x9) peer.socket.write(frame(0xa, payload));
			if (opcode === 0x2) this.onMessage(peer, doc, payload);
		}
	}

	private onMessage(peer: Peer, doc: Y.Doc, payload: Uint8Array): void {
		const decoder = decoding.createDecoder(payload);
		if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return; // awareness etc.: not relayed
		const enc = encoding.createEncoder();
		encoding.writeVarUint(enc, MESSAGE_SYNC);
		const type = syncProtocol.readSyncMessage(decoder, enc, doc, peer);
		if (encoding.length(enc) > 1) this.send(peer, encoding.toUint8Array(enc));
		if (type === syncProtocol.messageYjsSyncStep1 && !peer.syncCompleted) {
			peer.syncCompleted = true;
			this.completedSyncs.set(peer.room, (this.completedSyncs.get(peer.room) ?? 0) + 1);
		}
	}
}
