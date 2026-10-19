/**
 * The plugin's own copy, one language at a time.
 *
 * `englishPhrasebook` is the single source of truth for every user-visible
 * string MR1 moved out of a call site -- each value here was copied BYTE FOR
 * BYTE from wherever it used to live (see `scripts/check-i18n-string-parity.py`
 * for the automated proof; MR1 does not apply to this file -- see `ruPhrasebook`
 * below).
 *
 * Placeholders use `{name}` (not printf `%s`, not ICU `{name, plural, ...}`)
 * -- see `uiText.ts` for the substitution rule. Keys are flat, dot-namespaced
 * strings grouped by the screen they render on; `shared.*` holds text that
 * is byte-identical across more than one screen (collapsed on purpose --
 * see the task's dedup note on "Create Share" appearing verbatim in three
 * files).
 */

export const englishPhrasebook = {
	// Shared across screens -- identical English text, one entry.
	"shared.cancelButton": "Cancel",
	"shared.viewerOption": "Viewer",
	"shared.editorOption": "Editor",
	"shared.createShareButton": "Create Share",
	"shared.creatingEllipsis": "Creating...",
	"shared.passwordLabel": "Password",
	"shared.passwordRequiredNotice": "Password is required for protected shares",
	"shared.unknownError": "Unknown error",
	"shared.failedNotice": "Failed: {error}",
	"shared.emailPlaceholder": "user@example.com",
	"shared.noExpiration": "No expiration",
	"shared.noShareClientError": "No share client available",

	// Connect screen -- src/ui/RelayOnPremLoginModal.ts
	"connect.login.title": "Sign in to {server}",
	// Fallback title when the server's name doesn't resolve (e.g. malformed
	// stored settings) -- the modal must never fall back to an EMPTY "Sign
	// in to " title, so this is a distinct key, not a missing-param artifact
	// of the one above.
	"connect.login.titleFallback": "Relay on-premise login",
	// Shown under the title only when this server AND its sibling shipped
	// instance are both present (see crossServerAccountNote() in
	// RelayOnPremConfig.ts) -- explains a cross-server 401 before the user
	// hits it, not just after.
	"connect.login.separateAccountsNote":
		"Accounts aren't shared between servers. A login from {otherServer} won't work here — you need an invite to {thisServer}.",
	"connect.login.emailLabel": "Email",
	"connect.login.passwordPlaceholder": "Enter your password",
	"connect.login.loginButton": "Login",
	"connect.login.loggingIn": "Logging in...",
	"connect.login.orSignInWith": "Or sign in with:",
	"connect.login.ssoUnavailableMobile":
		"SSO sign-in isn't available on mobile yet — use the desktop app, or sign in with email and password if your account has one.",
	"connect.login.successNotice": "Successfully logged in to relay-onprem!",
	"connect.login.oauthSuccessNotice": "Successfully logged in with {provider}!",
	"connect.login.loginFailedFallback": "Login failed",
	"connect.login.incorrectCredentials": "Incorrect email or password",
	// Same 401, but shown instead of the plain one above when
	// crossServerAccountNote() applies -- the most attentive moment to
	// deliver the explanation is the instant the user draws the wrong
	// conclusion.
	"connect.login.incorrectCredentialsCrossServer":
		"Incorrect email or password. Accounts aren't shared between servers — if that login is from {otherServer}, it won't work here.",
	"connect.login.invalidLoginData":
		"Invalid login data. Please check your email and password.",
	"connect.login.networkError":
		"Network error. Please check your connection and control plane URL.",
	"connect.login.emailRequired": "Please enter your email",
	"connect.login.passwordRequired": "Please enter your password",
	"connect.login.invalidEmail": "Please enter a valid email address",
	"connect.login.passwordTooShort": "Password must be at least 8 characters",
	"connect.login.oauthFailedFallback": "OAuth login failed",
	"connect.login.oauthTimeout": "Login timeout. Please try again.",
	"connect.login.oauthCannotOpenBrowser":
		"Unable to open browser. Please try manual login.",

	// Plugin shell -- src/components/RelayOnPremSettings.svelte
	"shell.header.title": "Team Relay",
	"shell.header.desc": "Self-hosted relay for real-time collaboration",
	"shell.header.githubTooltip": "GitHub",
	"shell.header.bugReportTooltip": "Bug report",
	"shell.header.featureRequestTooltip": "Feature request",
	"shell.header.webPublishTooltip": "Web publish issue",
	"shell.header.docsCta": "Documentation",
	"shell.header.mcpCta": "MCP server",
	"shell.header.meshCta": "Mesh",
	"shell.servers.heading": "Relay Servers",
	"shell.servers.desc":
		'Configure your relay-onprem servers. Click "Shares" to manage shares.',
	"shell.breadcrumb.planUsage": "Plan & Usage",
	"shell.breadcrumb.createInvite": "Create Invite",
	"shell.breadcrumb.agentKeys": "Agent Keys",

	// Server list -- src/components/RelayOnPremServerList.svelte
	"serverList.emptyNotice":
		"No relay servers configured. Add a server to get started.",
	"serverList.defaultBadge": "Default",
	"serverList.loggedInAs": "As: {email}",
	"serverList.logoutButton": "Logout",
	"serverList.testButton": "Test",
	"serverList.sharesButton": "Shares",
	"serverList.loginRequiredHint": "Log in to manage this",
	"serverList.editButton": "Edit",
	"serverList.removeButton": "Remove",
	"serverList.removeConfirmMessage":
		'Remove server "{name}"? This will also log you out from this server.',
	"serverList.editServerTitle": "Edit Server",
	"serverList.addServerTitle": "Add Server",
	"serverList.saveChangesButton": "Save Changes",
	"serverList.addServerCta": "+ Add Server",
	"serverList.controlPlaneUrlLabel": "Control Plane URL",
	"serverList.serverNameLabel": "Server Name (auto-detected if empty)",
	"serverList.relayServerUrlLabel":
		"Relay Server URL (auto-detected if empty)",
	"serverList.autoDetectPlaceholder": "Leave empty to auto-detect",
	"serverList.controlPlaneUrlRequiredError": "Control Plane URL is required",
	"serverList.cannotConnectError": "Cannot connect to server",
	"serverList.duplicateUrlError":
		'"{name}" already uses this URL. Edit that server instead of adding a duplicate.',
	"serverList.connectionSuccessNotice": "Connection successful!",
	"serverList.connectionFailedStatusNotice": "Connection failed: {status}",
	"serverList.connectionFailedErrorNotice": "Connection failed: {error}",
	"serverList.serverUpdatedNotice": "Server updated",
	"serverList.serverAddedNotice": "Server added",
	"serverList.serverRemovedNotice": 'Server "{name}" removed',
	"serverList.oauthStartingNotice": "Starting OAuth login with {provider}...",
	"serverList.oauthWaitingStatus":
		"Waiting for you to sign in in the browser. If it didn't open, sign in with a password instead.",
	"serverList.oauthCancelButton": "Cancel",
	"serverList.oauthUsePasswordButton": "Sign in with password",
	"serverList.oauthCancelledNotice": "Sign-in cancelled",
	"serverList.loggedInNotice": "Logged in to {name}",
	"serverList.oauthFailedNotice":
		"OAuth failed: {error}. Falling back to password.",
	"serverList.authProviderNotReadyNotice":
		"Auth provider not ready. Please try again.",
	"serverList.loggedOutNotice": "Logged out",
	"serverList.logoutFailedNotice": "Logout failed: {error}",
	"serverList.defaultClearedNotice": "Default server cleared",
	"serverList.defaultSetNotice": "Default server set",

	// Share list -- src/components/ShareListView.svelte
	"shareList.title": "Shares on {serverName}",
	"shareList.loading": "Loading shares...",
	"shareList.empty": "No shares yet. Create your first share to get started!",
	"shareList.noServerError": "Please add a server and log in first.",
	"shareList.loadFailedFallback": "Failed to load shares",

	// Share detail card -- src/components/ShareDetailView.svelte
	"shareDetail.loading": "Loading share details...",
	"shareDetail.loadFailedNotice": "Failed to load share details: {error}",
	"shareDetail.copyIdButton": "Copy ID",
	"shareDetail.idCopiedNotice": "Share ID copied",

	"shareDetail.localFolder.heading": "Local Folder",
	"shareDetail.localFolder.connectedStatus": "Connected and syncing",
	"shareDetail.localFolder.notConnectedStatus":
		"Not connected to a local folder",
	"shareDetail.localFolder.disconnectButton": "Disconnect",
	"shareDetail.localFolder.connectButton": "Connect to local folder",
	"shareDetail.localFolder.pickerTitle":
		"Choose local folder for this share...",
	"shareDetail.localFolder.connectedNotice": "Folder connected! Syncing...",
	"shareDetail.localFolder.connectFailedNotice":
		"Failed to connect folder: {error}",
	"shareDetail.localFolder.disconnectConfirm":
		'Disconnect local folder "{path}" from this share? Local files will not be deleted.',
	"shareDetail.localFolder.disconnectedNotice": "Folder disconnected",

	"shareDetail.members.heading": "Members",
	"shareDetail.members.empty": "No members yet.",
	"shareDetail.members.addButton": "Add",
	"shareDetail.members.removeButton": "Remove",
	"shareDetail.members.emailRequiredNotice": "Please enter a user email",
	"shareDetail.members.addedNotice": "Member added",
	"shareDetail.members.limitReachedNotice":
		"Member limit reached ({current}/{max} on {plan} plan). Upgrade your plan to add more members.",
	"shareDetail.members.addFailedFallback": "Failed to add member",
	"shareDetail.members.roleChangedNotice": "Role changed to {role}",
	"shareDetail.members.roleChangeFailedNotice":
		"Failed to change role: {error}",
	"shareDetail.members.removedNotice": "Member removed",
	"shareDetail.members.removeFailedNotice": "Failed to remove member: {error}",

	"shareDetail.invites.heading": "Invite Links",
	"shareDetail.invites.createButton": "Create Invite",
	"shareDetail.invites.empty": "No active invite links.",
	"shareDetail.invites.roleSuffix": "{role} invite",
	"shareDetail.invites.copyLinkButton": "Copy Link",
	"shareDetail.invites.linkCopiedNotice": "Invite link copied!",
	"shareDetail.invites.revokeButton": "Revoke",
	"shareDetail.invites.revokeConfirm": "Revoke this invite link?",
	"shareDetail.invites.revokedNotice": "Invite revoked",
	"shareDetail.invites.revokeFailedNotice": "Failed to revoke invite: {error}",
	"shareDetail.invites.expiredTag": "EXPIRED",
	"shareDetail.invites.maxUsesReachedTag": "MAX USES REACHED",
	"shareDetail.invites.expiresLabel": "Expires: {date}",
	"shareDetail.invites.usesWithMax": "Uses: {used}/{max}",
	"shareDetail.invites.usesNoMax": "Uses: {used}",

	"shareDetail.agentKeys.manageButton": "Manage",
	"shareDetail.agentKeys.desc":
		"API keys for automated agents to access this share without your login credentials.",

	"shareDetail.webPublish.heading": "Web Publishing",
	"shareDetail.webPublish.publishLabel": "Publish to Web",
	"shareDetail.webPublish.webUrlLabel": "Web URL",
	"shareDetail.webPublish.copyButton": "Copy",
	"shareDetail.webPublish.openButton": "Open",
	"shareDetail.webPublish.urlCopiedNotice": "URL copied!",
	"shareDetail.webPublish.syncContentLabel": "Sync Content",
	"shareDetail.webPublish.syncNowButton": "Sync Now",
	"shareDetail.webPublish.allowSearchEnginesLabel": "Allow search engines",
	"shareDetail.webPublish.syncModeLabel": "Sync Mode",
	"shareDetail.webPublish.manualOption": "Manual",
	"shareDetail.webPublish.autoOption": "Auto",
	"shareDetail.webPublish.webSlugLabel": "Web Slug",
	"shareDetail.webPublish.webSlugPlaceholder": "my-document",
	"shareDetail.webPublish.saveButton": "Save",
	"shareDetail.webPublish.contentSyncedNotice": "Content synced!",
	"shareDetail.webPublish.syncedFilesNotice": "Synced {count} files",
	"shareDetail.webPublish.folderSyncedNotice": "Folder synced: {count} items",
	"shareDetail.webPublish.couldNotReadDocumentNotice":
		"Could not read document",
	"shareDetail.webPublish.folderEmptyNotice": "Folder empty",
	"shareDetail.webPublish.syncFailedNotice": "Failed to sync: {error}",
	"shareDetail.webPublish.indexingDisabledNotice": "Indexing disabled",
	"shareDetail.webPublish.indexingEnabledNotice": "Indexing enabled",
	"shareDetail.webPublish.autoSyncEnabledNotice": "Auto-sync enabled",
	"shareDetail.webPublish.autoSyncDisabledNotice": "Auto-sync disabled",
	"shareDetail.webPublish.syncModeNotice": "Sync mode: {mode}",
	"shareDetail.webPublish.slugUpdatedNotice": "Slug updated: {slug}",
	"shareDetail.webPublish.publishedNotice": "Published to web!",
	"shareDetail.webPublish.unpublishedNotice": "Unpublished from web",
	"shareDetail.webPublish.publishedWithSkippedNotice": "Published; {count} file(s) skipped: {files}",
	"shareDetail.webPublish.privatePublishPrompt":
		'This share is private. Web publishing requires "public" or "protected" visibility. Choose how you want to publish:',
	"shareDetail.webPublish.makePublicChoice": "Make public (open access)",
	"shareDetail.webPublish.makeProtectedChoice": "Make protected (password)",
	"shareDetail.webPublish.visibilityChangeFailedNotice":
		"Failed to change visibility",
	"shareDetail.webPublish.limitReachedNotice":
		"Web publish limit reached ({current}/{max} on {plan} plan). Upgrade your plan to publish more.",
	"shareDetail.webPublish.visibilityNotAllowedNotice":
		"'{visibility}' visibility requires a higher plan. Your plan allows: {allowed}. Upgrade to unlock.",

	"shareDetail.actions.heading": "Actions",
	"shareDetail.actions.changeVisibilityLabel": "Change Visibility",
	"shareDetail.actions.changeVisibilityDesc":
		"Control who can access this share",
	"shareDetail.actions.privateOption": "Private",
	"shareDetail.actions.publicOption": "Public",
	"shareDetail.actions.protectedOption": "Protected",
	"shareDetail.actions.deleteShareLabel": "Delete Share",
	"shareDetail.actions.deleteShareDesc": "Permanently delete this share",
	"shareDetail.actions.deleteButton": "Delete",
	"shareDetail.actions.passwordPrompt": "Enter password for protected share:",
	"shareDetail.actions.visibilityConfirm": "Change visibility to {visibility}?",
	"shareDetail.actions.visibilityChangedNotice":
		"Visibility changed to {visibility}",
	"shareDetail.actions.deleteConfirm":
		'Delete "{path}"? This cannot be undone.',
	"shareDetail.actions.deletedNotice": "Share deleted",
	"shareDetail.actions.deleteFailedNotice": "Failed to delete: {error}",

	// Share creation -- src/components/CreateShareView.svelte
	"createShare.pickerTitle": "Choose folder for share...",
	"createShare.pathRequiredNotice": "Please select a folder path",
	"createShare.createdNotice": 'Share "{path}" created!',
	"createShare.limitReachedNotice":
		"Share limit reached ({current}/{max} on {plan} plan). Upgrade your plan to create more shares.",
	"createShare.createFailedNotice": "Failed to create share: {error}",
	"createShare.title": "Create New Share",
	"createShare.pathLabel": "Path",
	"createShare.choosePlaceholder": "Choose folder...",
	"createShare.typeLabel": "Type",
	"createShare.docOption": "Document",
	"createShare.folderOption": "Folder",
	"createShare.visibilityLabel": "Visibility",
	"createShare.privateVisibilityOption": "Private - Only members",
	"createShare.publicVisibilityOption": "Public - Anyone with link",
	"createShare.protectedVisibilityOption": "Protected - Password required",
	"createShare.passwordPlaceholder": "Enter password for protected share",

	// Invite creation -- src/components/CreateInviteView.svelte
	"createInvite.maxUsesInvalidNotice": "Max uses must be a positive number",
	"createInvite.createdNotice": "Invite link created!",
	"createInvite.createFailedNotice": "Failed to create invite: {error}",
	"createInvite.title": "Create Invite Link",
	"createInvite.forLabel": "for {path}",
	"createInvite.roleLabel": "Role",
	"createInvite.expirationLabel": "Expiration",
	"createInvite.expires7Days": "7 days",
	"createInvite.expires14Days": "14 days",
	"createInvite.expires30Days": "30 days",
	"createInvite.maxUsesLabel": "Max Uses (optional)",
	"createInvite.unlimitedPlaceholder": "Unlimited",
	"createInvite.createButton": "Create Invite Link",

	// Billing & plan screen -- src/components/BillingView.svelte.
	// Extracted from the call sites BYTE FOR BYTE, same rule as everything
	// above: this screen's English wording is unchanged by that task, only
	// its location. The one genuinely new English string is
	// `billing.checkoutUnavailableNotice`, and it exists because the code it
	// replaces had no honest branch to fall back to at all (it announced a
	// checkout that was not opening).
	"billing.title": "Billing & Plan",
	"billing.onServer": "on {server}",
	"billing.loading": "Loading billing info...",
	"billing.notConnectedToServer": "Not connected to server",
	"billing.notConnected": "Not connected",
	"billing.loadFailed": "Failed to load billing data",
	"billing.unlimited": "Unlimited",
	"billing.freePrice": "Free",

	// Period suffix on a price (`$9/mo`). Short by design -- it renders
	// inside a price, not as a sentence.
	"billing.period.month": "mo",
	"billing.period.year": "yr",

	// Storage sizes. Units are visible product text on this screen, so they
	// are translated too ("3 GB" is an English word on a Russian screen), and
	// so is the decimal mark -- Russian writes 3,0 where English writes 3.0.
	// A one-character "phrase" is odd, but it keeps every locale-dependent
	// glyph on this screen in the one place a reviewer reads.
	"billing.decimalSeparator": ".",
	"billing.bytes.gigabytes": "{value} GB",
	"billing.bytes.megabytes": "{value} MB",
	"billing.bytes.bytes": "{value} B",

	"billing.badge.cancelling": "Cancelling",
	"billing.badge.active": "Active",
	"billing.badge.current": "Current",

	"billing.resubscribeButton": "Resubscribe",
	"billing.manageButton": "Manage",
	// Deliberately NOT `shared.cancelButton`. That one dismisses a dialog
	// ("Отмена"); this one ends a paid subscription ("Отменить"). Identical
	// in English, different words in Russian -- collapsing them would put
	// the wrong verb on a destructive button.
	"billing.cancelSubscriptionButton": "Cancel",
	"billing.currentPlanButton": "Current plan",
	"billing.refreshButton": "Refresh",

	"billing.accessUntil": "Access until {date}",
	"billing.usageTitle": "Your Usage",
	"billing.limitReached": "Limit reached",
	"billing.percentUsed": "{percent}% used",

	"billing.usage.shares": "Shares",
	"billing.usage.webPublished": "Web published",
	"billing.usage.storage": "Storage",

	"billing.entitlement.maxShares": "Shares",
	"billing.entitlement.maxMembersPerShare": "Members per share",
	"billing.entitlement.maxWebPublished": "Web published",
	"billing.entitlement.maxStorageBytes": "Storage",
	"billing.entitlement.maxFileSizeBytes": "Max file size",
	// No formatter turns a day count into a unit the way `formatBytes` does
	// for bytes -- the unit lives in the label instead, same as "Shares"
	// above carries its own unit with no number formatting.
	"billing.entitlement.versionHistoryDays": "Version history, days",
	"billing.entitlement.rolesEnabled": "Roles",
	"billing.entitlement.closingDocsEdoEnabled": "Closing documents (EDO)",
	// Value cell for any `{ enabled: true }` entitlement -- see
	// `classifyEntitlement()` in `../billing/entitlements`.
	"billing.entitlement.enabledValue": "Enabled",

	"billing.planChangedNotice": "Plan changed successfully!",
	"billing.openingCheckoutNotice": "Opening checkout in browser...",
	// Shown when the server answers with something that is not an openable
	// link -- today, stub mode. Deliberately OUR words, never the server's
	// `message`: that reads "Billing is in stub mode. Upgrade not
	// available.", and "stub mode" is an internal term that means nothing to
	// a buyer and the wrong thing to a bank reviewing the product . The framing is about us connecting something, not about
	// the user hitting a broken feature -- a state, not a fault.
	"billing.comingSoonButton": "Soon",
	"billing.checkoutComingSoonNote":
		"Card payments are being connected. You'll be able to pay here shortly.",
	"billing.subscriptionActivatedNotice": "Subscription activated!",
	"billing.upgradeFailedNotice": "Upgrade failed: {error}",
	"billing.openingPortalNotice": "Opening subscription portal in browser...",
	"billing.portalNotAvailable": "Portal not available",
	"billing.portalFailedNotice": "Failed to open portal: {error}",
	"billing.subscriptionCancelledNotice":
		"Subscription cancelled. Access continues until end of billing period.",
	"billing.cancelFailedNotice": "Cancel failed: {error}",

	// Agent keys -- English copy preserved from AgentKeysView.
	"agentKeys.createAgentKeyButton": "+ Create agent key",
	"agentKeys.createKeyButton": "+ Create key",
	"agentKeys.loading": "Loading...",
	"agentKeys.noShares": "No shares found for this server. Create a share first to manage agent keys.",
	"agentKeys.noKeys": "No keys for this share.",
	"agentKeys.label": "Label",
	"agentKeys.created": "Created",
	"agentKeys.expires": "Expires",
	"agentKeys.unnamed": "(unnamed)",
	"agentKeys.never": "Never",
	"agentKeys.revokeButton": "Revoke",
	"agentKeys.justNow": "just now",
	"agentKeys.minutesAgo": "{count} min ago",
	"agentKeys.hourAgo": "{count} hour ago",
	"agentKeys.hoursAgo": "{count} hours ago",
	"agentKeys.dayAgo": "{count} day ago",
	"agentKeys.daysAgo": "{count} days ago",
	"agentKeys.monthAgo": "{count} month ago",
	"agentKeys.monthsAgo": "{count} months ago",
	"agentKeys.createTitle": "Create agent key",
	"agentKeys.labelPlaceholder": "e.g. ci-bot",
	"agentKeys.share": "Share",
	"agentKeys.expiry": "Expiry",
	"agentKeys.thirtyDays": "30 days",
	"agentKeys.ninetyDays": "90 days",
	"agentKeys.oneYear": "1 year",
	"agentKeys.reauthButton": "Re-authenticate",
	"agentKeys.createSubmitButton": "Create key",
	"agentKeys.sessionExpiredError": "Session expired. Please re-authenticate and try again.",
	"agentKeys.createError": "Failed to create key: {error}",
	"agentKeys.shareRemovedNotice": "Share removed — key inactive",
	"agentKeys.revokeError": "Failed to revoke key: {error}",
	"agentKeys.copyError": "Failed to copy key",
	"agentKeys.reauthError": "Re-auth failed: {error}",
	"agentKeys.genericError": "error",
	"agentKeys.createdTitle": "Key created: {label}",
	"agentKeys.close": "Close",
	"agentKeys.notCopiedWarning": "You haven't copied the key yet. Click ✕ again to close anyway.",
	"agentKeys.saveKeyPrefix": "Save this key — it will ",
	"agentKeys.saveKeyEmphasis": "not",
	"agentKeys.saveKeySuffix": " be shown again.",
	"agentKeys.copied": "Copied!",
	"agentKeys.copyButton": "Copy",
	"agentKeys.downloadButton": "Download .txt",
	"agentKeys.shareMeta": "Share: {share}",
	"agentKeys.expiresMeta": "Expires: {date}",
	"agentKeys.copiedCloseButton": "I've copied this key — close",
	"agentKeys.revokeTitle": "Revoke key?",
	"agentKeys.revokePrefix": "Revoke ",
	"agentKeys.revokeSuffix": "? This cannot be undone — any agent using this key will lose access immediately.",
	"agentKeys.revokeSubmitButton": "Revoke key",
} as const satisfies Record<string, string>;

