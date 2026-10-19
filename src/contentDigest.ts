const HEX_DIGITS = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		hex += HEX_DIGITS[byte >> 4] + HEX_DIGITS[byte & 0x0f];
	}
	return hex;
}

export async function sha256Hex(content: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", content);
	return bytesToHex(new Uint8Array(digest));
}
