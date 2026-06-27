import { Component, TFile, WorkspaceLeaf, setIcon, normalizePath } from 'obsidian';
import type MuseGardenPlugin from './main';
import { createFileNodeOnCanvas, screenToCanvasPos, type ActiveCanvas } from './canvasNodeCreate';
import type { UndocumentedCanvas, UndocumentedCanvasNode } from './canvasNodeCreate';
import { MUSE_FOLDER_DRAG_MIME, MUSE_TRACK_DRAG_MIME } from './explorerView';
import { getOrCreateProjectForFolder } from './projectStore';
import { WebEmbedModal } from './webEmbedModal';

export class CanvasDropZone extends Component {
	private plugin: MuseGardenPlugin;
	private attached = new WeakSet<HTMLElement>();

	constructor(plugin: MuseGardenPlugin) {
		super();
		this.plugin = plugin;
	}

	onload(): void {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('canvas')) {
			this.attachToLeaf(leaf);
		}
		this.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf && leaf.view.getViewType() === 'canvas') this.attachToLeaf(leaf);
			}),
		);
		this.registerEvent(
			this.plugin.app.workspace.on('layout-change', () => {
				for (const leaf of this.plugin.app.workspace.getLeavesOfType('canvas')) {
					this.attachToLeaf(leaf);
				}
			}),
		);
	}

	private attachToLeaf(leaf: WorkspaceLeaf): void {
		const view = leaf.view as unknown as { containerEl: HTMLElement; canvas?: UndocumentedCanvas };
		const containerEl = view.containerEl;
		if (!containerEl) return;

		this.injectEmbedButton(containerEl);

		if (this.attached.has(containerEl)) return;
		this.attached.add(containerEl);

		containerEl.addEventListener('dragover', (evt: DragEvent) => {
			const types = evt.dataTransfer?.types ?? [];
			if (!types.includes(MUSE_TRACK_DRAG_MIME) && !types.includes(MUSE_FOLDER_DRAG_MIME)) return;
			evt.preventDefault();
			evt.stopPropagation();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'copy';
		}, true);

		containerEl.addEventListener('drop', (evt: DragEvent) => {
			const trackPath = evt.dataTransfer?.getData(MUSE_TRACK_DRAG_MIME) ?? '';
			const folderPath = evt.dataTransfer?.getData(MUSE_FOLDER_DRAG_MIME) ?? '';
			if (!trackPath && !folderPath) return;
			evt.preventDefault();
			evt.stopPropagation();
			void this.handleDrop(view, containerEl, trackPath, folderPath, evt.clientX, evt.clientY);
		}, true);
	}

	private async handleDrop(
		view: { canvas?: UndocumentedCanvas },
		containerEl: HTMLElement,
		trackPath: string,
		folderPath: string,
		clientX: number,
		clientY: number,
	): Promise<void> {
		const canvas = view.canvas;
		if (!canvas) return;
		const pos = screenToCanvasPos(containerEl, clientX, clientY);
		if (!pos) return;
		const active: ActiveCanvas = { canvas, containerEl };

		if (trackPath) {
			const file = this.plugin.app.vault.getAbstractFileByPath(trackPath);
			if (!(file instanceof TFile)) return;
			createFileNodeOnCanvas(active, file, { x: pos.x - 200, y: pos.y - 21 });
			return;
		}

		if (folderPath) {
			const { markerFile } = await getOrCreateProjectForFolder(this.plugin, folderPath);
			if (!(markerFile instanceof TFile)) return;
			createFileNodeOnCanvas(active, markerFile, { x: pos.x - 110, y: pos.y - 70 });
		}
	}

	private injectEmbedButton(containerEl: HTMLElement): void {
		const view = this.plugin.app.workspace.getLeavesOfType('canvas').find(l => l.view.containerEl === containerEl)?.view as ({ canvas?: UndocumentedCanvas }) | undefined;
		const tryInject = () => {
			const menu = containerEl.querySelector('.canvas-card-menu');
			if (!menu) return false;

			if (!menu.querySelector('.muse-add-embed-btn')) {
				const btn = activeDocument.createElement('div');
				btn.className = 'canvas-card-menu-button muse-add-embed-btn';
				btn.setAttribute('aria-label', 'Add web embed (soundcloud/spotify/YouTube/drive)');
				btn.setAttribute('data-tooltip-position', 'top');
				setIcon(btn, 'link');

				btn.addEventListener('click', (evt) => {
					evt.stopPropagation();
					new WebEmbedModal(this.plugin.app).open();
				});

				menu.appendChild(btn);
			}

			if (!menu.querySelector('.muse-filter-btn')) {
				const filterBtn = activeDocument.createElement('div');
				filterBtn.className = 'canvas-card-menu-button muse-filter-btn';
				filterBtn.setAttribute('data-tooltip-position', 'top');
				setIcon(filterBtn, 'filter');

				filterBtn.addEventListener('click', (evt) => {
					evt.stopPropagation();
					const canvas = view?.canvas;
					if (!canvas) return;
					if (!canvas.activeFilterTags) {
						canvas.activeFilterTags = new Set<string>();
					}

					const existing = activeDocument.querySelector('.muse-filter-popup');
					if (existing) {
						existing.remove();
						return;
					}

					this.showFilterPopup(filterBtn, canvas);
				});

				menu.appendChild(filterBtn);
			}

			const canvas = view?.canvas;
			const filterBtn = menu.querySelector('.muse-filter-btn');
			if (filterBtn instanceof HTMLElement && canvas) {
				if (!canvas.activeFilterTags) {
					canvas.activeFilterTags = new Set<string>();
				}
				const filterActive = canvas.activeFilterTags.size > 0;
				filterBtn.classList.toggle('is-active', filterActive);
				if (filterActive) {
					setIcon(filterBtn, 'filter-x');
					filterBtn.setAttribute('aria-label', 'Active canvas filter (click to toggle/clear)');
				} else {
					setIcon(filterBtn, 'filter');
					filterBtn.setAttribute('aria-label', 'Filter canvas by tags');
				}
			}

			return true;
		};

		if (!tryInject()) {
			let attempts = 0;
			const timer = window.setInterval(() => {
				attempts++;
				if (tryInject() || attempts >= 15) {
					window.clearInterval(timer);
				}
			}, 200);
		}
	}

	private getFileForNode(node: UndocumentedCanvasNode | null | undefined): TFile | null {
		if (!node) return null;
		const rawFile = node.file;
		if (rawFile instanceof TFile) return rawFile;

		let path = '';
		if (typeof rawFile === 'string') {
			path = rawFile;
		} else if (rawFile && typeof rawFile === 'object') {
			path = rawFile.path ?? rawFile.filePath ?? '';
		}

		if (!path && node.filePath) {
			path = node.filePath;
		}

		if (!path && node.nodeEl) {
			path = node.nodeEl.dataset?.path ?? node.nodeEl.dataset?.filePath ?? '';
		}

		if (path) {
			const resolved = this.plugin.app.vault.getAbstractFileByPath(normalizePath(path));
			if (resolved instanceof TFile) return resolved;
		}

		return null;
	}

	private getCanvasTags(canvas: UndocumentedCanvas): string[] {
		const tags = new Set<string>();
		if (!canvas || !canvas.nodes) return [];

		for (const [, node] of canvas.nodes) {
			const file = this.getFileForNode(node);
			if (file) {
				const audioTags = this.plugin.settings.tags[file.path]?.tags || [];
				for (const t of audioTags) {
					const cleaned = t.trim().replace(/^#/, '');
					if (cleaned) tags.add(cleaned);
				}

				const project = this.plugin.settings.projects.find((p) => p.markerVaultPath === file.path);
				if (project) {
					if (project.tags) {
						for (const t of project.tags) {
							const cleaned = t.trim().replace(/^#/, '');
							if (cleaned) tags.add(cleaned);
						}
					}
					if (project.folderVaultPath) {
						const folderPrefix = normalizePath(project.folderVaultPath).toLowerCase() + '/';
						const vaultFiles = this.plugin.app.vault.getFiles();
						for (const vf of vaultFiles) {
							const vfPathNorm = normalizePath(vf.path).toLowerCase();
							if (vfPathNorm.startsWith(folderPrefix)) {
								const trackTags = this.plugin.settings.tags[vf.path]?.tags || [];
								for (const t of trackTags) {
									const cleaned = t.trim().replace(/^#/, '');
									if (cleaned) tags.add(cleaned);
								}
							}
						}
					}

					const cache = this.plugin.app.metadataCache.getFileCache(file);
					if (cache) {
						const fileTags = cache.tags || [];
						for (const t of fileTags) {
							const rawTag = typeof t === 'string' ? t : (t && t.tag) || '';
							const cleaned = rawTag.trim().replace(/^#/, '');
							if (cleaned) tags.add(cleaned);
						}
						const fmTags: unknown = cache.frontmatter?.['tags'];
						if (fmTags) {
							const arr = Array.isArray(fmTags) ? fmTags : [fmTags];
							for (const t of arr) {
								const cleaned = String(t).trim().replace(/^#/, '');
								if (cleaned) tags.add(cleaned);
							}
						}
					}
				}
			}

			if (node.text) {
				const matches = node.text.match(/#[a-zA-Z0-9_\-/]+/g);
				if (matches) {
					for (const m of matches) {
						const cleaned = m.slice(1).trim();
						if (cleaned) tags.add(cleaned);
					}
				}
			}

			if (node.nodeEl) {
				const contentEl = node.nodeEl.querySelector('.canvas-node-content');
				if (contentEl && contentEl.textContent) {
					const matches = contentEl.textContent.match(/#[a-zA-Z0-9_\-/]+/g);
					if (matches) {
						for (const m of matches) {
							const cleaned = m.slice(1).trim();
							if (cleaned) tags.add(cleaned);
						}
					}
				}
			}
		}

		return Array.from(tags).sort((a, b) => a.localeCompare(b));
	}

	private showFilterPopup(filterBtn: HTMLElement, canvas: UndocumentedCanvas): void {
		const popup = activeDocument.createElement('div');
		popup.className = 'muse-filter-popup';

		const titleRow = activeDocument.createElement('div');
		titleRow.className = 'muse-filter-popup-title';
		titleRow.textContent = 'Filter canvas by tags';

		const closeBtn = activeDocument.createElement('span');
		closeBtn.className = 'muse-filter-popup-close';
		setIcon(closeBtn, 'x');
		closeBtn.addEventListener('click', () => popup.remove());
		titleRow.appendChild(closeBtn);
		popup.appendChild(titleRow);

		const listContainer = activeDocument.createElement('div');
		listContainer.className = 'muse-filter-popup-list';

		const activeTags = canvas.activeFilterTags ?? new Set<string>();

		const tags = this.getCanvasTags(canvas);
		if (tags.length === 0) {
			const empty = activeDocument.createElement('div');
			empty.className = 'muse-filter-popup-empty';
			empty.textContent = 'No tags found on canvas nodes.';
			listContainer.appendChild(empty);
		} else {
			for (const tag of tags) {
				const row = activeDocument.createElement('div');
				row.className = 'muse-filter-popup-item';

				const checkbox = activeDocument.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.checked = activeTags.has(tag);

				const label = activeDocument.createElement('span');
				label.className = 'muse-filter-popup-item-label';
				label.textContent = `#${tag}`;

				const toggleTag = () => {
					checkbox.checked = !checkbox.checked;
					if (checkbox.checked) {
						activeTags.add(tag);
					} else {
						activeTags.delete(tag);
					}
					filterBtn.classList.toggle('is-active', activeTags.size > 0);
					setIcon(filterBtn, activeTags.size > 0 ? 'filter-x' : 'filter');
					this.plugin.app.workspace.trigger('muse-garden:apply-canvas-filter', canvas);
				};

				row.addEventListener('click', (e: MouseEvent) => {
					if (e.target !== checkbox) {
						toggleTag();
					}
				});
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) {
						activeTags.add(tag);
					} else {
						activeTags.delete(tag);
					}
					filterBtn.classList.toggle('is-active', activeTags.size > 0);
					setIcon(filterBtn, activeTags.size > 0 ? 'filter-x' : 'filter');
					this.plugin.app.workspace.trigger('muse-garden:apply-canvas-filter', canvas);
				});

				row.appendChild(checkbox);
				row.appendChild(label);
				listContainer.appendChild(row);
			}
		}
		popup.appendChild(listContainer);

		if (tags.length > 0) {
			const clearBtn = activeDocument.createElement('div');
			clearBtn.className = 'muse-filter-popup-clear';
			clearBtn.textContent = 'Clear all filters';
			clearBtn.addEventListener('click', () => {
				activeTags.clear();
				const boxes = listContainer.querySelectorAll('input[type="checkbox"]');
				boxes.forEach((b) => { (b as HTMLInputElement).checked = false; });
				filterBtn.classList.remove('is-active');
				setIcon(filterBtn, 'filter');
				this.plugin.app.workspace.trigger('muse-garden:apply-canvas-filter', canvas);
			});
			popup.appendChild(clearBtn);
		}

		activeDocument.body.appendChild(popup);

		const rect = filterBtn.getBoundingClientRect();
		popup.setCssStyles({
			position: 'fixed',
			zIndex: '1000',
			width: '220px',
			left: `${Math.max(10, rect.left + rect.width / 2 - 110)}px`,
			bottom: `${window.innerHeight - rect.top + 8}px`,
		});

		window.setTimeout(() => {
			const handleOutsideClick = (e: MouseEvent) => {
				if (!popup.contains(e.target as Node) && !filterBtn.contains(e.target as Node)) {
					popup.remove();
					activeDocument.removeEventListener('click', handleOutsideClick);
				}
			};
			activeDocument.addEventListener('click', handleOutsideClick);
		}, 0);
	}
}