/** Every key the phrasebook defines -- the only valid input to `uiText()`. */
export type PhraseKey = keyof typeof englishPhrasebook;

/**
 * A phrasebook doesn't have to cover every key -- `uiText()` falls back to
 * `englishPhrasebook` for anything missing, so a partial (in-progress or
 * community-contributed) translation degrades to English per-string rather
 * than failing whole.
 */
export type Phrasebook = Partial<Record<PhraseKey, string>>;

/**
 * Russian phrasebook -- covers every key MR1
 * extracted (Phase 1: connect screen, plugin shell, share list, share
 * detail card incl. members/invites/web-publish/actions, create share,
 * create invite). {name}-style placeholders are preserved verbatim, never
 * translated or reordered -- uiText.ts substitutes by name, not position.
 *
 * SHIPPED since 0.0.6 -- `git show 0.0.6:src/wording/phrasebook.ts` contains
 * this dictionary, so any user whose Obsidian interface is Russian has been
 * seeing it in a released build. The note that stood here said the opposite
 * ("NOT SHIPPED to any real Russian-speaking user yet"); it was true while
 * MR2 was open and was never updated when it merged. Corrected
 * rather than left standing: a comment that says untranslated text is still
 * behind a gate invites the next author to add strings without review.
 * Any NEW text added here still needs a wording review.
 * Terminology anchored to the existing teamrelay.ru site copy (not invented
 * fresh here) where the site already established a term:
 *   - vault -> хранилище, member -> участник, editor/viewer role ->
 *     редактор/читатель (site: design/spec-site-teamrelay-ru.md:536 -- "Team
 *     Relay" and "Obsidian" stay untranslated everywhere, "хранилище" not
 *     "волт", "участник" not "юзер"/"мембер").
 * One judgment call with NO site precedent to anchor to, flagged explicitly
 * for review: "a Share" (the plugin's core noun, could be a doc or a
 * folder) is rendered as "общий доступ" throughout, plural "общие доступы"
 * -- grammatically a little unusual (matches Russian access-review/DLP
 * jargon "открытые доступы" more than everyday speech) but ties to the
 * site's own already-approved "дать общий доступ" phrasing rather than
 * inventing an unrelated noun. This is the single term most worth
 * double-checking before approval; everything else follows from it.
 */
