import { Component, TFile, WorkspaceLeaf, setIcon, normalizePath } from 'obsidian';
import type MuseGardenPlugin from './main';
import { createFileNodeOnCanvas, screenToCanvasPos, type ActiveCanvas } from './canvasNodeCreate';
import type { UndocumentedCanvas } from './canvasNodeCreate';
import { MUSE_FOLDER_DRAG_MIME, MUSE_TRACK_DRAG_MIME } from './explorerView';
import { getOrCreateProjectForFolder } from './projectStore';
import { WebEmbedModal } from './webEmbedModal';

/**
 * Lets MuseGarden Explorer tracks AND folders be dragged directly onto an
 * open Canvas (folders become Project nodes via a marker file — see
 * projectStore.ts for why a marker file is required).
 *
 * DELIBERATELY built on standard HTML5 drag-and-drop only:
 *  - Explorer rows set a custom dataTransfer MIME type (no Obsidian internals).
 *  - This class listens for ondragover/ondrop on each canvas view's own
 *    container element (just a normal DOM listener on a normal element).
 *  - The drop position is converted from screen to canvas-space by reading
 *    Canvas's own CSS transform (see screenToCanvasPos) — not by calling any
 *    internal coordinate-conversion method.
 *  - The only undocumented touchpoint is `canvas.createFileNode()` itself,
 *    which we'd already accepted for the "Send to active canvas" menu item.
 *
 * This means Muse Garden's drag-and-drop keeps working even if Obsidian
 * changes how its OWN internal drag manager works, since we never touch it.
 */
export class CanvasDropZone extends Component {
	private plugin: MuseGardenPlugin;
	private attached = new WeakSet<HTMLElement>();

	constructor(plugin: MuseGardenPlugin) {
		super();
		this.plugin = plugin;
	}

	onload(): void {
		// Attach to any canvas views already open.
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('canvas')) {
			this.attachToLeaf(leaf);
		}
		// Attach to canvas views opened later.
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

		// Use capture phase so our handlers run before Obsidian's own canvas
		// drag-and-drop handlers, which might swallow the event first.
		containerEl.addEventListener('dragover', (evt) => {
			const types = evt.dataTransfer?.types ?? [];
			if (!types.includes(MUSE_TRACK_DRAG_MIME) && !types.includes(MUSE_FOLDER_DRAG_MIME)) return;
			evt.preventDefault(); // required for drop to fire
			evt.stopPropagation();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'copy';
		}, true); // capture phase

