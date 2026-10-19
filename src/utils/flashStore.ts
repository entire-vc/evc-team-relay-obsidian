import { writable } from "svelte/store";

export type ToastType = "error" | "warning" | "info" | "success";
export type ToastSource = "client" | "server";

export interface FlashMessage {
	toastMessage: string;
	detailText?: string;
	type?: ToastType;
	isShown: boolean;
	autoDismissMs?: number;
	toastSource?: ToastSource;
}

const DEFAULT_AUTO_DISMISS_MS = 5000;

/** Keyed by an arbitrary caller-chosen id so a later toast can replace/dismiss an earlier one. */
export const flashStore = writable<Record<string, FlashMessage>>({});

interface ToastOptions {
	details?: string;
	type?: ToastType;
	autoDismiss?: number;
	source?: ToastSource;
}

function upsertToast(key: string, message: string, options: ToastOptions = {}): void {
	flashStore.update((toasts) => ({
		...toasts,
		[key]: {
			toastMessage: message,
			detailText: options.details,
			type: options.type ?? "error",
			isShown: true,
			autoDismissMs: options.autoDismiss ?? DEFAULT_AUTO_DISMISS_MS,
			toastSource: options.source ?? "client",
		},
	}));
}

export function showFlash(
	key: string,
	message: string,
	details?: string,
	type: ToastType = "error",
	autoDismiss?: number,
	source: ToastSource = "client",
): void {
	upsertToast(key, message, { details, type, autoDismiss, source });
}

export function hideFlash(key: string): void {
	flashStore.update((toasts) => {
		const existing = toasts[key];
		if (!existing) {
			return toasts;
		}
		return { ...toasts, [key]: { ...existing, isShown: false } };
	});
}

/** Show a toast originating from a server response rather than purely client-side logic. */
export function showServerFlash(
	key: string,
	message: string,
	details?: string,
	type: ToastType = "error",
	autoDismiss?: number,
): void {
	upsertToast(key, message, { details, type, autoDismiss, source: "server" });
}

/** The subset of a caught server-error shape we actually care about; everything else is unknown. */
interface ServerErrorLike {
	status?: number;
	message?: string;
	body?: {
		message?: string;
		details?: string;
	};
}

function asServerErrorLike(error: unknown): ServerErrorLike {
	return typeof error === "object" && error !== null ? error : {};
}

/**
 * Turns a caught error from an API call into a user-facing toast, picking a
 * message and severity/duration based on the HTTP status if one is present.
 * `fallbackMessage` is used whenever neither the server nor the error object
 * gave us anything more specific to say.
 */
export function reportServerError(
	error: unknown,
	fallbackMessage: string = "An error occurred",
): void {
	const key = `server-error-${Date.now()}`;
	const serverError = asServerErrorLike(error);
	const status = serverError.status ?? 0;
	const thrownMessage = error instanceof Error ? error.message : "";
	const bestGuessMessage = serverError.message ?? thrownMessage;

	if (status === 403) {
		const message = serverError.body?.message || bestGuessMessage || "Permission denied";
		showServerFlash(key, message, serverError.body?.details, "error", 7000);
	} else if (status >= 400 && status < 500) {
		const message = serverError.body?.message || bestGuessMessage || fallbackMessage;
		showServerFlash(key, message, undefined, "error", 5000);
	} else if (status >= 500) {
		showServerFlash(key, "Server error occurred", bestGuessMessage, "error", 8000);
	} else {
		showServerFlash(key, fallbackMessage, bestGuessMessage, "error", 5000);
	}
}
