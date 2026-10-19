import { App } from "obsidian";
import FeatureTogglesModalContent from "../components/FeatureTogglesModalContent.svelte";
import { SimpleContentModal } from "./SimpleContentModal";

export class FeatureTogglesModal extends SimpleContentModal<{ applyChanges: () => void }> {
	constructor(app: App, reload: () => void) {
		super(app, FeatureTogglesModalContent, { applyChanges: reload });
	}
}
