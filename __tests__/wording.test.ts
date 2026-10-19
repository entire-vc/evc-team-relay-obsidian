import { getLanguage } from "obsidian";
import { uiText } from "../src/wording/uiText";
import { resolveInterfaceLanguage } from "../src/wording/interfaceLanguage";
import {
	englishPhrasebook,
	ruPhrasebook,
	phrasebooksByLanguage,
	type PhraseKey,
	type Phrasebook,
} from "../src/wording/phrasebook";

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;
function placeholderNames(template: string): string[] {
	return [...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]).sort();
}

// getLanguage's ambient type (from obsidian.d.ts) is a plain `() => string` --
// the jest.fn() mock in __tests__/mocks/obsidian.ts is only a mock at
// runtime, not at the type level. Cast once, same convention as
// mockRequestUrl/mockFetch elsewhere in this test suite (platformFetch.test.ts,
// AgentKeysClient.test.ts), instead of calling .mockReturnValue() on the
// untyped import directly.
const mockGetLanguage = getLanguage as jest.MockedFunction<typeof getLanguage>;

describe("resolveInterfaceLanguage", () => {
	afterEach(() => {
		mockGetLanguage.mockReturnValue("en");
	});

	it("returns whatever Obsidian's getLanguage() reports", () => {
		mockGetLanguage.mockReturnValue("fr");
		expect(resolveInterfaceLanguage()).toBe("fr");
	});
});

describe("uiText", () => {
	afterEach(() => {
		mockGetLanguage.mockReturnValue("en");
	});

	it("returns the English phrase for the active (en) language", () => {
		mockGetLanguage.mockReturnValue("en");
		expect(uiText("shell.header.title")).toBe("Team Relay");
	});

	it("substitutes a {placeholder} from params", () => {
		expect(uiText("shareList.title", { serverName: "Acme HQ" })).toBe(
			"Shares on Acme HQ",
		);
	});

	it("substitutes multiple placeholders in one template", () => {
		expect(
			uiText("shareDetail.members.limitReachedNotice", {
				current: 5,
				max: 5,
				plan: "Free",
			}),
		).toBe(
			"Member limit reached (5/5 on Free plan). Upgrade your plan to add more members.",
		);
	});

	it("leaves an unmatched {placeholder} in place rather than throwing", () => {
		expect(uiText("shareList.title")).toBe("Shares on {serverName}");
	});

	it("drops a param that has no matching placeholder, without throwing", () => {
		expect(uiText("shell.header.title", { unused: "x" })).toBe("Team Relay");
	});

	// Negative control: a language for which we ship no phrasebook at all
	// must render English, not empty strings and not the raw key.
	it("falls back to English for a language with no phrasebook (e.g. German)", () => {
		mockGetLanguage.mockReturnValue("de");
		expect(uiText("shell.header.title")).toBe(
			englishPhrasebook["shell.header.title"],
		);
		expect(uiText("shell.header.title")).not.toBe("");
		expect(uiText("shell.header.title")).not.toBe("shell.header.title");
	});

	// The fallback logic itself -- a phrasebook that exists but is MISSING a
	// specific key must fall back to English for that key, not surface
	// `undefined`/the literal key name. Uses a fake stub dictionary (not
	// `ru`, which is complete -- see the "ruPhrasebook" describe block below
	// for real-language coverage) so this proves the mechanism works
	// independent of any one real phrasebook's completeness.
	describe("fallback for a real phrasebook with a missing key", () => {
		const FAKE_LANG = "xx-test-stub";
		const stub: Phrasebook = {
			"shell.header.title": "Stub Title",
			// "shell.header.desc" deliberately omitted -- the gap under test.
		};

		beforeEach(() => {
			phrasebooksByLanguage[FAKE_LANG] = stub;
			mockGetLanguage.mockReturnValue(FAKE_LANG);
		});

		afterEach(() => {
			delete phrasebooksByLanguage[FAKE_LANG];
		});

		it("uses the stub phrasebook's own translation when the key exists", () => {
			expect(uiText("shell.header.title")).toBe("Stub Title");
		});

		it("falls back to English -- not undefined, not empty, not the raw key -- for a key the stub omits", () => {
			const result = uiText("shell.header.desc");
			expect(result).toBe(englishPhrasebook["shell.header.desc"]);
			expect(result).not.toBe("");
			expect(result).not.toBe("shell.header.desc");
			expect(result).not.toBeUndefined();
		});
	});
});

describe("connect.login cross-server strings", () => {
	afterEach(() => {
		mockGetLanguage.mockReturnValue("en");
	});

	it("connect.login.title substitutes the server name", () => {
		expect(uiText("connect.login.title", { server: "Team Relay RU" })).toBe("Sign in to Team Relay RU");
	});

	it("connect.login.titleFallback carries the old generic text, for when no server name resolves", () => {
		expect(uiText("connect.login.titleFallback")).toBe("Relay on-premise login");
	});

	it("connect.login.separateAccountsNote substitutes both server names", () => {
		expect(
			uiText("connect.login.separateAccountsNote", {
				otherServer: "EVC Team Relay",
				thisServer: "Team Relay RU",
			})
		).toBe(
			"Accounts aren't shared between servers. A login from EVC Team Relay won't work here — you need an invite to Team Relay RU."
		);
	});

	it("connect.login.incorrectCredentialsCrossServer substitutes the other server's name", () => {
		expect(uiText("connect.login.incorrectCredentialsCrossServer", { otherServer: "Team Relay RU" })).toBe(
			"Incorrect email or password. Accounts aren't shared between servers — if that login is from Team Relay RU, it won't work here."
		);
	});
});

