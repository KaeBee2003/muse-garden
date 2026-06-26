import { ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type { App } from 'obsidian';

/**
 * Minimal shape of the undocumented `Canvas` runtime object exposed as
 * `(canvasLeafView).canvas`. Obsidian does not publish a typed/documented
 * API for mutating an already-open canvas — only the on-disk .canvas JSON
 * format is documented. This interface covers exactly the members we rely
 * on; all have been stable across recent Obsidian releases and are used by
 * other popular canvas plugins, but could change without notice on update.
 */
export interface UndocumentedCanvas {
	viewportBounds?: () => { x: number; y: number; width: number; height: number };
	createFileNode: (options: { file: TFile; pos: { x: number; y: number } }) => void;
	requestSave?: () => void;
	/** The pannable/zoomable inner element; its CSS transform encodes canvas-space <-> screen-space conversion. */
	canvasEl?: HTMLElement;
}

export interface ActiveCanvas {
	canvas: UndocumentedCanvas;
	containerEl: HTMLElement;
}

/** Finds the currently active/open canvas view, if any. */
export function getActiveCanvas(app: App): ActiveCanvas | null {
	const leaf: WorkspaceLeaf | undefined = app.workspace.getLeavesOfType('canvas')[0];
	const view = leaf?.view as (ItemView & { canvas?: UndocumentedCanvas }) | undefined;
	if (!view?.canvas) return null;
	return { canvas: view.canvas, containerEl: view.containerEl };
}

/** Adds a file node to `target` canvas at canvas-space position `pos`. */
export function createFileNodeOnCanvas(target: ActiveCanvas, file: TFile, pos: { x: number; y: number }): void {
	target.canvas.createFileNode({ file, pos });
	target.canvas.requestSave?.();
}

/**
 * Converts a viewport (screen) pixel coordinate into canvas-space
 * coordinates, by reading the live CSS transform Canvas applies to its own
 * `.canvas` element (visible via DevTools as e.g.
 * `transform: translate(360.5px, 477.5px) scale(1) translate(0px, 0px);`)
 * and inverting it. This relies only on reading a CSS style value — no
 * internal Canvas methods — so it stays correct even if Canvas's internal
 * API surface changes, as long as it keeps using a CSS transform for
 * pan/zoom (which is how virtually every infinite-canvas web UI works).
 */
export function screenToCanvasPos(
	containerEl: HTMLElement,
	screenX: number,
	screenY: number,
): { x: number; y: number } | null {
	const canvasEl = containerEl.querySelector('.canvas') as HTMLElement | null;
	if (!canvasEl) return null;

	const rect = canvasEl.getBoundingClientRect();
	const transform = getComputedStyle(canvasEl).transform;

	// getComputedStyle resolves the transform to a matrix() string regardless
	// of how it was authored (translate/scale chains, matrix(), etc), so we
	// don't need to parse the raw translate/scale syntax ourselves.
	const matrix = new DOMMatrix(transform);

	// rect already reflects the transform's visual effect, so the
	// container's own top-left in screen space, divided by scale, gives us
	// the canvas-space offset directly.
	const scale = matrix.a || 1; // matrix.a === matrix.d for uniform scale, which Canvas always uses
	const x = (screenX - rect.left) / scale;
	const y = (screenY - rect.top) / scale;
	return { x, y };
}

export function notifyNoCanvasOpen(): void {
	new Notice('Open a canvas first, then try again.');
}
