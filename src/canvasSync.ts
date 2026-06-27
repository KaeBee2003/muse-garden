import { Component, TFile, setIcon, normalizePath } from 'obsidian';
import type MuseGardenPlugin from './main';
import { findProjectByMarkerPath, getProjectTracks } from './projectStore';
import type { AudioTrack } from './audioStore';
import type { UndocumentedCanvas, UndocumentedCanvasNode } from './canvasNodeCreate';

export class CanvasAudioSync extends Component {
	private plugin: MuseGardenPlugin;
	private observer: MutationObserver | null = null;
	private trackedEmbeds = new WeakMap<Element, () => void>();
	private trackedProjectNodes = new WeakMap<Element, () => void>();

	constructor(plugin: MuseGardenPlugin) {
		super();
		this.plugin = plugin;
	}

	onload(): void {
		this.observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of Array.from(mutation.addedNodes)) {
					if (!(node && node.instanceOf(HTMLElement))) continue;
					this.scanForEmbeds(node);
					this.scanForProjectNodes(node);
				}
			}
			const leaves = this.plugin.app.workspace.getLeavesOfType('canvas');
			for (const leaf of leaves) {
				const canvas = (leaf.view as unknown as { canvas?: UndocumentedCanvas }).canvas;
				if (canvas) this.applyFilterForCanvas(canvas);
			}
		});
		this.observer.observe(activeDocument.body, { childList: true, subtree: true });

		this.scanForEmbeds(activeDocument.body);
		this.scanForProjectNodes(activeDocument.body);

		// Event delegation for ALL play/pause clicks.
		this.registerDomEvent(activeDocument.body, 'click', (evt) => {
			const target = (evt.target as HTMLElement)?.closest<HTMLElement>('[data-muse-play-path]');
			if (!target) return;
			evt.stopPropagation();
			const vaultPath = target.dataset.musePlayPath;
			if (vaultPath) this.plugin.player.togglePlayPauseFor(vaultPath);
		});

		// Re-render all canvas nodes when settings/tags change.
		this.registerEvent(
			this.plugin.app.workspace.on(
				'muse-garden:settings-changed' as Parameters<typeof this.plugin.app.workspace.on>[0],
				() => {
					this.trackedEmbeds = new WeakMap();
					this.trackedProjectNodes = new WeakMap();
					this.scanForEmbeds(activeDocument.body);
					this.scanForProjectNodes(activeDocument.body, true);

					const leaves = this.plugin.app.workspace.getLeavesOfType('canvas');
					for (const leaf of leaves) {
						const canvas = (leaf.view as unknown as { canvas?: UndocumentedCanvas }).canvas;
						if (canvas) this.applyFilterForCanvas(canvas);
					}
				},
			),
		);

		this.registerEvent(
			this.plugin.app.workspace.on(
				'muse-garden:apply-canvas-filter' as Parameters<typeof this.plugin.app.workspace.on>[0],
				(canvas: unknown) => {
					this.applyFilterForCanvas(canvas as UndocumentedCanvas);
				}
			)
		);

		this.registerInterval(
			window.setInterval(() => {
				const leaves = this.plugin.app.workspace.getLeavesOfType('canvas');
				for (const leaf of leaves) {
					const canvas = (leaf.view as unknown as { canvas?: UndocumentedCanvas }).canvas;
					if (canvas) {
						this.applyFilterForCanvas(canvas);
					}
				}
			}, 150)
		);

		// File deleted → show warning overlay on matching canvas nodes.
		this.registerEvent(
			this.plugin.app.vault.on('delete', (abstractFile) => {
				if (!(abstractFile instanceof TFile)) return;
				this.showMissingFileWarning(abstractFile.path);
			}),
		);

		// File renamed → remove warnings (the file is still there, just moved).
		this.registerEvent(
			this.plugin.app.vault.on('rename', () => {
				this.scanForEmbeds(activeDocument.body);
			}),
		);
	}

	onunload(): void {
		this.observer?.disconnect();
		this.observer = null;
	}

	private scanForEmbeds(root: HTMLElement): void {
		const candidates: Element[] = [];
		if (root.matches?.('.canvas-node-content.audio-embed')) candidates.push(root);
		candidates.push(...Array.from(root.querySelectorAll('.canvas-node-content.audio-embed')));

		for (const embed of candidates) {
			this.upgradeEmbed(embed as HTMLElement);
		}
	}

	private upgradeEmbed(embed: HTMLElement): void {
		const audioEl = embed.querySelector('audio');
		if (!audioEl) return;

		const file = this.resolveFileFromSrc(audioEl.src);
		if (!file) return;

		for (const old of Array.from(embed.querySelectorAll('.muse-canvas-node-card'))) old.remove();

		audioEl.setCssStyles({ display: 'none' });

		const card = activeDocument.createElement('div');
		card.className = 'muse-canvas-node-card';

		const topRow = activeDocument.createElement('div');
		topRow.className = 'muse-canvas-node-toprow';
		card.appendChild(topRow);

		const button = activeDocument.createElement('button');
		button.className = 'muse-canvas-node-playbtn';
		button.setAttribute('aria-label', `Play ${file.basename}`);
		button.dataset.musePlayPath = file.path;
		const icon = activeDocument.createElement('span');
		icon.className = 'muse-canvas-node-playbtn-icon';
		setIcon(icon, 'play');
		button.appendChild(icon);
		topRow.appendChild(button);

		const progress = activeDocument.createElement('div');
		progress.className = 'muse-canvas-node-progress';
		const progressFill = activeDocument.createElement('div');
		progressFill.className = 'muse-canvas-node-progress-fill';
		progress.appendChild(progressFill);
		topRow.appendChild(progress);

		embed.appendChild(card);

		if (this.plugin.settings.showTagsOnAudioNodes) {
			const tags = this.plugin.settings.tags[file.path]?.tags ?? [];
			if (tags.length > 0) {
				const tagRow = activeDocument.createElement('div');
				tagRow.className = 'muse-canvas-node-tags';
				for (const tag of tags) {
					const chip = activeDocument.createElement('span');
					chip.className = 'muse-canvas-node-tag-chip';
					chip.textContent = tag;
					tagRow.appendChild(chip);
				}
				card.appendChild(tagRow);
			}
		}

		const unsubscribePlayback = this.plugin.player.subscribe((state) => {
			const isThisTrackPlaying = state.vaultPath === file.path && state.isPlaying;
			setIcon(icon, isThisTrackPlaying ? 'pause' : 'play');
			button.classList.toggle('is-playing', isThisTrackPlaying);
		});
		const unsubscribeProgress = this.plugin.player.subscribeProgress((progressState) => {
			if (progressState.vaultPath !== file.path) {
				progressFill.setCssStyles({ width: '0%' });
				return;
			}
			const pct = progressState.duration > 0 ? (progressState.currentTime / progressState.duration) * 100 : 0;
			progressFill.setCssStyles({ width: `${pct}%` });
		});

		this.trackedEmbeds.set(embed, () => {
			unsubscribePlayback();
			unsubscribeProgress();
		});

		this.cleanupWhenRemoved(embed, this.trackedEmbeds);
	}

	private scanForProjectNodes(root: HTMLElement, force = false): void {
		const candidates: Element[] = [];
		if (root.matches?.('.canvas-node')) candidates.push(root);
		candidates.push(...Array.from(root.querySelectorAll('.canvas-node')));

		for (const node of candidates) {
			this.tryUpgradeProjectNode(node as HTMLElement, force);
		}
	}

	private tryUpgradeProjectNode(nodeEl: HTMLElement, force = false): void {
		const contentEl = nodeEl.querySelector('.canvas-node-content.markdown-embed');
		if (!(contentEl instanceof HTMLElement)) return;

		const nodeDataPath = nodeEl.dataset.path ?? nodeEl.dataset.filePath ?? '';
		let project = nodeDataPath
			? this.plugin.settings.projects.find((p) => p.markerVaultPath === nodeDataPath)
			: undefined;

		if (!project) {
			const labelEl = nodeEl.querySelector('.canvas-node-label');
			const labelText = labelEl?.textContent?.trim();
			if (labelText) {
				project = this.plugin.settings.projects.find((p) => {
					const markerFileName = p.markerVaultPath.split('/').pop() ?? '';
					const markerNameNoExt = markerFileName.replace(/\.md$/i, '');
					return markerNameNoExt === labelText;
				});
			}
		}

		if (!project) return;

		const existingCard = nodeEl.querySelector('.muse-project-card');
		if (existingCard && !force && existingCard.querySelector('[data-muse-play-path]')) return;

		this.upgradeProjectNode(nodeEl, contentEl, project.markerVaultPath);
	}

	private upgradeProjectNode(nodeEl: HTMLElement, contentEl: HTMLElement, markerVaultPath: string): void {
		const project = findProjectByMarkerPath(this.plugin, markerVaultPath);
		if (!project) return;

		while (contentEl.firstChild) contentEl.removeChild(contentEl.firstChild);

		const card = activeDocument.createElement('div');
		card.className = 'muse-project-card';

		const header = activeDocument.createElement('div');
		header.className = 'muse-project-card-header';
		const headerIcon = activeDocument.createElement('span');
		headerIcon.className = 'muse-project-card-header-icon';
		setIcon(headerIcon, 'folder');
		header.appendChild(headerIcon);
		header.appendChild(activeDocument.createTextNode(project.label));
		card.appendChild(header);

		if (this.plugin.settings.showTagsOnProjectNodes && project.tags.length > 0) {
			const projectTagsEl = activeDocument.createElement('div');
			projectTagsEl.className = 'muse-project-card-tags';
			for (const tag of project.tags) {
				const chip = activeDocument.createElement('span');
				chip.className = 'muse-project-card-tag-chip';
				chip.textContent = tag;
				projectTagsEl.appendChild(chip);
			}
			card.appendChild(projectTagsEl);
		}

		const trackListEl = activeDocument.createElement('div');
		trackListEl.className = 'muse-project-card-tracks';
		card.appendChild(trackListEl);

		contentEl.appendChild(card);

		const renderTracks = () => {
			while (trackListEl.firstChild) trackListEl.removeChild(trackListEl.firstChild);

			const tracks = getProjectTracks(this.plugin, project);
			if (tracks.length === 0) {
				const empty = activeDocument.createElement('div');
				empty.className = 'muse-project-card-empty';
				empty.textContent = 'No audio files in this folder.';
				trackListEl.appendChild(empty);
				return;
			}
			for (const track of tracks) {
				trackListEl.appendChild(this.buildProjectTrackRow(track));
			}
		};
		renderTracks();

		this.trackedProjectNodes.set(nodeEl, () => {
			card.remove();
		});
		this.cleanupWhenRemoved(nodeEl, this.trackedProjectNodes);
	}

	private buildProjectTrackRow(track: AudioTrack): HTMLElement {
		const wrapper = activeDocument.createElement('div');
		wrapper.className = 'muse-project-track-wrapper';

		const row = activeDocument.createElement('div');
		row.className = 'muse-project-track-row';
		row.dataset.musePlayPath = track.vaultPath;
		wrapper.appendChild(row);

		const icon = activeDocument.createElement('span');
		icon.className = 'muse-project-track-icon';
		setIcon(icon, 'play');
		row.appendChild(icon);

		const name = activeDocument.createElement('span');
		name.className = 'muse-project-track-name';
		name.textContent = track.name;
		row.appendChild(name);

		const progress = activeDocument.createElement('div');
		progress.className = 'muse-project-track-progress';
		const progressFill = activeDocument.createElement('div');
		progressFill.className = 'muse-project-track-progress-fill';
		progress.appendChild(progressFill);
		row.appendChild(progress);

		if (this.plugin.settings.showTagsInProjectAudioList && track.tags.length > 0) {
			const tagRow = activeDocument.createElement('div');
			tagRow.className = 'muse-project-track-tags';
			for (const tag of track.tags) {
				const chip = activeDocument.createElement('span');
				chip.className = 'muse-project-track-tag-chip';
				chip.textContent = tag;
				tagRow.appendChild(chip);
			}
			wrapper.appendChild(tagRow);
		}

		const unsubscribePlayback = this.plugin.player.subscribe((state) => {
			const isThisTrackPlaying = state.vaultPath === track.vaultPath && state.isPlaying;
			setIcon(icon, isThisTrackPlaying ? 'pause' : 'play');
			row.classList.toggle('is-playing', isThisTrackPlaying);
		});
		const unsubscribeProgress = this.plugin.player.subscribeProgress((progressState) => {
			if (progressState.vaultPath !== track.vaultPath) {
				progressFill.setCssStyles({ width: '0%' });
				return;
			}
			const pct = progressState.duration > 0 ? (progressState.currentTime / progressState.duration) * 100 : 0;
			progressFill.setCssStyles({ width: `${pct}%` });
		});

		// Clean up when this specific row leaves the DOM.
		const removalObserver = new MutationObserver(() => {
			if (!activeDocument.body.contains(wrapper)) {
				unsubscribePlayback();
				unsubscribeProgress();
				removalObserver.disconnect();
			}
		});
		removalObserver.observe(activeDocument.body, { childList: true, subtree: true });

		return wrapper;
	}

	private showMissingFileWarning(deletedVaultPath: string): void {
		const embeds = Array.from(activeDocument.querySelectorAll('.canvas-node-content.audio-embed'));
		for (const embed of embeds) {
			const card = embed.querySelector('.muse-canvas-node-card');
			if (!card) continue;

			const playBtn = card.querySelector('[data-muse-play-path]');
			if (!(playBtn instanceof HTMLElement) || playBtn.dataset.musePlayPath !== deletedVaultPath) continue;

			while (card.firstChild) card.removeChild(card.firstChild);
			card.classList.add('muse-canvas-node-card--missing');

			const warningRow = activeDocument.createElement('div');
			warningRow.className = 'muse-missing-warning-row';

			const warningIcon = activeDocument.createElement('span');
			warningIcon.className = 'muse-missing-icon';
			setIcon(warningIcon, 'alert-triangle');
			warningRow.appendChild(warningIcon);

			const warningMsg = activeDocument.createElement('span');
			warningMsg.className = 'muse-missing-msg';
			warningMsg.textContent = 'File not found';
			warningRow.appendChild(warningMsg);
			card.appendChild(warningRow);

			const btnRow = activeDocument.createElement('div');
			btnRow.className = 'muse-missing-btn-row';

			const relocateBtn = activeDocument.createElement('button');
			relocateBtn.className = 'muse-missing-btn';
			relocateBtn.textContent = 'Relocate…';
			relocateBtn.addEventListener('click', () => {
				this.openRelocatePicker(embed as HTMLElement, deletedVaultPath);
			});
			btnRow.appendChild(relocateBtn);

			const removeBtn = activeDocument.createElement('button');
			removeBtn.className = 'muse-missing-btn mod-warning';
			removeBtn.textContent = 'Remove node';
			removeBtn.addEventListener('click', () => {
				const canvasNode = (embed as HTMLElement).closest('.canvas-node');
				if (canvasNode) canvasNode.remove();
			});
			btnRow.appendChild(removeBtn);
			card.appendChild(btnRow);
		}
	}

	private openRelocatePicker(embed: HTMLElement, _oldPath: string): void {
		const audioExts = new Set(this.plugin.settings.audioExtensions.map((e) => e.toLowerCase()));
		const allAudioFiles = this.plugin.app.vault
			.getFiles()
			.filter((f) => audioExts.has(f.extension.toLowerCase()));

		if (allAudioFiles.length === 0) {
			return;
		}

		const existing = embed.querySelector('.muse-relocate-picker');
		if (existing) { existing.remove(); return; }

		const picker = activeDocument.createElement('div');
		picker.className = 'muse-relocate-picker';

		for (const file of allAudioFiles.sort((a, b) => a.basename.localeCompare(b.basename))) {
			const item = activeDocument.createElement('div');
			item.className = 'muse-relocate-item';
			item.textContent = file.basename;
			item.addEventListener('click', () => {
				picker.remove();
				const audioEl = embed.querySelector('audio');
				if (audioEl) {
					audioEl.src = this.plugin.app.vault.getResourcePath(file);
					audioEl.setCssStyles({ display: 'none' });
				}
				this.upgradeEmbed(embed);
			});
			picker.appendChild(item);
		}

		embed.appendChild(picker);
		window.setTimeout(() => {
			const close = (e: MouseEvent) => {
				if (!picker.contains(e.target as Node)) {
					picker.remove();
					activeDocument.removeEventListener('click', close);
				}
			};
			activeDocument.addEventListener('click', close);
		}, 0);
	}

	private cleanupWhenRemoved(el: Element, registry: WeakMap<Element, () => void>): void {
		const removalObserver = new MutationObserver(() => {
			if (!activeDocument.body.contains(el)) {
				registry.get(el)?.();
				registry.delete(el);
				removalObserver.disconnect();
			}
		});
		removalObserver.observe(activeDocument.body, { childList: true, subtree: true });
	}

	/** Match an <audio> element's resource URL back to a vault TFile. */
	private resolveFileFromSrc(src: string): TFile | null {
		const files = this.plugin.app.vault.getFiles();
		for (const file of files) {
			const resourcePath = this.plugin.app.vault.getResourcePath(file).split('?')[0];
			if (src.split('?')[0] === resourcePath) return file;
		}
		return null;
	}

	private getFileForNode(node: UndocumentedCanvasNode): TFile | null {
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

	private applyFilterForCanvas(canvas: UndocumentedCanvas): void {
		if (!canvas) return;

		const activeTags = canvas.activeFilterTags;
		const filterActive = activeTags && activeTags.size > 0;

		if (!filterActive) {
			if (canvas.nodes) {
				for (const [, node] of canvas.nodes) {
					if (node.nodeEl) {
						node.nodeEl.setCssStyles({ display: '' });
						node.nodeEl.classList.remove('muse-filtered-out');
					}
				}
			}
			if (canvas.edges) {
				for (const [id, edge] of canvas.edges) {
					for (const key in edge) {
						const val = edge[key];
						if (key.endsWith('El') && val && val instanceof HTMLElement) {
							val.setCssStyles({ display: '' });
							val.classList.remove('muse-filtered-out');
						}
					}
					const domElements = activeDocument.querySelectorAll(`[data-id="${id}"]`);
					domElements.forEach((el) => {
						(el as HTMLElement).setCssStyles({ display: '' });
						el.classList.remove('muse-filtered-out');
					});
				}
			}
			return;
		}

		const activeTagsLower = new Set<string>();
		for (const tag of activeTags) {
			const cleaned = tag.toLowerCase().trim().replace(/^#/, '');
			if (cleaned) activeTagsLower.add(cleaned);
		}

		const taggedNodeIds = new Set<string>();

		if (canvas.nodes) {
			for (const [id, node] of canvas.nodes) {
				let hasTag = false;
				const file = this.getFileForNode(node);

				if (file) {
					const audioTags = this.plugin.settings.tags[file.path]?.tags || [];
					if (audioTags.some((t: string) => activeTagsLower.has(t.toLowerCase().trim().replace(/^#/, '')))) {
						hasTag = true;
					}

					const project = this.plugin.settings.projects.find((p) => p.markerVaultPath === file.path);
					if (project) {
						if (project.tags && project.tags.some((t: string) => activeTagsLower.has(t.toLowerCase().trim().replace(/^#/, '')))) {
							hasTag = true;
						}
						if (project.folderVaultPath) {
							const folderPrefix = normalizePath(project.folderVaultPath).toLowerCase() + '/';
							const vaultFiles = this.plugin.app.vault.getFiles();
							for (const vf of vaultFiles) {
								const vfPathNorm = normalizePath(vf.path).toLowerCase();
								if (vfPathNorm.startsWith(folderPrefix)) {
									const trackTags = this.plugin.settings.tags[vf.path]?.tags || [];
									if (trackTags.some((t: string) => activeTagsLower.has(t.toLowerCase().trim().replace(/^#/, '')))) {
										hasTag = true;
										break;
									}
								}
							}
						}
					}

					const cache = this.plugin.app.metadataCache.getFileCache(file);
					if (cache) {
						const fileTags = cache.tags || [];
						if (fileTags.some((t) => {
							const rawTag = typeof t === 'string' ? t : (t && t.tag) || '';
							return activeTagsLower.has(rawTag.toLowerCase().trim().replace(/^#/, ''));
						})) {
							hasTag = true;
						}
						const frontmatterTags: unknown = cache.frontmatter?.['tags'];
						if (frontmatterTags) {
							const arr = Array.isArray(frontmatterTags) ? frontmatterTags : [frontmatterTags];
							if (arr.some((t) => activeTagsLower.has(String(t).toLowerCase().trim().replace(/^#/, '')))) {
								hasTag = true;
							}
						}
					}
				}

				if (node.text) {
					const matches = node.text.match(/#[a-zA-Z0-9_\-/]+/g);
					if (matches) {
						for (const m of matches) {
							const cleaned = m.slice(1).toLowerCase().trim();
							if (activeTagsLower.has(cleaned)) {
								hasTag = true;
								break;
							}
						}
					}
				}

				if (node.nodeEl) {
					const contentEl = node.nodeEl.querySelector('.canvas-node-content');
					if (contentEl && contentEl.textContent) {
						const matches = contentEl.textContent.match(/#[a-zA-Z0-9_\-/]+/g);
						if (matches) {
							for (const m of matches) {
								const cleaned = m.slice(1).toLowerCase().trim();
								if (activeTagsLower.has(cleaned)) {
									hasTag = true;
									break;
								}
							}
						}
					}
				}

				if (hasTag) {
					taggedNodeIds.add(id);
				}
			}
		}

		// BFS to find all nodes in connected components containing tagged nodes
		const visibleNodeIds = new Set<string>(taggedNodeIds);
		const queue: string[] = Array.from(taggedNodeIds);

		const adj = new Map<string, Set<string>>();
		if (canvas.edges) {
			for (const [, edge] of canvas.edges) {
				const fromId = edge.from?.node?.id ?? edge.fromNode?.id ?? edge.from?.id;
				const toId = edge.to?.node?.id ?? edge.toNode?.id ?? edge.to?.id;
				if (fromId && toId) {
					if (!adj.has(fromId)) adj.set(fromId, new Set());
					if (!adj.has(toId)) adj.set(toId, new Set());
					adj.get(fromId)!.add(toId);
					adj.get(toId)!.add(fromId);
				}
			}
		}

		while (queue.length > 0) {
			const currId = queue.shift()!;
			const neighbors = adj.get(currId);
			if (neighbors) {
				for (const nbrId of neighbors) {
					if (!visibleNodeIds.has(nbrId)) {
						visibleNodeIds.add(nbrId);
						queue.push(nbrId);
					}
				}
			}
		}

		if (canvas.nodes) {
			for (const [id, node] of canvas.nodes) {
				if (node.nodeEl) {
					if (visibleNodeIds.has(id)) {
						node.nodeEl.setCssStyles({ display: '' });
						node.nodeEl.classList.remove('muse-filtered-out');
					} else {
						node.nodeEl.setCssStyles({ display: 'none' });
						node.nodeEl.classList.add('muse-filtered-out');
					}
				}
			}
		}

		if (canvas.edges) {
			for (const [id, edge] of canvas.edges) {
				const fromId = edge.from?.node?.id ?? edge.fromNode?.id ?? edge.from?.id;
				const toId = edge.to?.node?.id ?? edge.toNode?.id ?? edge.to?.id;
				const visible = !!(fromId && toId && visibleNodeIds.has(fromId) && visibleNodeIds.has(toId));
				const displayValue = visible ? '' : 'none';

				for (const key in edge) {
					const val = edge[key];
					if (key.endsWith('El') && val && val instanceof HTMLElement) {
						val.setCssStyles({ display: displayValue });
						if (visible) {
							val.classList.remove('muse-filtered-out');
						} else {
							val.classList.add('muse-filtered-out');
						}
					}
				}

				const domElements = activeDocument.querySelectorAll(`[data-id="${id}"]`);
				domElements.forEach((el) => {
					(el as HTMLElement).setCssStyles({ display: displayValue });
					if (visible) {
						el.classList.remove('muse-filtered-out');
					} else {
						el.classList.add('muse-filtered-out');
					}
				});
			}
		}
	}
}