describe("englishPhrasebook", () => {
	it("has no empty-string values (every key resolves to real, non-blank text)", () => {
		const emptyKeys = Object.entries(englishPhrasebook)
			.filter(([, value]) => value.length === 0)
			.map(([key]) => key);
		expect(emptyKeys).toEqual([]);
	});
});

// MR2 -- ru phrasebook. Structural checks only: this suite proves
// the mechanism serves ru correctly and that ru's coverage/placeholders
// stay in lockstep with en as either evolves. It does NOT and cannot judge
// translation quality -- that's the human review this MR is gated on
//, not something a test asserts.
describe("ruPhrasebook", () => {
	it("has no empty-string values", () => {
		const emptyKeys = Object.entries(ruPhrasebook)
			.filter(([, value]) => value.length === 0)
			.map(([key]) => key);
		expect(emptyKeys).toEqual([]);
	});

	it("covers every key englishPhrasebook defines -- no silent gaps in Phase 1", () => {
		const enKeys = Object.keys(englishPhrasebook) as PhraseKey[];
		const missing = enKeys.filter((k) => !(k in ruPhrasebook));
		expect(missing).toEqual([]);
	});

	it("defines no key englishPhrasebook doesn't have -- no stray/renamed keys", () => {
		const enKeys = new Set(Object.keys(englishPhrasebook));
		const extra = Object.keys(ruPhrasebook).filter((k) => !enKeys.has(k));
		expect(extra).toEqual([]);
	});

	it("preserves the exact same {placeholder} set as English, for every key", () => {
		const mismatches: Array<{ key: string; en: string[]; ru: string[] }> = [];
		for (const key of Object.keys(englishPhrasebook) as PhraseKey[]) {
			const enPlaceholders = placeholderNames(englishPhrasebook[key]);
			const ruValue = ruPhrasebook[key];
			const ruPlaceholders = ruValue ? placeholderNames(ruValue) : [];
			if (JSON.stringify(enPlaceholders) !== JSON.stringify(ruPlaceholders)) {
				mismatches.push({ key, en: enPlaceholders, ru: ruPlaceholders });
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("is registered under the 'ru' ISO code in phrasebooksByLanguage", () => {
		expect(phrasebooksByLanguage["ru"]).toBe(ruPhrasebook);
	});
});

describe("uiText with the real ru phrasebook (not a stub)", () => {
	afterEach(() => {
		mockGetLanguage.mockReturnValue("en");
	});

	it("returns the Russian phrase when Obsidian reports ru", () => {
		mockGetLanguage.mockReturnValue("ru");
		expect(uiText("shell.header.title")).toBe("Team Relay");
		expect(uiText("shareDetail.members.heading")).toBe("Участники");
	});

	it("substitutes a {placeholder} in a Russian template", () => {
		mockGetLanguage.mockReturnValue("ru");
		expect(uiText("shareList.title", { serverName: "Acme HQ" })).toBe(
			"Общие доступы на Acme HQ",
		);
	});

	it("substitutes multiple placeholders in a Russian template", () => {
		mockGetLanguage.mockReturnValue("ru");
		expect(
			uiText("shareDetail.members.limitReachedNotice", {
				current: 5,
				max: 5,
				plan: "Free",
			}),
		).toBe(
			"Достигнут лимит участников (5/5 на тарифе Free). Обновите тариф, чтобы добавить больше участников.",
		);
	});
});

// -- billing screen. The period suffix is the half of a price that
// IS interface language (the currency symbol is not -- see
// __tests__/billingMoney.test.ts). Asserted here because a price reading
// "290 ₽/mo" would satisfy every currency test and still be half-English on
// the screen going to the bank.
describe("billing screen phrases", () => {
	afterEach(() => {
		mockGetLanguage.mockReturnValue("en");
	});

	it("renders the period suffixes in Russian", () => {
		mockGetLanguage.mockReturnValue("ru");
		expect(uiText("billing.period.month")).toBe("мес");
		expect(uiText("billing.period.year")).toBe("год");
	});

	// Positive control: the same two keys on the entire.vc contour.
	it("leaves the English period suffixes untouched", () => {
		mockGetLanguage.mockReturnValue("en");
		expect(uiText("billing.period.month")).toBe("mo");
		expect(uiText("billing.period.year")).toBe("yr");
	});

	it("translates storage units -- '3 GB' is an English word on a Russian screen", () => {
		mockGetLanguage.mockReturnValue("ru");
		expect(uiText("billing.bytes.gigabytes", { value: "3,0" })).toBe("3,0 ГБ");
		expect(uiText("billing.bytes.megabytes", { value: "500" })).toBe("500 МБ");
	});

	it("writes the decimal mark the way each language does", () => {
		mockGetLanguage.mockReturnValue("ru");
		expect(uiText("billing.decimalSeparator")).toBe(",");
		mockGetLanguage.mockReturnValue("en");
		expect(uiText("billing.decimalSeparator")).toBe(".");
	});

	it("keeps the subscription's Cancel apart from the dialog's Cancel", () => {
		mockGetLanguage.mockReturnValue("ru");
		// Identical in English, and that is exactly the trap: collapsing them
		// would put «Отмена» (dismiss a dialog) on a button that ends a paid
		// subscription.
		expect(englishPhrasebook["billing.cancelSubscriptionButton"]).toBe(
			englishPhrasebook["shared.cancelButton"],
		);
		expect(uiText("billing.cancelSubscriptionButton")).toBe("Отменить");
		expect(uiText("shared.cancelButton")).toBe("Отмена");
	});

	it("does not reuse «хранилище» (the vault) for the storage quota", () => {
		mockGetLanguage.mockReturnValue("ru");
		expect(uiText("billing.entitlement.maxStorageBytes")).toBe("Место");
		expect(uiText("billing.usage.storage")).not.toMatch(/хранилищ/i);
	});

	//: the RU catalogue migration added these two numeric
	// entitlement keys without ever adding their labels, so they rendered as
	// their own raw snake_case key.
	it("has ru+en labels for the two entitlement keys the RU migration added", () => {
		mockGetLanguage.mockReturnValue("ru");
		expect(uiText("billing.entitlement.maxFileSizeBytes")).toBe("Максимальный размер файла");
		expect(uiText("billing.entitlement.versionHistoryDays")).toBe("Хранение версий, дней");
		mockGetLanguage.mockReturnValue("en");
		expect(uiText("billing.entitlement.maxFileSizeBytes")).toBe("Max file size");
		expect(uiText("billing.entitlement.versionHistoryDays")).toBe("Version history, days");
	});

	// Same migration also added two `{ enabled: bool }` feature flags. Their
	// labels plus the shared "Enabled"/"Включено" value word must exist in
	// both languages -- BillingView's render loop hides any entitlement
	// without a registered label (see billingCallSites.test.ts), so a missing
	// string here would silently drop the row rather than raise.
	it("has ru+en labels for the two boolean entitlement flags, and the shared enabled-value word", () => {
		mockGetLanguage.mockReturnValue("ru");
		expect(uiText("billing.entitlement.rolesEnabled")).toBe("Роли");
		expect(uiText("billing.entitlement.closingDocsEdoEnabled")).toBe("Закрывающие документы (ЭДО)");
		expect(uiText("billing.entitlement.enabledValue")).toBe("Включено");
		mockGetLanguage.mockReturnValue("en");
		expect(uiText("billing.entitlement.rolesEnabled")).toBe("Roles");
		expect(uiText("billing.entitlement.closingDocsEdoEnabled")).toBe("Closing documents (EDO)");
		expect(uiText("billing.entitlement.enabledValue")).toBe("Enabled");
	});

	it("substitutes the server name into the Russian subtitle", () => {
		mockGetLanguage.mockReturnValue("ru");
		expect(uiText("billing.onServer", { server: "Team Relay RU" })).toBe(
			"на Team Relay RU",
		);
	});

	// Requirement: when checkout is unavailable the screen
	// shows OUR words, and the server's ("Billing is in stub mode. Upgrade not
	// available.") must never reach a buyer -- or a bank reading the
	// screenshot. "stub" and "mode" are internal terms.
	it.each(["en", "ru"])(
		"keeps internal server vocabulary out of the coming-soon copy (%s)",
		(lang) => {
			mockGetLanguage.mockReturnValue(lang);
			for (const key of ["billing.comingSoonButton", "billing.checkoutComingSoonNote"] as const) {
				const text = uiText(key).toLowerCase();
				expect(text).not.toContain("stub");
				expect(text).not.toContain("mode");
				expect(text).not.toContain("checkout");
				expect(text.length).toBeGreaterThan(0);
			}
		},
	);

	it("frames the unavailable state as being connected, not as broken", () => {
		mockGetLanguage.mockReturnValue("ru");
		expect(uiText("billing.comingSoonButton")).toBe("Скоро");
		expect(uiText("billing.checkoutComingSoonNote")).toBe(
			"Приём платежей подключается. Оплатить можно будет в ближайшее время.",
		);
		// The rejected framing: "недоступна" reads as a fault, not a stage.
		expect(uiText("billing.checkoutComingSoonNote")).not.toMatch(/недоступн/i);
	});

	it("has a Russian phrase for every billing key -- no half-translated screen", () => {
		const billingKeys = (Object.keys(englishPhrasebook) as PhraseKey[]).filter((k) =>
			k.startsWith("billing."),
		);
		expect(billingKeys.length).toBeGreaterThan(0); // guards against a vacuous pass
		expect(billingKeys.filter((k) => !(k in ruPhrasebook))).toEqual([]);
	});
});
