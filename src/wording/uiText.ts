/**
 * Looks up one phrase in the user's interface language, falling back to
 * English whenever the active phrasebook doesn't cover a key (missing
 * translation, or -- today -- no phrasebook beyond `en` exists at all yet).
 *
 * `{name}` placeholders in the phrase template are replaced from `params`.
 * A placeholder with no matching param, or a param with no matching
 * placeholder, is left/dropped silently rather than thrown -- a partial
 * translation shouldn't be able to crash the UI it's rendering into.
 */
import { resolveInterfaceLanguage } from "./interfaceLanguage";
import { englishPhrasebook, phrasebooksByLanguage, type PhraseKey } from "./phrasebook";

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

function fillPlaceholders(template: string, params?: Record<string, string | number>): string {
	if (!params) return template;
	return template.replace(PLACEHOLDER_RE, (match, name: string) =>
		Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
	);
}

export function uiText(key: PhraseKey, params?: Record<string, string | number>): string {
	const language = resolveInterfaceLanguage();
	const dictionary = phrasebooksByLanguage[language];
	const template = dictionary?.[key] ?? englishPhrasebook[key];
	return fillPlaceholders(template, params);
}
