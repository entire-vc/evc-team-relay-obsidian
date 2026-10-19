import type { SettingsScope } from "./SettingsPersistence";
import { type FeatureToggles, type ToggleName, FeatureToggleDefaults } from "./featureToggles";
import { Notifier } from "./notifiers/Notifier";

function activeToggles(): FeatureToggles {
	return FeatureToggleState.getShared().currentToggles;
}

export function currentToggles(): FeatureToggles {
	return { ...activeToggles() };
}

export function withToggle(
	featureKey: ToggleName,
	fn: () => void,
	otherwise: () => void = () => {},
): void {
	(activeToggles()[featureKey] ? fn : otherwise)();
}

export function withAnyToggle(
	candidates: ToggleName[],
	fn: () => void,
	otherwise: () => void = () => {},
): void {
	const active = activeToggles();
	if (candidates.some((featureKey) => active[featureKey])) {
		fn();
		return;
	}
	otherwise();
}

export class FeatureToggleState extends Notifier<FeatureToggleState> {
	private static sharedInstance: FeatureToggleState | null = null;
	private backingSettings?: SettingsScope<FeatureToggles>;
	public currentToggles: FeatureToggles;

	private constructor() {
		super("FeatureToggleState");
		this.currentToggles = FeatureToggleDefaults;
	}

	public static getShared(): FeatureToggleState {
		return (FeatureToggleState.sharedInstance ??= new FeatureToggleState());
	}

	public static resetInstance(): void {
		FeatureToggleState.sharedInstance?.destroy();
		FeatureToggleState.sharedInstance = null;
	}

	public bindSettings(settings: SettingsScope<FeatureToggles>): void {
		this.backingSettings = settings;
		this.unsubscribes.push(
			settings.subscribe((newFlags) => {
				this.currentToggles = { ...this.currentToggles, ...newFlags };
				this.notifySubscribers();
			}),
		);
	}

	public readFlag(flagName: keyof FeatureToggles): boolean {
		return this.currentToggles[flagName];
	}

	public writeFlag(flagName: keyof FeatureToggles, value: boolean): void {
		if (!this.backingSettings) return;
		void this.backingSettings.mutateValue((current) => ({
			...current,
			[flagName]: value,
		}));
	}
}
