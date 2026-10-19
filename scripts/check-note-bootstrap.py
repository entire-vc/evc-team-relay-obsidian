#!/usr/bin/env python3
"""Exercise note creation in two disposable, authenticated Obsidian vaults.

Requires websocket-client, two Obsidian CDP ports, and one shared-folder GUID.
The driver creates a new note through the Vault API, types four updates, and
checks both the receiver's disk and its child CRDT. Run only on test vaults.
It never repairs a share or calls an upload method to make the test pass.
"""

import argparse
import hashlib
import json
import time
import urllib.request
import uuid

import websocket


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class Client:
    def __init__(self, port):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=5) as response:
            targets = json.load(response)
        target = next(t for t in targets if t["type"] == "page" and "obsidian.md" in t["url"])
        self.socket = websocket.create_connection(
            target["webSocketDebuggerUrl"], suppress_origin=True, timeout=20
        )
        self.sequence = 0

    def evaluate(self, expression):
        self.sequence += 1
        self.socket.send(json.dumps({
            "id": self.sequence, "method": "Runtime.evaluate",
            "params": {"expression": expression, "awaitPromise": True, "returnByValue": True},
        }))
        while True:
            result = json.loads(self.socket.recv())
            if result.get("id") != self.sequence:
                continue
            if "error" in result or "exceptionDetails" in result.get("result", {}):
                raise RuntimeError("Obsidian evaluation failed; inspect the test vault console")
            return result["result"]["result"].get("value")

    def close(self):
        self.socket.close()


def state(client, guid, note):
    return client.evaluate("""(async (guid, note) => {
        const p = app.plugins.plugins['team-relay'];
        const s = p.shareRegistry.locate(s => s.entityGuid === guid);
        if (!s) throw new Error('Shared folder missing');
        const path = s.path + '/' + note;
        const children = [...s.trackedEntries.values()].filter(d => d.entryPath === '/' + note || d.entryPath === note);
        return {
            version: p.manifest.version, guid: s.entityGuid, path: s.path,
            online: s.isOnline, started: Number.isFinite(p.startupDurationMs),
            otherTypes: s.attachmentSettings.readValue().otherTypes,
            claims: s.crdtDoc.getMap('uploadClaims').toJSON(),
            metadata: s.crdtDoc.getMap('filemeta_v0').toJSON(),
            children: children.map(d => ({guid: d.entityGuid, text: d.content})),
            disk: await app.vault.adapter.exists(path) ? await app.vault.adapter.read(path) : null,
            conflictCopies: app.vault.getFiles().filter(f =>
                f.path.startsWith(path.slice(0, -3) + ' (relay conflict ') && f.path.endsWith('.md')
            ).map(f => ({path: f.path, bytes: f.stat.size})),
        };
    })(""" + json.dumps(guid) + "," + json.dumps(note) + ")")


def run(args):
    a, b = Client(args.writer_port), None
    try:
        b = Client(args.reader_port)
        initial = [state(c, args.guid, args.note) for c in [a, b]]
        for s in initial:
            require(s["version"] == args.version, "Unexpected plugin version")
            require(s["online"], "Folder must be online before creating the note")
            require(s["started"], "Restart Obsidian after enabling the plugin; startup must finish")
            require(s["otherTypes"] is False, "Run with the default otherTypes=false")
            require(s["disk"] is None, "Use a fresh note name; existing files are never overwritten")
        require(initial[0]["path"] != initial[1]["path"], "Use different local folder names")
        text = "New note bootstrap\n" + args.note + "\nUnicode: café, заметка\n"
        start = time.monotonic()
        a.evaluate("""(async (guid, note, text) => {
            const p = app.plugins.plugins['team-relay'];
            const s = p.shareRegistry.locate(s => s.entityGuid === guid);
            const f = await app.vault.create(s.path + '/' + note, '');
            for (let i = 1; i <= 4; i++) {
                await app.vault.modify(f, text.slice(0, Math.ceil(text.length * i / 4)));
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        })(""" + ",".join(json.dumps(value) for value in [args.guid, args.note, text]) + ")")
        arrived = False
        settled = False
        first_arrival = None
        writer, reader = state(a, args.guid, args.note), state(b, args.guid, args.note)
        while time.monotonic() - start < args.timeout:
            writer, reader = state(a, args.guid, args.note), state(b, args.guid, args.note)
            arrived = (
                writer["disk"] == text and reader["disk"] == text
                and any(d["text"] == text and d["guid"] == writer["metadata"].get(args.note, {}).get("id") for d in writer["children"])
                and any(d["text"] == text and d["guid"] == reader["metadata"].get(args.note, {}).get("id") for d in reader["children"])
                and writer["metadata"].get(args.note, {}).get("id") == reader["metadata"].get(args.note, {}).get("id")
            )
            if arrived and first_arrival is None:
                first_arrival = time.monotonic()
            if not arrived:
                first_arrival = None
            if arrived and time.monotonic() - first_arrival >= args.settle_seconds:
                settled = True
                break
            time.sleep(0.25)
        proof = {
            "version": args.version, "same_guid": writer["guid"] == reader["guid"],
            "local_folders": [writer["path"], reader["path"]],
            "otherTypes": [writer["otherTypes"], reader["otherTypes"]],
            "arrived": arrived, "settled": settled, "seconds": round(time.monotonic() - start, 2),
            "writer": writer, "reader": reader,
            "expected_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "no_conflict_copies": not (writer["conflictCopies"] or reader["conflictCopies"]),
        }
        print(json.dumps(proof, ensure_ascii=False, indent=2))
        require(arrived, "Note content was not published and received before the deadline")
        require(settled, "Note content did not remain stable for the requested settle window")
        if args.no_conflict_copies:
            require(proof["no_conflict_copies"], "Rapid edits created a conflict copy")
    finally:
        a.close()
        if b is not None:
            b.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--writer-port", type=int, required=True)
    parser.add_argument("--reader-port", type=int, required=True)
    parser.add_argument("--guid", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--note", required=True)
    parser.add_argument("--timeout", type=float, default=45)
    parser.add_argument("--no-conflict-copies", action="store_true", help="Fail if rapid edits produce a conflict copy")
    parser.add_argument("--settle-seconds", type=float, default=0, help="Observe stable final content before accepting it")
    options = parser.parse_args()
    uuid.UUID(options.guid)
    if not options.note.endswith('.md') or '/' in options.note or '\\' in options.note:
        parser.error("Use a Markdown filename without directory separators")
    if options.timeout <= 0:
        parser.error("Timeout must be positive")
    if not 0 <= options.settle_seconds < options.timeout:
        parser.error("Settle window must be nonnegative and shorter than the timeout")
    run(options)
