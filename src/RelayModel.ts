import type { RequestUrlResponse } from "obsidian";
import type { Subscribable } from "./notifiers/Notifier";
import type { NotifierMap } from "./notifiers/NotifierMap";

export type AccessLevel = "Owner" | "Member" | "Reader";

export type PermissionTarget = [string, string];

// Local composition primitives — not part of the wire contract, only used to
// build up the record shapes below.
type WithId = { id: string };
type Syncable<T> = { update(update: unknown): T };
type Downloadable = {
	attachmentUrl(): Promise<string>;
	getAttachment(): Promise<RequestUrlResponse>;
};
type Dictable = { toDict: () => unknown };

export type PermissionGrant =
	| readonly ["folder", "read_content"]
	| readonly ["folder", "edit_content"]
	| readonly ["folder", "manage_files"]
	| readonly ["folder", "upload"]
	| readonly ["folder", "download"]
	| readonly ["folder", "manage_users"]
	| readonly ["folder", "make_private"] // TODO
	| readonly ["folder", "rename"]
	| readonly ["folder", "delete"]
	| readonly ["relay", "rename"]
	| readonly ["relay", "manage_users"]
	| readonly ["relay", "manage_sharing"]
	| readonly ["relay", "delete"]
	| readonly ["subscription", "manage"];

export interface SigningAuthority
	extends Syncable<SigningAuthority>,
		Subscribable<SigningAuthority> {
	displayName: string;
	authorityId: string;
	endpointUrl: string;
	isSelfManaged: boolean;
	signingKey: string;
	keyAlgorithm: string;
	keyFingerprint: string;
}

export interface StorageAllocation
	extends WithId,
		Subscribable<StorageAllocation>,
		Syncable<StorageAllocation> {
	allocationName: string;
	quotaBytes: number;
	usedBytes: number;
	maxFileSizeBytes: number;
	isMetered: boolean;
}

export interface WorkspaceUser extends WithId, Syncable<WorkspaceUser> {
	displayName: string;
	avatarUrl: string;
	userEmail: string;
}

export interface Company extends WithId, Syncable<Company> {
	id: string;
	name: string;
}

export interface RelayWorkspace
	extends Syncable<RelayWorkspace>,
		Subscribable<RelayWorkspace> {
	recordId: string;
	workspaceGuid: string;
	displayName: string;
	schemaVersion: number;
	memberLimit: number;
	accessRole: AccessLevel;
	isOwner: boolean;
	pendingInvitation?: WorkspaceInvitation;
	quotaAllocation?: StorageAllocation;
	quotaAllocationId: string;
	folderMap: NotifierMap<string, RemoteFolderRecord>;
	subscriptionMap: NotifierMap<string, WorkspaceSubscription>;
	callToAction: string;
	billingPlan: string;
	signingProvider?: SigningAuthority;
	signingProviderId?: string;
	parentScopes: [string, string][];
}

export interface RemoteFolderRecord
	extends Syncable<RemoteFolderRecord>,
		Subscribable<RemoteFolderRecord> {
	recordId: string;
	folderGuid: string;
	folderName: string;
	isPrivate: boolean;
	accessRole: AccessLevel;
	isOwner: boolean;
	workspace: RelayWorkspace;
	workspaceId: string;
	creatorUser: WorkspaceUser;
	creatorUserId: string;
	parentScopes: [string, string][];
}

export interface WorkspaceMembership extends Syncable<WorkspaceMembership> {
	membershipId: string;
	member: WorkspaceUser;
	memberId: string;
	accessRole: AccessLevel;
	workspace: RelayWorkspace;
	workspaceId: string;
}

export interface FolderMembership extends Syncable<FolderMembership> {
	membershipId: string;
	member: WorkspaceUser;
	memberId: string;
	accessRole: AccessLevel;
	folder: RemoteFolderRecord;
	folderId: string;
}

export interface WorkspaceInvitation extends Syncable<WorkspaceInvitation> {
	invitationId: string;
	grantedRole: AccessLevel;
	workspace: RelayWorkspace;
	workspaceId: string;
	inviteCode: string;
	isEnabled: boolean;
}

export interface WorkspaceSubscription
	extends Syncable<WorkspaceSubscription>,
		Subscribable<WorkspaceSubscription> {
	subscriptionId: string;
	isActive: boolean;
	workspace: RelayWorkspace;
	workspaceId: string;
	subscriber: WorkspaceUser;
	expiresAt: Date | null;
	seatCount: number;
	billingToken: string;
}

export interface FileRecord
	extends Syncable<FileRecord>,
		Downloadable,
		Dictable {
	recordId: string;
	fileGuid: string;
	workspace: RelayWorkspace;
	parentId: string | null;
	folder: RemoteFolderRecord;
	localCtime: number;
	localMtime: number;
	contentHash: string;
	lastSyncedAt: number;
	updatedAt: string;
	createdAt: string;
	type: string;
	fileName: string;
	removedAt: number | null;
	previousParentId: string | null;
	isFolder: boolean;
}

export interface FileUploadRecord extends FileRecord {
	attachment: null | Blob | File;
}