export const ruPhrasebook = {
	"shared.cancelButton": "Отмена",
	"shared.viewerOption": "Читатель",
	"shared.editorOption": "Редактор",
	"shared.createShareButton": "Создать общий доступ",
	"shared.creatingEllipsis": "Создание...",
	"shared.passwordLabel": "Пароль",
	"shared.passwordRequiredNotice":
		"Для защищённых общих доступов требуется пароль",
	"shared.unknownError": "Неизвестная ошибка",
	"shared.failedNotice": "Ошибка: {error}",
	"shared.emailPlaceholder": "user@example.com",
	"shared.noExpiration": "Без срока действия",
	"shared.noShareClientError": "Служба общих доступов недоступна",

	"connect.login.title": "Вход в {server}",
	"connect.login.titleFallback": "Вход в Relay on-premise",
	"connect.login.separateAccountsNote":
		"Учётные записи не общие для разных серверов. Логин с {otherServer} здесь не сработает — нужен инвайт на {thisServer}.",
	"connect.login.emailLabel": "Email",
	"connect.login.passwordPlaceholder": "Введите пароль",
	"connect.login.loginButton": "Войти",
	"connect.login.loggingIn": "Выполняется вход...",
	"connect.login.orSignInWith": "Или войдите через:",
	"connect.login.ssoUnavailableMobile":
		"Вход через SSO пока недоступен на мобильных устройствах — используйте настольное приложение или войдите с email и паролем, если они привязаны к вашей учётной записи.",
	"connect.login.successNotice": "Вход в relay-onprem выполнен успешно!",
	"connect.login.oauthSuccessNotice": "Вход через {provider} выполнен успешно!",
	"connect.login.loginFailedFallback": "Не удалось войти",
	"connect.login.incorrectCredentials": "Неверный email или пароль",
	"connect.login.incorrectCredentialsCrossServer":
		"Неверный email или пароль. Учётные записи не общие для разных серверов — если это логин с {otherServer}, здесь он не сработает.",
	"connect.login.invalidLoginData":
		"Некорректные данные для входа. Проверьте email и пароль.",
	"connect.login.networkError":
		"Ошибка сети. Проверьте подключение и адрес сервера.",
	"connect.login.emailRequired": "Введите email",
	"connect.login.passwordRequired": "Введите пароль",
	"connect.login.invalidEmail": "Введите корректный email",
	"connect.login.passwordTooShort":
		"Пароль должен содержать не менее 8 символов",
	"connect.login.oauthFailedFallback": "Не удалось выполнить вход через OAuth",
	"connect.login.oauthTimeout":
		"Время ожидания входа истекло. Попробуйте снова.",
	"connect.login.oauthCannotOpenBrowser":
		"Не удалось открыть браузер. Попробуйте войти вручную.",

	"shell.header.title": "Team Relay",
	"shell.header.desc": "Свой сервер для совместной работы в реальном времени",
	"shell.header.githubTooltip": "GitHub",
	"shell.header.bugReportTooltip": "Сообщить об ошибке",
	"shell.header.featureRequestTooltip": "Предложить функцию",
	"shell.header.webPublishTooltip": "Проблема с веб-публикацией",
	"shell.header.docsCta": "Документация",
	"shell.header.mcpCta": "MCP-сервер",
	"shell.header.meshCta": "Mesh",
	"shell.servers.heading": "Серверы Relay",
	"shell.servers.desc":
		"Настройте свои серверы relay-onprem. Нажмите «Общие доступы», чтобы управлять ими.",
	"shell.breadcrumb.planUsage": "Тариф и использование",
	"shell.breadcrumb.createInvite": "Создать приглашение",
	"shell.breadcrumb.agentKeys": "Ключи агента",

	"serverList.emptyNotice":
		"Серверы relay не настроены. Добавьте сервер, чтобы начать.",
	"serverList.defaultBadge": "По умолчанию",
	"serverList.loggedInAs": "Вход как: {email}",
	"serverList.logoutButton": "Выйти",
	"serverList.testButton": "Проверить",
	"serverList.sharesButton": "Общие доступы",
	"serverList.loginRequiredHint": "Войдите, чтобы управлять",
	"serverList.editButton": "Изменить",
	"serverList.removeButton": "Удалить",
	"serverList.removeConfirmMessage":
		"Удалить сервер «{name}»? Вы также выйдете из системы на этом сервере.",
	"serverList.editServerTitle": "Изменить сервер",
	"serverList.addServerTitle": "Добавить сервер",
	"serverList.saveChangesButton": "Сохранить изменения",
	"serverList.addServerCta": "+ Добавить сервер",
	"serverList.controlPlaneUrlLabel": "Адрес control plane",
	"serverList.serverNameLabel":
		"Имя сервера (определяется автоматически, если не указано)",
	"serverList.relayServerUrlLabel":
		"Адрес relay-сервера (определяется автоматически, если не указано)",
	"serverList.autoDetectPlaceholder": "Оставьте пустым для автоопределения",
	"serverList.controlPlaneUrlRequiredError": "Укажите адрес control plane",
	"serverList.cannotConnectError": "Не удаётся подключиться к серверу",
	"serverList.duplicateUrlError":
		"Сервер «{name}» уже использует этот адрес. Измените его вместо добавления дубликата.",
	"serverList.connectionSuccessNotice": "Подключение успешно!",
	"serverList.connectionFailedStatusNotice": "Не удалось подключиться: {status}",
	"serverList.connectionFailedErrorNotice": "Не удалось подключиться: {error}",
	"serverList.serverUpdatedNotice": "Сервер обновлён",
	"serverList.serverAddedNotice": "Сервер добавлен",
	"serverList.serverRemovedNotice": "Сервер «{name}» удалён",
	"serverList.oauthStartingNotice": "Выполняется вход через {provider}...",
	"serverList.oauthWaitingStatus":
		"Ждём, пока вы войдёте в браузере. Если он не открылся, войдите по паролю.",
	"serverList.oauthCancelButton": "Отмена",
	"serverList.oauthUsePasswordButton": "Войти по паролю",
	"serverList.oauthCancelledNotice": "Вход отменён",
	"serverList.loggedInNotice": "Выполнен вход на {name}",
	"serverList.oauthFailedNotice":
		"Не удалось войти через OAuth: {error}. Используется вход по паролю.",
	"serverList.authProviderNotReadyNotice":
		"Провайдер входа ещё не готов. Попробуйте снова.",
	"serverList.loggedOutNotice": "Выход выполнен",
	"serverList.logoutFailedNotice": "Не удалось выйти: {error}",
	"serverList.defaultClearedNotice": "Сервер по умолчанию сброшен",
	"serverList.defaultSetNotice": "Назначен сервером по умолчанию",

	"shareList.title": "Общие доступы на {serverName}",
	"shareList.loading": "Загрузка общих доступов...",
	"shareList.empty": "Общих доступов пока нет. Создайте первый, чтобы начать!",
	"shareList.noServerError": "Сначала добавьте сервер и войдите в систему.",
	"shareList.loadFailedFallback": "Не удалось загрузить общие доступы",

	"shareDetail.loading": "Загрузка сведений об общем доступе...",
	"shareDetail.loadFailedNotice": "Не удалось загрузить сведения: {error}",
	"shareDetail.copyIdButton": "Скопировать ID",
	"shareDetail.idCopiedNotice": "ID общего доступа скопирован",

	"shareDetail.localFolder.heading": "Локальная папка",
	"shareDetail.localFolder.connectedStatus": "Подключено и синхронизируется",
	"shareDetail.localFolder.notConnectedStatus":
		"Не подключено к локальной папке",
	"shareDetail.localFolder.disconnectButton": "Отключить",
	"shareDetail.localFolder.connectButton": "Подключить локальную папку",
	"shareDetail.localFolder.pickerTitle":
		"Выберите локальную папку для этого общего доступа...",
	"shareDetail.localFolder.connectedNotice":
		"Папка подключена! Синхронизация...",
	"shareDetail.localFolder.connectFailedNotice":
		"Не удалось подключить папку: {error}",
	"shareDetail.localFolder.disconnectConfirm":
		"Отключить локальную папку «{path}» от этого общего доступа? Локальные файлы удалены не будут.",
	"shareDetail.localFolder.disconnectedNotice": "Папка отключена",

	"shareDetail.members.heading": "Участники",
	"shareDetail.members.empty": "Участников пока нет.",
	"shareDetail.members.addButton": "Добавить",
	"shareDetail.members.removeButton": "Удалить",
	"shareDetail.members.emailRequiredNotice": "Введите email пользователя",
	"shareDetail.members.addedNotice": "Участник добавлен",
	"shareDetail.members.limitReachedNotice":
		"Достигнут лимит участников ({current}/{max} на тарифе {plan}). Обновите тариф, чтобы добавить больше участников.",
	"shareDetail.members.addFailedFallback": "Не удалось добавить участника",
	"shareDetail.members.roleChangedNotice": "Роль изменена на «{role}»",
	"shareDetail.members.roleChangeFailedNotice":
		"Не удалось изменить роль: {error}",
	"shareDetail.members.removedNotice": "Участник удалён",
	"shareDetail.members.removeFailedNotice":
		"Не удалось удалить участника: {error}",

	"shareDetail.invites.heading": "Ссылки-приглашения",
	"shareDetail.invites.createButton": "Создать приглашение",
	"shareDetail.invites.empty": "Активных ссылок-приглашений нет.",
	"shareDetail.invites.roleSuffix": "Приглашение: {role}",
	"shareDetail.invites.copyLinkButton": "Скопировать ссылку",
	"shareDetail.invites.linkCopiedNotice": "Ссылка-приглашение скопирована!",
	"shareDetail.invites.revokeButton": "Отозвать",
	"shareDetail.invites.revokeConfirm": "Отозвать эту ссылку-приглашение?",
	"shareDetail.invites.revokedNotice": "Приглашение отозвано",
	"shareDetail.invites.revokeFailedNotice":
		"Не удалось отозвать приглашение: {error}",
	"shareDetail.invites.expiredTag": "ИСТЕКЛА",
	"shareDetail.invites.maxUsesReachedTag": "ЛИМИТ ИСЧЕРПАН",
	"shareDetail.invites.expiresLabel": "Истекает: {date}",
	"shareDetail.invites.usesWithMax": "Использований: {used}/{max}",
	"shareDetail.invites.usesNoMax": "Использований: {used}",

	"shareDetail.agentKeys.manageButton": "Управление",
	"shareDetail.agentKeys.desc":
		"API-ключи, дающие автоматическим агентам доступ к этому ресурсу без ваших учётных данных.",

	"shareDetail.webPublish.heading": "Веб-публикация",
	"shareDetail.webPublish.publishLabel": "Опубликовать в вебе",
	"shareDetail.webPublish.webUrlLabel": "Веб-адрес",
	"shareDetail.webPublish.copyButton": "Скопировать",
	"shareDetail.webPublish.openButton": "Открыть",
	"shareDetail.webPublish.urlCopiedNotice": "Адрес скопирован!",
	"shareDetail.webPublish.syncContentLabel": "Синхронизировать содержимое",
	"shareDetail.webPublish.syncNowButton": "Синхронизировать сейчас",
	"shareDetail.webPublish.allowSearchEnginesLabel":
		"Разрешить индексацию поисковиками",
	"shareDetail.webPublish.syncModeLabel": "Режим синхронизации",
	"shareDetail.webPublish.manualOption": "Вручную",
	"shareDetail.webPublish.autoOption": "Автоматически",
	"shareDetail.webPublish.webSlugLabel": "Веб-адрес (slug)",
	"shareDetail.webPublish.webSlugPlaceholder": "my-document",
	"shareDetail.webPublish.saveButton": "Сохранить",
	"shareDetail.webPublish.contentSyncedNotice": "Содержимое синхронизировано!",
	"shareDetail.webPublish.syncedFilesNotice":
		"Синхронизировано файлов: {count}",
	"shareDetail.webPublish.folderSyncedNotice":
		"Папка синхронизирована: {count} объектов",
	"shareDetail.webPublish.couldNotReadDocumentNotice":
		"Не удалось прочитать документ",
	"shareDetail.webPublish.folderEmptyNotice": "Папка пуста",
	"shareDetail.webPublish.syncFailedNotice":
		"Не удалось синхронизировать: {error}",
	"shareDetail.webPublish.indexingDisabledNotice": "Индексация отключена",
	"shareDetail.webPublish.indexingEnabledNotice": "Индексация включена",
	"shareDetail.webPublish.autoSyncEnabledNotice": "Автосинхронизация включена",
	"shareDetail.webPublish.autoSyncDisabledNotice":
		"Автосинхронизация отключена",
	"shareDetail.webPublish.syncModeNotice": "Режим синхронизации: {mode}",
	"shareDetail.webPublish.slugUpdatedNotice": "Slug обновлён: {slug}",
	"shareDetail.webPublish.publishedNotice": "Опубликовано в вебе!",
	"shareDetail.webPublish.unpublishedNotice": "Публикация в вебе отменена",
	"shareDetail.webPublish.publishedWithSkippedNotice":
		"Опубликовано; пропущено файлов: {count} ({files})",
	"shareDetail.webPublish.privatePublishPrompt":
		"Этот общий доступ приватный. Для веб-публикации нужна видимость «публичный» или «защищённый». Выберите, как опубликовать:",
	"shareDetail.webPublish.makePublicChoice":
		"Сделать публичным (открытый доступ)",
	"shareDetail.webPublish.makeProtectedChoice":
		"Сделать защищённым (по паролю)",
	"shareDetail.webPublish.visibilityChangeFailedNotice":
		"Не удалось изменить видимость",
	"shareDetail.webPublish.limitReachedNotice":
		"Достигнут лимит веб-публикаций ({current}/{max} на тарифе {plan}). Обновите тариф, чтобы публиковать больше.",
	"shareDetail.webPublish.visibilityNotAllowedNotice":
		"Видимость «{visibility}» требует более высокого тарифа. На вашем тарифе доступно: {allowed}. Обновите тариф, чтобы снять ограничение.",

	"shareDetail.actions.heading": "Действия",
	"shareDetail.actions.changeVisibilityLabel": "Изменить видимость",
	"shareDetail.actions.changeVisibilityDesc":
		"Определяет, кто может видеть этот общий доступ",
	"shareDetail.actions.privateOption": "Приватный",
	"shareDetail.actions.publicOption": "Публичный",
	"shareDetail.actions.protectedOption": "Защищённый",
	"shareDetail.actions.deleteShareLabel": "Удалить общий доступ",
	"shareDetail.actions.deleteShareDesc":
		"Безвозвратно удалить этот общий доступ",
	"shareDetail.actions.deleteButton": "Удалить",
	"shareDetail.actions.passwordPrompt":
		"Введите пароль для защищённого общего доступа:",
	"shareDetail.actions.visibilityConfirm":
		"Изменить видимость на «{visibility}»?",
	"shareDetail.actions.visibilityChangedNotice":
		"Видимость изменена на «{visibility}»",
	"shareDetail.actions.deleteConfirm":
		"Удалить «{path}»? Это действие необратимо.",
	"shareDetail.actions.deletedNotice": "Общий доступ удалён",
	"shareDetail.actions.deleteFailedNotice": "Не удалось удалить: {error}",

	"createShare.pickerTitle": "Выберите папку для общего доступа...",
	"createShare.pathRequiredNotice": "Выберите путь к папке",
	"createShare.createdNotice": "Общий доступ «{path}» создан!",
	"createShare.limitReachedNotice":
		"Достигнут лимит общих доступов ({current}/{max} на тарифе {plan}). Обновите тариф, чтобы создавать больше.",
	"createShare.createFailedNotice": "Не удалось создать общий доступ: {error}",
	"createShare.title": "Создать общий доступ",
	"createShare.pathLabel": "Путь",
	"createShare.choosePlaceholder": "Выберите папку...",
	"createShare.typeLabel": "Тип",
	"createShare.docOption": "Документ",
	"createShare.folderOption": "Папка",
	"createShare.visibilityLabel": "Видимость",
	"createShare.privateVisibilityOption": "Приватный — только участники",
	"createShare.publicVisibilityOption": "Публичный — доступен по ссылке",
	"createShare.protectedVisibilityOption": "Защищённый — требуется пароль",
	"createShare.passwordPlaceholder":
		"Введите пароль для защищённого общего доступа",

	"createInvite.maxUsesInvalidNotice":
		"Максимальное число использований должно быть положительным числом",
	"createInvite.createdNotice": "Ссылка-приглашение создана!",
	"createInvite.createFailedNotice": "Не удалось создать приглашение: {error}",
	"createInvite.title": "Создать ссылку-приглашение",
	"createInvite.forLabel": "для {path}",
	"createInvite.roleLabel": "Роль",
	"createInvite.expirationLabel": "Срок действия",
	"createInvite.expires7Days": "7 дней",
	"createInvite.expires14Days": "14 дней",
	"createInvite.expires30Days": "30 дней",
	"createInvite.maxUsesLabel": "Максимум использований (необязательно)",
	"createInvite.unlimitedPlaceholder": "Без ограничений",
	"createInvite.createButton": "Создать ссылку-приглашение",

	// Billing & plan screen. Terminology anchored to the already
	// approved teamrelay.ru copy rather than invented here: тариф (not
	// "план"), участник, оплата. "Share" stays «общий доступ», the noun MR2
	// established for this plugin.
	//
	// Two judgment calls worth a reviewer's eye, both flagged on the card:
	//   - "Storage" -> «Место», NOT «Хранилище». The site already spends
	//     «хранилище» on *vault* ("тариф покупается на хранилище"), so using
	//     it again for a disk quota would name two different things with one
	//     word on a screen that shows both.
	//   - "Cancel" (subscription) -> «Отменить», kept apart from the dialog's
	//     «Отмена» -- see the English side's note on why these are two keys.
	"billing.title": "Тариф и оплата",
	"billing.onServer": "на {server}",
	"billing.loading": "Загрузка данных о тарифе...",
	"billing.notConnectedToServer": "Нет подключения к серверу",
	"billing.notConnected": "Нет подключения",
	"billing.loadFailed": "Не удалось загрузить данные о тарифе",
	"billing.unlimited": "Без ограничений",
	"billing.freePrice": "Бесплатно",

	"billing.period.month": "мес",
	"billing.period.year": "год",

	"billing.decimalSeparator": ",",
	"billing.bytes.gigabytes": "{value} ГБ",
	"billing.bytes.megabytes": "{value} МБ",
	"billing.bytes.bytes": "{value} Б",

	"billing.badge.cancelling": "Отменяется",
	"billing.badge.active": "Активен",
	"billing.badge.current": "Текущий",

	"billing.resubscribeButton": "Возобновить",
	"billing.manageButton": "Управление",
	"billing.cancelSubscriptionButton": "Отменить",
	"billing.currentPlanButton": "Текущий тариф",
	"billing.refreshButton": "Обновить",

	"billing.accessUntil": "Доступ до {date}",
	"billing.usageTitle": "Использование",
	"billing.limitReached": "Лимит исчерпан",
	"billing.percentUsed": "использовано {percent}%",

	"billing.usage.shares": "Общие доступы",
	"billing.usage.webPublished": "Веб-публикации",
	"billing.usage.storage": "Место",

	"billing.entitlement.maxShares": "Общие доступы",
	"billing.entitlement.maxMembersPerShare": "Участников на доступ",
	"billing.entitlement.maxWebPublished": "Веб-публикации",
	"billing.entitlement.maxStorageBytes": "Место",
	"billing.entitlement.maxFileSizeBytes": "Максимальный размер файла",
	"billing.entitlement.versionHistoryDays": "Хранение версий, дней",
	"billing.entitlement.rolesEnabled": "Роли",
	"billing.entitlement.closingDocsEdoEnabled": "Закрывающие документы (ЭДО)",
	"billing.entitlement.enabledValue": "Включено",

	"billing.planChangedNotice": "Тариф изменён!",
	"billing.openingCheckoutNotice": "Открываю оплату в браузере...",
	"billing.comingSoonButton": "Скоро",
	"billing.checkoutComingSoonNote":
		"Приём платежей подключается. Оплатить можно будет в ближайшее время.",
	"billing.subscriptionActivatedNotice": "Подписка активирована!",
	"billing.upgradeFailedNotice": "Не удалось сменить тариф: {error}",
	"billing.openingPortalNotice":
		"Открываю управление подпиской в браузере...",
	"billing.portalNotAvailable": "Управление подпиской недоступно",
	"billing.portalFailedNotice":
		"Не удалось открыть управление подпиской: {error}",
	"billing.subscriptionCancelledNotice":
		"Подписка отменена. Доступ сохраняется до конца оплаченного периода.",
	"billing.cancelFailedNotice": "Не удалось отменить подписку: {error}",

	"agentKeys.createAgentKeyButton": "+ Создать ключ агента",
	"agentKeys.createKeyButton": "+ Создать ключ",
	"agentKeys.loading": "Загрузка...",
	"agentKeys.noShares": "На этом сервере нет общих доступов. Создайте общий доступ, чтобы управлять ключами агента.",
	"agentKeys.noKeys": "Для этого общего доступа нет ключей.",
	"agentKeys.label": "Название",
	"agentKeys.created": "Создан",
	"agentKeys.expires": "Истекает",
	"agentKeys.unnamed": "(без названия)",
	"agentKeys.never": "Бессрочно",
	"agentKeys.revokeButton": "Отозвать",
	"agentKeys.justNow": "только что",
	"agentKeys.minutesAgo": "{count} мин. назад",
	"agentKeys.hourAgo": "{count} ч. назад",
	"agentKeys.hoursAgo": "{count} ч. назад",
	"agentKeys.dayAgo": "{count} дн. назад",
	"agentKeys.daysAgo": "{count} дн. назад",
	"agentKeys.monthAgo": "{count} мес. назад",
	"agentKeys.monthsAgo": "{count} мес. назад",
	"agentKeys.createTitle": "Создать ключ агента",
	"agentKeys.labelPlaceholder": "например, ci-bot",
	"agentKeys.share": "Общий доступ",
	"agentKeys.expiry": "Срок действия",
	"agentKeys.thirtyDays": "30 дней",
	"agentKeys.ninetyDays": "90 дней",
	"agentKeys.oneYear": "1 год",
	"agentKeys.reauthButton": "Войти снова",
	"agentKeys.createSubmitButton": "Создать ключ",
	"agentKeys.sessionExpiredError": "Сессия истекла. Войдите снова и повторите попытку.",
	"agentKeys.createError": "Не удалось создать ключ: {error}",
	"agentKeys.shareRemovedNotice": "Общий доступ удалён — ключ недействителен",
	"agentKeys.revokeError": "Не удалось отозвать ключ: {error}",
	"agentKeys.copyError": "Не удалось скопировать ключ",
	"agentKeys.reauthError": "Не удалось войти снова: {error}",
	"agentKeys.genericError": "ошибка",
	"agentKeys.createdTitle": "Ключ создан: {label}",
	"agentKeys.close": "Закрыть",
	"agentKeys.notCopiedWarning": "Вы ещё не скопировали ключ. Нажмите ✕ ещё раз, чтобы всё равно закрыть окно.",
	"agentKeys.saveKeyPrefix": "Сохраните этот ключ — он ",
	"agentKeys.saveKeyEmphasis": "не",
	"agentKeys.saveKeySuffix": " будет показан снова.",
	"agentKeys.copied": "Скопировано!",
	"agentKeys.copyButton": "Скопировать",
	"agentKeys.downloadButton": "Скачать .txt",
	"agentKeys.shareMeta": "Общий доступ: {share}",
	"agentKeys.expiresMeta": "Истекает: {date}",
	"agentKeys.copiedCloseButton": "Ключ скопирован — закрыть",
	"agentKeys.revokeTitle": "Отозвать ключ?",
	"agentKeys.revokePrefix": "Отозвать ",
	"agentKeys.revokeSuffix": "? Это действие нельзя отменить — агент с этим ключом сразу потеряет доступ.",
	"agentKeys.revokeSubmitButton": "Отозвать ключ",
} satisfies Phrasebook;

/**
 * Every phrasebook this build ships, keyed by the ISO code
 * `resolveInterfaceLanguage()` returns. `en` is required and complete (it's
 * the type `englishPhrasebook` itself was declared with); everything else is
 * optional -- `ru` covers every Phase-1 key (see `ruPhrasebook` above); a
 * language with no entry here (e.g. German) falls back to English per-key,
 * not per-phrasebook, via `uiText.ts`.
 */
export const phrasebooksByLanguage: Record<string, Phrasebook> = {
	en: englishPhrasebook,
	ru: ruPhrasebook,
};
