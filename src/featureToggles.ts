// Single source of truth: [toggle name, default value] pairs. The interface
// and the defaults object below are both DERIVED from this array instead of
// being two hand-maintained, independently-ordered declarations.
const TOGGLE_DEFINITIONS = [
	["enableDocumentStatus", false],
	["enableNewLinkFormat", false],
	["enableDeltaLogging", false],
	["enableDocumentHistory", false],
	["enableEditorTweens", false],
	["enableNetworkLogging", false],
	["enableCanvasSync", false],
	["enableVerifyUploads", false],
	["enableAutomaticDiffResolution", true],
	["enableDiscordLogin", false],
	["enableToasts", true],
	["enablePresenceAvatars", true],
	["enableLiveEmbeds", true],
	["enablePreviewViewHooks", true],
	["enableMetadataViewHooks", true],
	["enableKanbanView", true],
] as const satisfies ReadonlyArray<readonly [string, boolean]>;

type ToggleKey = (typeof TOGGLE_DEFINITIONS)[number][0];

export type FeatureToggles = { [K in ToggleKey]: boolean };

export const FeatureToggleDefaults: FeatureToggles = Object.fromEntries(
	TOGGLE_DEFINITIONS,
) as FeatureToggles;

export type ToggleName = keyof FeatureToggles;

const TOGGLE_NAMES: readonly ToggleName[] = TOGGLE_DEFINITIONS.map(([name]) => name);

export function isToggleName(key: string): key is ToggleName {
	return (TOGGLE_NAMES as readonly string[]).includes(key);
}

// `featureKey.enableFoo` reads back the literal key name `"enableFoo"` — lets call
// sites reference a featureKey by property access (with autocomplete) instead of a
// bare string, e.g. withToggle(featureKey.enableInvalidLinkDecoration, () => {}).
export const featureKey: Record<ToggleName, ToggleName> = TOGGLE_NAMES.reduce(
	(acc, name) => {
		acc[name] = name;
		return acc;
	},
	{} as Record<ToggleName, ToggleName>,
);
