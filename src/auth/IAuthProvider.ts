/**
 * Authentication Provider Interface
 *
 * This interface defines the contract for authentication providers.
 * Implementations can provide authentication against different backends
 * (PocketBase, custom control plane, etc.)
 */

export interface AuthUser {
	id: string;
	email: string;
	name?: string;
	picture?: string;
}

export interface AuthToken {
	token: string;
	expiresAt: number;
}

export interface AuthResponse {
	user: AuthUser;
	token: AuthToken;
	refreshToken?: string;
}

export interface IAuthProvider {
	/**
	 * Check if user is currently logged in
	 */
	isLoggedIn(): boolean;

	/**
	 * Get current user information
	 */
	getCurrentUser(): AuthUser | undefined;

	/**
	 * Get current authentication token (may return expired token)
	 */
	getToken(): string | undefined;

	/**
	 * Get a valid token, refreshing if needed. Prefer this over getToken().
	 */
	getValidToken(): Promise<string | undefined>;

	/**
	 * Login with email and password
	 */
	loginWithPassword(email: string, password: string): Promise<AuthResponse>;

	/**
	 * Login with OAuth2 provider
	 */
	loginWithOAuth2(provider: string, signal?: AbortSignal): Promise<AuthResponse>;

	/**
	 * Refresh the authentication token
	 */
	refreshToken(): Promise<AuthResponse>;

	/**
	 * Logout current user
	 */
	logout(): Promise<void>;

	/**
	 * Check if token is valid and not expired
	 */
	isTokenValid(): boolean;
}
