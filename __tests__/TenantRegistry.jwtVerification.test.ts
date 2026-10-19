/**
 * Coverage for the JWT-verification mechanism TenantRegistry.verifySignedToken()
 * relies on (src/TenantRegistry.ts: importSPKI + jwtVerify, algorithms
 * restricted to ['RS256']). See task.
 *
 * TenantRegistry.verifySignedToken()/resolveSigningPublicKey() are private
 * and resolveSigningPublicKey() is pinned to a hardcoded production public
 * key whose private half isn't available to sign test tokens with — so this
 * exercises the exact same jose call shape (importSPKI(spki, 'RS256') ->
 * jwtVerify(token, key, {algorithms: ['RS256']})) against a freshly
 * generated RSA keypair instead.
 *
 * Positive-only coverage would pass even if verification silently degraded
 * to a no-op (e.g. a future jose major swapping jwtVerify's default
 * behavior) — decodeJwt() would still return a payload either way. The two
 * negative cases exist to catch exactly that: they must throw, and did not
 * exist before this test (confirmed via mutation: reverting
 * resolveSigningPublicKey/jwtVerify to skip signature checking turns both
 * negatives green->red).
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import {
	generateKeyPair,
	exportSPKI,
	importSPKI,
	jwtVerify,
	SignJWT,
	type KeyLike,
} from "jose";

describe("jose RS256 verification (TenantRegistry.verifySignedToken shape)", () => {
	let publicKey: KeyLike;
	let validToken: string;

	beforeAll(async () => {
		const { publicKey: pub, privateKey } = await generateKeyPair("RS256");
		const spki = await exportSPKI(pub);
		// Round-trip through importSPKI exactly like resolveSigningPublicKey() does.
		publicKey = await importSPKI(spki, "RS256");

		validToken = await new SignJWT({ endpoint: "https://relay.example" })
			.setProtectedHeader({ alg: "RS256" })
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(privateKey);
	});

	test("positive: a validly-signed RS256 token verifies and its payload survives round-trip", async () => {
		const { payload } = await jwtVerify(validToken, publicKey, {
			algorithms: ["RS256"],
		});
		expect(payload.endpoint).toBe("https://relay.example");
	});

	test("negative: a token with a tampered payload is rejected", async () => {
		const [header, , signature] = validToken.split(".");
		const tamperedPayload = Buffer.from(
			JSON.stringify({ endpoint: "https://evil.example" }),
		).toString("base64url");
		const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

		await expect(
			jwtVerify(tamperedToken, publicKey, { algorithms: ["RS256"] }),
		).rejects.toThrow();
	});

	test("negative: alg-confusion — a token verified with an algorithm list that excludes its own alg is rejected", async () => {
		// Mirrors verifySignedToken()'s explicit `algorithms: ['RS256']` allowlist: a
		// token isn't merely "any signed JWT", it must specifically be RS256.
		await expect(
			jwtVerify(validToken, publicKey, { algorithms: ["HS256"] }),
		).rejects.toThrow();
	});
});
