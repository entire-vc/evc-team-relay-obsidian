/**
 * Resolves which language the plugin's own UI should render in.
 *
 * Source of truth is Obsidian's own `getLanguage()` (added 1.8.7, the exact
 * `minAppVersion` this plugin already requires -- no fallback needed): it
 * returns the ISO code of the user's configured Obsidian interface language
 * and already defaults to "en" itself when nothing is configured.
 *
 * Deliberately NOT used: the `getItem("language")` call on local storage (undocumented,
 * reads Obsidian's own storage key rather than a public API),
 * `moment.locale()` (date-formatting locale, not the UI language setting),
 * `navigator.language` (browser/OS locale, ignores the user's in-app choice
 * entirely on Electron).
 */
import { getLanguage } from "obsidian";

/** Narrows an arbitrary ISO code down to a phrasebook we actually ship. */
export function resolveInterfaceLanguage(): string {
	return getLanguage();
}