		containerEl.addEventListener('drop', (evt) => {
			// IMPORTANT: dataTransfer is nulled out after the synchronous drop event
			// completes. Read all getData() values here — synchronously — before
			// passing them into the async handler as plain strings.
			const trackPath = evt.dataTransfer?.getData(MUSE_TRACK_DRAG_MIME) ?? '';
			const folderPath = evt.dataTransfer?.getData(MUSE_FOLDER_DRAG_MIME) ?? '';
			if (!trackPath && !folderPath) return;
			evt.preventDefault();
			evt.stopPropagation();
			void this.handleDrop(view, containerEl, trackPath, folderPath, evt.clientX, evt.clientY);
		}, true); // capture phase
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
			// Center the ~400x42 default audio node on the cursor.
			createFileNodeOnCanvas(active, file, { x: pos.x - 200, y: pos.y - 21 });
			return;
		}

		if (folderPath) {
			const { markerFile } = await getOrCreateProjectForFolder(this.plugin, folderPath);
			if (!(markerFile instanceof TFile)) return;
			// Project cards default to a taller layout (see canvasSync.ts), center accordingly.
			createFileNodeOnCanvas(active, markerFile, { x: pos.x - 110, y: pos.y - 70 });
		}
	}

	private injectEmbedButton(containerEl: HTMLElement): void {
		const view = this.plugin.app.workspace.getLeavesOfType('canvas').find(l => l.view.containerEl === containerEl)?.view as any;
		const tryInject = () => {
			const menu = containerEl.querySelector('.canvas-card-menu');
			if (!menu) return false;

			// 1. Inject Add Web Embed button if not present
			if (!menu.querySelector('.muse-add-embed-btn')) {
				const btn = document.createElement('div');
				btn.className = 'canvas-card-menu-button muse-add-embed-btn';
				btn.setAttribute('aria-label', 'Add Web Embed (SoundCloud/Spotify/YouTube/Drive)');
				btn.setAttribute('data-tooltip-position', 'top');
				setIcon(btn, 'link');

				btn.addEventListener('click', (evt) => {
					evt.stopPropagation();
					new WebEmbedModal(this.plugin.app).open();
				});

				menu.appendChild(btn);
			}

			// 2. Inject Canvas Filter button if not present
			if (!menu.querySelector('.muse-filter-btn')) {
				const filterBtn = document.createElement('div');
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

					const existing = document.querySelector('.muse-filter-popup');
					if (existing) {
						existing.remove();
						return;
					}

					this.showFilterPopup(filterBtn, canvas);
				});

				menu.appendChild(filterBtn);
			}

			// Update the filter button UI states
			const canvas = view?.canvas;
			const filterBtn = menu.querySelector('.muse-filter-btn') as HTMLElement | null;
			if (filterBtn && canvas) {
				if (!canvas.activeFilterTags) {
					canvas.activeFilterTags = new Set<string>();
				}
				const filterActive = canvas.activeFilterTags.size > 0;
				filterBtn.classList.toggle('is-active', filterActive);
				if (filterActive) {
					setIcon(filterBtn, 'filter-x');
					filterBtn.setAttribute('aria-label', 'Active Canvas Filter (Click to toggle/clear)');
				} else {
					setIcon(filterBtn, 'filter');
					filterBtn.setAttribute('aria-label', 'Filter Canvas by Tags');
				}
			}

			return true;
		};

		if (!tryInject()) {
			let attempts = 0;
			const timer = setInterval(() => {
				attempts++;
				if (tryInject() || attempts >= 15) {
					clearInterval(timer);
				}
			}, 200);
		}
	}

	private getFileForNode(node: any): TFile | null {
		if (!node) return null;
		let file = node.file;
		if (file instanceof TFile) return file;

		let path = '';
		if (typeof file === 'string') {
			path = file;
		} else if (file && typeof file === 'object') {
			path = file.path || file.filePath || '';
		}

		if (!path && node.filePath) {
			path = node.filePath;
		}

		if (!path && node.nodeEl) {
			path = node.nodeEl.dataset?.path || node.nodeEl.dataset?.filePath || '';
		}

		if (path) {
			const resolved = this.plugin.app.vault.getAbstractFileByPath(normalizePath(path));
			if (resolved instanceof TFile) return resolved;
		}

		return null;
	}

	private getCanvasTags(canvas: any): string[] {
		const tags = new Set<string>();
		if (!canvas || !canvas.nodes) return [];

		for (const [id, node] of canvas.nodes) {
			const file = this.getFileForNode(node);
			if (file) {
				// 1. Audio node tags
				const audioTags = this.plugin.settings.tags[file.path]?.tags || [];
				for (const t of audioTags) {
					const cleaned = t.trim().replace(/^#/, '');
					if (cleaned) tags.add(cleaned);
				}

				// 2. Project node tags and project track tags
				const project = this.plugin.settings.projects.find((p) => p.markerVaultPath === file.path);
				if (project) {
					if (project.tags) {
						for (const t of project.tags) {
							const cleaned = t.trim().replace(/^#/, '');
							if (cleaned) tags.add(cleaned);
						}
					}
					// Scan folder tracks
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
				}

				// 3. General file cache tags and frontmatter
				const cache = this.plugin.app.metadataCache.getFileCache(file);
				if (cache) {
					const fileTags = cache.tags || [];
					for (const t of fileTags) {
						const rawTag = typeof t === 'string' ? t : (t && (t as any).tag) || '';
						const cleaned = rawTag.trim().replace(/^#/, '');
						if (cleaned) tags.add(cleaned);
					}
					const fmTags = cache.frontmatter?.tags;
					if (fmTags) {
						const arr = Array.isArray(fmTags) ? fmTags : [fmTags];
						for (const t of arr) {
							const cleaned = String(t).trim().replace(/^#/, '');
							if (cleaned) tags.add(cleaned);
						}
					}
				}
			}

			// 4. Text node content hashtags
			if (node.text) {
				const matches = node.text.match(/#[a-zA-Z0-9_\-/]+/g);
				if (matches) {
					for (const m of matches) {
						const cleaned = m.slice(1).trim();
						if (cleaned) tags.add(cleaned);
					}
				}
			}

			// 5. DOM text content hashtags
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

	private showFilterPopup(filterBtn: HTMLElement, canvas: any): void {
		const popup = document.createElement('div');
		popup.className = 'muse-filter-popup';

		const titleRow = document.createElement('div');
		titleRow.className = 'muse-filter-popup-title';
		titleRow.textContent = 'Filter Canvas by Tags';

		const closeBtn = document.createElement('span');
		closeBtn.className = 'muse-filter-popup-close';
		setIcon(closeBtn, 'x');
		closeBtn.addEventListener('click', () => popup.remove());
		titleRow.appendChild(closeBtn);
		popup.appendChild(titleRow);

		const listContainer = document.createElement('div');
		listContainer.className = 'muse-filter-popup-list';

		const tags = this.getCanvasTags(canvas);
		if (tags.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'muse-filter-popup-empty';
			empty.textContent = 'No tags found on canvas nodes.';
			listContainer.appendChild(empty);
		} else {
			for (const tag of tags) {
				const row = document.createElement('div');
				row.className = 'muse-filter-popup-item';

				const checkbox = document.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.checked = canvas.activeFilterTags.has(tag);

				const label = document.createElement('span');
				label.className = 'muse-filter-popup-item-label';
				label.textContent = `#${tag}`;

				const toggleTag = () => {
					checkbox.checked = !checkbox.checked;
					if (checkbox.checked) {
						canvas.activeFilterTags.add(tag);
					} else {
						canvas.activeFilterTags.delete(tag);
					}
					filterBtn.classList.toggle('is-active', canvas.activeFilterTags.size > 0);
					if (canvas.activeFilterTags.size > 0) {
						setIcon(filterBtn, 'filter-x');
					} else {
						setIcon(filterBtn, 'filter');
					}
					this.plugin.app.workspace.trigger('muse-garden:apply-canvas-filter', canvas);
				};

				row.addEventListener('click', (e) => {
					if (e.target !== checkbox) {
						toggleTag();
					}
				});
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) {
						canvas.activeFilterTags.add(tag);
					} else {
						canvas.activeFilterTags.delete(tag);
					}
					filterBtn.classList.toggle('is-active', canvas.activeFilterTags.size > 0);
					if (canvas.activeFilterTags.size > 0) {
						setIcon(filterBtn, 'filter-x');
					} else {
						setIcon(filterBtn, 'filter');
					}
					this.plugin.app.workspace.trigger('muse-garden:apply-canvas-filter', canvas);
				});

				row.appendChild(checkbox);
				row.appendChild(label);
				listContainer.appendChild(row);
			}
		}
		popup.appendChild(listContainer);

		if (tags.length > 0) {
			const clearBtn = document.createElement('div');
			clearBtn.className = 'muse-filter-popup-clear';
			clearBtn.textContent = 'Clear all filters';
			clearBtn.addEventListener('click', () => {
				canvas.activeFilterTags.clear();
				const boxes = listContainer.querySelectorAll('input[type="checkbox"]');
				boxes.forEach((b: any) => b.checked = false);
				filterBtn.classList.remove('is-active');
				setIcon(filterBtn, 'filter');
				this.plugin.app.workspace.trigger('muse-garden:apply-canvas-filter', canvas);
			});
			popup.appendChild(clearBtn);
		}

		document.body.appendChild(popup);

		const rect = filterBtn.getBoundingClientRect();
		popup.style.position = 'fixed';
		popup.style.zIndex = '1000';
		popup.style.width = '220px';
		popup.style.left = `${Math.max(10, rect.left + rect.width / 2 - 110)}px`;
		popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;

		setTimeout(() => {
			const handleOutsideClick = (e: MouseEvent) => {
				if (!popup.contains(e.target as Node) && !filterBtn.contains(e.target as Node)) {
					popup.remove();
					document.removeEventListener('click', handleOutsideClick);
				}
			};
			document.addEventListener('click', handleOutsideClick);
		}, 0);
	}
}
