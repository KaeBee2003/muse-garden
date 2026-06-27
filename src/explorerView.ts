import { App, ItemView, Menu, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type MuseGardenPlugin from './main';
import {
	AudioTrack,
	ExplorerQuery,
	FolderNode,
	buildFolderTree,
	filterTree,
	getAllKnownTags,
} from './audioStore';
import { TagManagerModal } from './tagManagerModal';
import { createFileNodeOnCanvas, getActiveCanvas, notifyNoCanvasOpen, type ActiveCanvas } from './canvasNodeCreate';
import { getOrCreateProjectForFolder } from './projectStore';

export const VIEW_TYPE_MUSE_EXPLORER = 'muse-garden-explorer';
export const MUSE_TRACK_DRAG_MIME = 'application/x-muse-garden-path';
export const MUSE_FOLDER_DRAG_MIME = 'application/x-muse-garden-folder-path';

export class MuseExplorerView extends ItemView {
	private plugin: MuseGardenPlugin;
	private query: ExplorerQuery = { nameQuery: '', tags: [] };
	private listEl!: HTMLElement;
	/** Vault paths of folders currently expanded; collapsed by default except when a search is active. */
	private expandedFolders = new Set<string>();

	constructor(leaf: WorkspaceLeaf, plugin: MuseGardenPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_MUSE_EXPLORER;
	}

	getDisplayText(): string {
		return 'Muse garden explorer';
	}

	getIcon(): string {
		return 'muse-garden-logo';
	}

	async onOpen(): Promise<void> {
		this.render();

		// Re-render when files change on disk/vault so new exports show up
		// without needing to close/reopen the panel.
		this.registerEvent(this.app.vault.on('create', () => this.render()));
		this.registerEvent(this.app.vault.on('delete', () => this.render()));
		this.registerEvent(this.app.vault.on('rename', () => this.render()));

		// Re-render when tags/settings change — use render() not renderList()
		// so the full explorer (including tag filter chips) is rebuilt.
		this.registerEvent(
			this.app.workspace.on('muse-garden:settings-changed' as Parameters<typeof this.app.workspace.on>[0], () =>
				this.render(),
			),
		);
	}

	async onClose(): Promise<void> {
		// Nothing to clean up; registerEvent handles listener teardown.
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass('muse-garden-explorer');

		// ── Toolbar row (search + Manage Tags button) ──────────────────────
		const toolbar = container.createDiv({ cls: 'muse-explorer-toolbar' });

		// Name search input
		const searchWrap = toolbar.createDiv({ cls: 'muse-search-wrap' });
		const searchInput = searchWrap.createEl('input', {
			type: 'text',
			placeholder: 'Search by song name…',
			cls: 'muse-search-input',
		});
		searchInput.value = this.query.nameQuery;
		searchInput.addEventListener('input', () => {
			this.query = { ...this.query, nameQuery: searchInput.value };
			this.renderList();
		});

		const manageTagsBtn = toolbar.createEl('button', {
			cls: 'muse-manage-tags-btn',
			attr: { 'aria-label': 'Manage tags' },
		});
		setIcon(manageTagsBtn, 'tag');
		manageTagsBtn.createSpan({ text: 'Tags', cls: 'muse-manage-tags-label' });
		manageTagsBtn.addEventListener('click', () => {
			new TagManagerModal(this.app, this.plugin, { kind: 'global' }, () => this.renderList()).open();
		});

		// ARIA label text does not require sentence case

		// ── Tag filter chips row ───────────────────────────────────────────
		const chipRow = container.createDiv({ cls: 'muse-tag-filter-row' });
		this.renderTagFilterRow(chipRow);

		// ── Empty-state hint if no directories configured ──────────────────
		if (this.plugin.settings.directories.length === 0) {
			container.createDiv({
				cls: 'muse-empty-state',
				text: 'No folders linked yet. Add one in Settings → Muse Garden.',
			});
			this.renderSettingsFooter(container);
			return;
		}

		this.listEl = container.createDiv({ cls: 'muse-track-list' });
		this.renderList();
		this.renderSettingsFooter(container);
	}

	private renderTagFilterRow(chipRow: HTMLElement): void {
		chipRow.empty();

		// Active tag chips (removable)
		for (const tag of this.query.tags) {
			const chip = chipRow.createSpan({ cls: 'muse-filter-chip' });
			chip.createSpan({ text: tag });
			const remove = chip.createSpan({ cls: 'muse-filter-chip-remove', text: '×' });
			remove.addEventListener('click', () => {
				this.query = { ...this.query, tags: this.query.tags.filter((t) => t !== tag) };
				this.render();
			});
		}

		// "+" button to add a tag filter from known tags
		const addBtn = chipRow.createEl('button', { cls: 'muse-filter-add-btn', text: '+ filter tag' });
		addBtn.addEventListener('click', (evt) => {
			const allKnown = getAllKnownTags(this.plugin);
			if (allKnown.length === 0) return;

			const menu = new Menu();
			for (const tag of allKnown) {
				if (this.query.tags.includes(tag)) continue; // already filtering by this
				menu.addItem((item) =>
					item.setTitle(tag).setIcon('tag').onClick(() => {
						this.query = { ...this.query, tags: [...this.query.tags, tag] };
						this.render();
					}),
				);
			}
			menu.showAtMouseEvent(evt);
		});
	}

	private renderList(): void {
		if (!this.listEl) return;
		this.listEl.empty();

		const allRoots = buildFolderTree(this.plugin);
		const hasQuery = this.query.nameQuery.trim().length > 0 || this.query.tags.length > 0;
		const roots = filterTree(allRoots, this.query);

		const totalTracks = countTracks(allRoots);
		const matchedTracks = countTracks(roots);

		if (matchedTracks === 0) {
			this.listEl.createDiv({
				cls: 'muse-empty-state',
				text: totalTracks === 0 ? 'No audio files found.' : 'No matches.',
			});
			return;
		}

		for (const root of roots) {
			// While searching, force every matching branch open so results are
			// visible without the user having to manually expand anything.
			this.renderFolderRow(root, 0, hasQuery);
		}
	}

	private renderFolderRow(folder: FolderNode, depth: number, forceExpanded: boolean): void {
		const isExpanded = forceExpanded || this.expandedFolders.has(folder.vaultPath);

		const row = this.listEl.createDiv({ cls: 'muse-folder-row' });
		row.style.setProperty('--muse-depth', String(depth));
		row.setAttribute('draggable', 'true');

		const chevron = row.createSpan({ cls: 'muse-folder-chevron' });
		setIcon(chevron, isExpanded ? 'chevron-down' : 'chevron-right');
		const folderIcon = row.createSpan({ cls: 'muse-folder-icon' });
		setIcon(folderIcon, isExpanded ? 'folder-open' : 'folder');
		row.createSpan({ cls: 'muse-folder-name', text: folder.name });

		// Show project tags on folder row, gated on showTagsInExplorer
		const hasQuery = this.query.nameQuery.trim().length > 0 || this.query.tags.length > 0;
		const showTags = hasQuery
			? this.plugin.settings.showTagsInSearchResults
			: this.plugin.settings.showTagsInExplorer;

		if (showTags) {
			const existingProjectForTags = this.plugin.settings.projects.find(
				(p) => p.folderVaultPath === folder.vaultPath,
			);
			if (existingProjectForTags && existingProjectForTags.tags.length > 0) {
				const tagsEl = row.createSpan({ cls: 'muse-folder-tags' });
				for (const tag of existingProjectForTags.tags) {
					tagsEl.createSpan({ cls: 'muse-tag-chip', text: tag });
				}
			}
		}

		const toggle = () => {
			if (this.expandedFolders.has(folder.vaultPath)) {
				this.expandedFolders.delete(folder.vaultPath);
			} else {
				this.expandedFolders.add(folder.vaultPath);
			}
			this.renderList();
		};
		chevron.addEventListener('click', (evt) => {
			evt.stopPropagation();
			toggle();
		});
		row.addEventListener('click', toggle);

		// Drag the folder itself onto canvas -> creates a Project node.
		row.addEventListener('dragstart', (evt) => {
			if (!evt.dataTransfer) return;
			evt.dataTransfer.setData(MUSE_FOLDER_DRAG_MIME, folder.vaultPath);
			evt.dataTransfer.effectAllowed = 'copy';
			row.addClass('is-dragging');
		});
		row.addEventListener('dragend', () => row.removeClass('is-dragging'));

		row.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle('Send to active canvas as project')
					.setIcon('layout-grid')
					.onClick(() => this.sendFolderToActiveCanvas(folder.vaultPath)),
			);
			menu.addItem((item) =>
				item
					.setTitle('Add/manage tags…')
					.setIcon('tag')
					.onClick(() => {
						new TagManagerModal(
							this.app,
							this.plugin,
							{ kind: 'project', folderVaultPath: folder.vaultPath },
							() => {
								void getOrCreateProjectForFolder(this.plugin, folder.vaultPath).then(() => this.renderList());
							},
						).open();
					}),
			);
			menu.showAtMouseEvent(evt);
		});

		if (!isExpanded) return;

		for (const subfolder of folder.subfolders) {
			this.renderFolderRow(subfolder, depth + 1, forceExpanded);
		}
		for (const track of folder.tracks) {
			this.renderTrackRow(track, depth + 1);
		}
	}

	private renderTrackRow(track: AudioTrack, depth: number): void {
		const row = this.listEl.createDiv({ cls: 'muse-track-row' });
		row.style.setProperty('--muse-depth', String(depth));
		row.dataset.path = track.vaultPath;
		row.setAttribute('draggable', 'true');

		row.addEventListener('dragstart', (evt) => {
			if (!evt.dataTransfer) return;
			// Custom MIME type, read back by CanvasDropZone. Standard HTML5
			// drag API only — no Obsidian internals involved in producing
			// this drag at all.
			evt.dataTransfer.setData(MUSE_TRACK_DRAG_MIME, track.vaultPath);
			evt.dataTransfer.effectAllowed = 'copy';
			row.addClass('is-dragging');
		});
		row.addEventListener('dragend', () => row.removeClass('is-dragging'));

		const trackIcon = row.createSpan({ cls: 'muse-track-icon' });
		setIcon(trackIcon, 'music');

		const info = row.createDiv({ cls: 'muse-track-info' });
		info.createDiv({ cls: 'muse-track-name', text: track.name });

		// Show track tags, gated on showTagsInExplorer / showTagsInSearchResults
		const hasQuery = this.query.nameQuery.trim().length > 0 || this.query.tags.length > 0;
		const showTags = hasQuery
			? this.plugin.settings.showTagsInSearchResults
			: this.plugin.settings.showTagsInExplorer;

		if (showTags && track.tags.length > 0) {
			const tagsEl = info.createDiv({ cls: 'muse-track-tags' });
			for (const tag of track.tags) {
				tagsEl.createSpan({ cls: 'muse-tag-chip', text: tag });
			}
		}

		// Play on click.
		row.addEventListener('click', (evt) => {
			// Avoid hijacking clicks on the tag chips themselves later if we add remove-buttons.
			if ((evt.target as HTMLElement).closest('.muse-tag-chip')) return;
			this.plugin.player.play(track.vaultPath);
		});

		// Right-click: add/remove tag, reveal in system explorer.
		row.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle('Add/manage tags…')
					.setIcon('tag')
					.onClick(() => {
						new TagManagerModal(
							this.app,
							this.plugin,
							{ kind: 'track', vaultPath: track.vaultPath },
							() => this.renderList(),
						).open();
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle('Send to active canvas')
					.setIcon('layout-grid')
					.onClick(() => this.sendToActiveCanvas(track.vaultPath)),
			);
			menu.showAtMouseEvent(evt);
		});
	}

	private renderSettingsFooter(container: HTMLElement): void {
		const footer = container.createDiv({ cls: 'muse-explorer-footer' });
		const btn = footer.createEl('button', { cls: 'muse-explorer-settings-btn', attr: { 'aria-label': 'Muse garden settings' } });
		const iconEl = btn.createEl('span');
		setIcon(iconEl, 'settings');
		btn.createSpan({ text: 'Muse garden settings', cls: 'muse-explorer-settings-label' });
		btn.addEventListener('click', () => {
			// Open Obsidian settings and navigate directly to the Muse Garden tab.
			type SettingsApp = App & { setting: { open(): void; openTabById(id: string): void } };
			const app = this.app as unknown as SettingsApp;
			app.setting.open();
			app.setting.openTabById('muse-garden');
		});
	}

	/** Adds a file node for `vaultPath` to the currently active canvas, near the viewport center. */
	private sendToActiveCanvas(vaultPath: string): void {
		const active = getActiveCanvas(this.app);
		if (!active) {
			notifyNoCanvasOpen();
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!(file instanceof TFile)) return;

		const { x, y } = this.viewportCenter(active);
		createFileNodeOnCanvas(active, file, { x: x - 100, y: y - 21 });
	}

	/** Creates (or reuses) a Project marker for `folderVaultPath` and adds it to the active canvas. */
	private async sendFolderToActiveCanvas(folderVaultPath: string): Promise<void> {
		const active = getActiveCanvas(this.app);
		if (!active) {
			notifyNoCanvasOpen();
			return;
		}
		const { markerFile } = await getOrCreateProjectForFolder(this.plugin, folderVaultPath);
		if (!(markerFile instanceof TFile)) return;

		const { x, y } = this.viewportCenter(active);
		createFileNodeOnCanvas(active, markerFile, { x: x - 110, y: y - 70 });
	}

	private viewportCenter(active: ActiveCanvas): { x: number; y: number } {
		const viewport = active.canvas.viewportBounds?.() ?? { x: 0, y: 0, width: 400, height: 300 };
		return { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
	}
}

function countTracks(roots: FolderNode[]): number {
	let count = 0;
	const visit = (node: FolderNode) => {
		count += node.tracks.length;
		for (const sub of node.subfolders) visit(sub);
	};
	for (const root of roots) visit(root);
	return count;
}
