/**
 * Renders a price the way the currency is actually written, not the way the
 * interface language happens to be set.
 *
 * The rule this file exists to enforce: **the symbol follows the currency of
 * the price, never the language of the UI.** A RUB price renders `290 ₽` even
 * when Obsidian's interface is English -- a Russian buyer must not be shown
 * `RUB290` because of an interface setting. (Decided on the parent task
 * ``; do not re-litigate per-caller.)
 *
 * What it replaces: `const sym = currency === "USD" ? "$" : currency`, which
 * printed the literal ISO code glued to the number (`RUB290`). That is not a
 * price notation in any language, and it was the string about to be shown to
 * a bank.
 *
 * Deliberately NOT `Intl.NumberFormat`: its `ru-RU` group separator is a
 * NO-BREAK SPACE (U+00A0), and the already-approved price copy on
 * teamrelay.ru uses a plain space (U+0020) -- verified byte-by-byte against
 * `src/pages/pricing/index.astro` in the site repo: `'2 790 ₽'` is
 * `32 20 37 39 30 20 20BD`. Since the plugin's prices sit next to the site's
 * in the same purchase decision, they must match the site exactly rather
 * than match a locale database. Intl output also varies with the ICU build
 * shipped in whatever Electron the user's Obsidian is on; this does not.
 *
 * No i18n dependency on purpose -- this module formats the *amount* only.
 * The `/mo` vs `/мес` suffix is interface language, not currency, so it is
 * composed by the caller from the phrasebook (`billing.period.*`).
 */

const MINOR_UNITS_PER_MAJOR = 100;

interface CurrencyPresentation {
	symbol: string;
	/**
	 * `before` renders tight (`$9` -- the US convention, and the exact bytes
	 * the entire.vc contour already ships). `after` renders with a plain
	 * space (`290 ₽` -- the Russian convention and the site's own copy).
	 * The spacing is part of the position, not a separate knob, because no
	 * real currency wants `$ 9` or `290₽`.
	 */
	symbolPosition: "before" | "after";
	/** Empty string = no thousands grouping at all. */
	groupSeparator: string;
}

const CURRENCY_PRESENTATION: Record<string, CurrencyPresentation> = {
	// Grouping left OFF for USD/EUR on purpose: it preserves the entire.vc
	// contour's existing output byte-for-byte (`$9`), and no plan there is
	// four digits. Turning it on is a visible change to a second product's
	// pricing screen and belongs to whoever owns that screen, not here.
	USD: { symbol: "$", symbolPosition: "before", groupSeparator: "" },
	EUR: { symbol: "€", symbolPosition: "before", groupSeparator: "" },
	RUB: { symbol: "₽", symbolPosition: "after", groupSeparator: " " },
};

/** `2790` -> `2 790`. No-op when the currency asks for no grouping. */
function groupThousands(digits: string, separator: string): string {
	if (!separator) return digits;
	return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Formats a minor-unit amount (the wire format: 29000 = 290.00) as the price
 * string a human reads.
 *
 * Rounds to whole major units, exactly as the code this replaced did -- every
 * plan in both catalogues is priced in whole rubles/dollars, and silently
 * growing a `,00` tail onto them would be a visible copy change, not a fix.
 *
 * An unrecognised currency falls back to `290 GBP` -- ISO code AFTER the
 * number, with a space. That is the international fallback notation and it
 * stays readable; the old `${code}${amount}` shape is the bug itself and must
 * not survive anywhere as a fallback.
 */
export function formatAmount(amountMinor: number, currency: string): string {
	const code = (currency || "").trim().toUpperCase();
	const major = (amountMinor / MINOR_UNITS_PER_MAJOR).toFixed(0);

	const spec = CURRENCY_PRESENTATION[code];
	if (!spec) return code ? `${major} ${code}` : major;

	const grouped = groupThousands(major, spec.groupSeparator);
	return spec.symbolPosition === "before"
		? `${spec.symbol}${grouped}`
		: `${grouped} ${spec.symbol}`;
}
