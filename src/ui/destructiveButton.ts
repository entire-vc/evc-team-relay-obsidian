import type { ButtonComponent } from "obsidian";

/** Apply the destructive style supported by every compatible Obsidian version. */
export function setDestructiveButton(button: ButtonComponent): ButtonComponent {
	button.buttonEl.addClass("mod-warning");
	return button;
}
