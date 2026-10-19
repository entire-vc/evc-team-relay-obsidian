/**
 * Copy text to the clipboard of the window the user is currently working in
 * (main window or a popout), instead of the main window's global.
 */
export function copyToClipboard(text: string): Promise<void> {
	const win = typeof activeWindow !== "undefined" ? activeWindow : window;
	const { clipboard } = win.navigator;
	return clipboard.writeText(text);
}
