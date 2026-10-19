import { describe, expect, jest, test } from "@jest/globals";
import type { ButtonComponent } from "obsidian";
import { setDestructiveButton } from "../src/ui/destructiveButton";

describe("destructive button compatibility", () => {
	test("keeps the destructive style and chaining without using the newer API", () => {
		const button = {
			buttonEl: { addClass: jest.fn() },
			setDestructive: jest.fn<() => ButtonComponent>(),
		};
		button.setDestructive.mockReturnValue(button as unknown as ButtonComponent);

		expect(setDestructiveButton(button as unknown as ButtonComponent)).toBe(button);
		expect(button.setDestructive).not.toHaveBeenCalled();
		expect(button.buttonEl.addClass).toHaveBeenCalledWith("mod-warning");
	});

	test("preserves the legacy destructive style on supported Obsidian before 1.13", () => {
		const button = { buttonEl: { addClass: jest.fn() } };

		expect(setDestructiveButton(button as unknown as ButtonComponent)).toBe(button);
		expect(button.buttonEl.addClass).toHaveBeenCalledWith("mod-warning");
	});
});
