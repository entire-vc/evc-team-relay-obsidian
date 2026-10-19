type PathConverter = (globalPath: string, rootPath: string) => string;

const defaultPathConverter: PathConverter = (globalPath, rootPath) =>
	globalPath.substring(rootPath.length).replace(/^\/+/, "");

function wrapWithPathConversion(
	fn: (...a: unknown[]) => unknown,
	target: unknown,
	rootPath: string,
	convert: PathConverter,
) {
	return (...args: unknown[]) => {
		const [first, ...rest] = args;
		const converted =
			typeof first === "string" ? [convert(first, rootPath), ...rest] : args;
		return fn.apply(target, converted);
	};
}

export function withRootRelativePaths<T extends object>(
	target: T,
	rootPath: string,
	pathConverter: PathConverter = defaultPathConverter,
): T {
	return new Proxy(target, {
		get(obj, prop) {
			const value = (obj as Record<string | symbol, unknown>)[prop];
			if (typeof value !== "function") return value;
			return wrapWithPathConversion(
				value as (...a: unknown[]) => unknown,
				obj,
				rootPath,
				pathConverter,
			);
		},
	});
}
