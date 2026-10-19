import type { TFile, TextFileView, WorkspaceLeaf } from "obsidian";

/**
 * Structural types for Obsidian's built-in Canvas plugin. It ships no
 * public type declarations, so these mirror only the shape our sync code
 * actually touches — not the plugin's full internal surface.
 */

export interface HostCanvasNode {
	id: string;
	getData(): CanvasNodeData;
	setText(text: string): void;
}

export interface HostCanvasEdge {
	id: string;
	getData(): CanvasEdgeData;
}

export type CanvasItem = HostCanvasNode | HostCanvasEdge;

export interface CanvasNodeData {
	id: string;
	type: string;
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	file?: TFile;
	child?: TextFileView;
}

export interface CanvasEdgeData {
	id: string;
	fromNode: string;
	fromSide: string;
	toNode: string;
	toSide: string;
}

export interface CanvasData {
	nodes: CanvasNodeData[];
	edges: CanvasEdgeData[];
}

export interface HostCanvas extends TextFileView {
	__proto__: unknown;
	nodes: Map<string, HostCanvasNode>;
	edges: Map<string, HostCanvasEdge>;
	getData(): CanvasData;
	importData(data: CanvasData, noclue: boolean): void;
	applyHistory(data: unknown): void;
	markMoved(item: CanvasItem): void;
	markDirty(item: CanvasItem): void;
	requestSave(): void;
}

export interface HostCanvasView {
	getViewType(): "canvas";
	file?: TFile;
	containerEl: HTMLElement;
	leaf: WorkspaceLeaf;
	data: string;
	canvas: HostCanvas;
	setViewData(data: string, clear: boolean): void;
}
