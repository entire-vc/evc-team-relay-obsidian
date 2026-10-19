// Grouped by MIME type (one entry can cover several extensions) rather than
// one row per extension — flattened into a lookup map below.
const EXTENSIONS_BY_MIME: ReadonlyArray<readonly [string, readonly string[]]> = [
	["text/markdown", ["md"]],
	["text/plain", ["txt"]],
	["application/json", ["json"]],
	["application/javascript", ["js"]],
	["application/typescript", ["ts"]],
	["text/html", ["html"]],
	["text/css", ["css"]],
	["image/png", ["png"]],
	["image/jpeg", ["jpg", "jpeg"]],
	["image/gif", ["gif"]],
	["image/svg+xml", ["svg"]],
	["application/pdf", ["pdf"]],
	["application/canvas+json", ["canvas"]],
	["image/webp", ["webp"]],
	["image/avif", ["avif"]],
	["image/bmp", ["bmp"]],
	["audio/mpeg", ["mp3"]],
	["audio/wav", ["wav"]],
	["audio/x-m4a", ["m4a"]],
	["audio/flac", ["flac"]],
	["audio/ogg", ["ogg", "oga"]],
	["audio/opus", ["opus"]],
	["video/mp4", ["mp4"]],
	["video/webm", ["webm"]],
	["video/ogg", ["ogv"]],
	["video/quicktime", ["mov"]],
	["video/x-matroska", ["mkv"]],
	["video/3gpp", ["3gp"]],
];

const EXTENSION_TO_MIME = new Map<string, string>(
	EXTENSIONS_BY_MIME.flatMap(([mime, extensions]) =>
		extensions.map((extension) => [extension, mime] as const),
	),
);

const DEFAULT_MIME_TYPE = "application/octet-stream";

export function mimeTypeForPath(filename: string): string {
	const extension = filename.split(".").pop()?.toLowerCase() ?? "";
	return EXTENSION_TO_MIME.get(extension) ?? DEFAULT_MIME_TYPE;
}
