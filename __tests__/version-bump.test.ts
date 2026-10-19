import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Real script, real files, real subprocess — the whole point of this tool is
// what bytes land on disk, which a mocked fs would hide. The only external
// boundary here is the OS filesystem, and this test crosses it deliberately.
function runVersionBump(targetVersion: string, seed: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "version-bump-test-"));
	for (const [name, content] of Object.entries(seed)) {
		writeFileSync(join(dir, name), content);
	}
	try {
		execFileSync("node", [join(__dirname, "..", "version-bump.mjs")], {
			cwd: dir,
			env: { ...process.env, npm_package_version: targetVersion },
		});
		return {
			manifest: readFileSync(join(dir, "manifest.json"), "utf8"),
			versions: readFileSync(join(dir, "versions.json"), "utf8"),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const SEED = {
	"manifest.json": '{\n  "id": "team-relay",\n  "version": "0.0.6",\n  "minAppVersion": "1.13.0"\n}\n',
	"versions.json": '{\n\t"0.0.5": "1.13.0",\n\t"0.0.6": "1.13.0"\n}\n',
};

test("bumps manifest.json and versions.json to the target version", () => {
	const { manifest, versions } = runVersionBump("0.0.7", SEED);
	expect(JSON.parse(manifest).version).toBe("0.0.7");
	expect(JSON.parse(versions)["0.0.7"]).toBe("1.13.0");
});

test("preserves manifest.json's 2-space indent and trailing newline — a full reformat is the regression this guards", () => {
	const { manifest } = runVersionBump("0.0.7", SEED);
	expect(manifest).toBe('{\n  "id": "team-relay",\n  "version": "0.0.7",\n  "minAppVersion": "1.13.0"\n}\n');
});

test("preserves versions.json's tab indent and trailing newline", () => {
	const { versions } = runVersionBump("0.0.7", SEED);
	expect(versions).toBe('{\n\t"0.0.5": "1.13.0",\n\t"0.0.6": "1.13.0",\n\t"0.0.7": "1.13.0"\n}\n');
});
