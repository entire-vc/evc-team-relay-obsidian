// Loose (recursive, own+inherited enumerable keys) comparison of two objects.
export function deepValueEquals(obj1: unknown, obj2: unknown): boolean {
	if (!obj1 || !obj2) return false;
	if (typeof obj1 !== "object" || typeof obj2 !== "object") return false;

	const a = obj1 as Record<string, unknown>;
	const b = obj2 as Record<string, unknown>;

	const valuesMatch = (key: string): boolean => {
		const av = a[key];
		return typeof av === "object" && av !== null
			? deepValueEquals(av, b[key])
			: av === b[key];
	};

	for (const key in a) {
		if (!valuesMatch(key)) return false;
	}
	for (const key in b) {
		if (!(key in a)) return false;
	}

	return true;
}
