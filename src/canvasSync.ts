import { Component, TFile, setIcon, normalizePath } from 'obsidian';
import type MuseGardenPlugin from './main';
import { findProjectByMarkerPath, getProjectTracks } from './projectStore';
import type { AudioTrack } from './audioStore';

/**
 * Watches the DOM for:
 *  1. Obsidian's built-in canvas audio embeds (`.canvas-node-content.audio-embed`)
 *     — replaced with a slim play/pause button wired into the shared player.
 *  2. Canvas nodes embedding one of our Project marker files (see
 *     projectStore.ts) — replaced with a custom Project card listing that
 *     folder's direct tracks, each independently playable.
 *
 * Both cases keep playback routed through the one shared MuseGardenPlayer,
 * so a track started from a Project card, an Audio node, the Explorer, or
 * the bottom bar are always perfectly in sync.
 *
 * STABILITY NOTE: this depends on class names Obsidian gives canvas node
 * content (inspectable via DevTools, Ctrl+Shift+I) and on matching a node's
 * embedded file back to data we already control (vault file src for audio,
 * our own settings.projects list for markers) — not on any private Canvas
 * method. If a future Obsidian update changes these class names, the fix is
 * just re-inspecting the DOM and updating the selectors below.
 */
export class CanvasAudioSync extends Component {
	private plugin: MuseGardenPlugin;
	private observer: MutationObserver | null = null;
	// Track per-embed cleanup so we can unsubscribe from the player when a
	// node is removed from the DOM (canvas scrolled away, node deleted, etc).
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
					if (!(node instanceof HTMLElement)) continue;
					this.scanForEmbeds(node);
					this.scanForProjectNodes(node);
				}
			}
			const leaves = this.plugin.app.workspace.getLeavesOfType('canvas');
			for (const leaf of leaves) {
				const canvas = (leaf.view as any).canvas;
				if (canvas) this.applyFilterForCanvas(canvas);
			}
		});
		this.observer.observe(document.body, { childList: true, subtree: true });

		// Catch anything already on screen when the plugin loads (e.g. a
		// canvas that was open before the plugin was enabled/reloaded).
		this.scanForEmbeds(document.body);
		this.scanForProjectNodes(document.body);

		// Event delegation for ALL play/pause clicks (audio nodes AND project
		// card track rows), via one permanent listener instead of one
		// per-button closure. This is deliberate: if Obsidian ever detaches
		// and reuses a node's DOM subtree on tab close/reopen rather than
		// fully removing it (we can't verify which internally — it's
		// undocumented), a per-button click listener can end up silently
		// orphaned even though the button is still visible. A single
		// delegated listener on document.body can't go stale this way: it
		// always reads the target file fresh from a data-attribute on click,
		// rather than from a closure captured at button-creation time.
		this.registerDomEvent(document.body, 'click', (evt) => {
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
					// Full rebuild: clear tracked sets so upgradeEmbed/upgradeProjectNode
					// run fresh instead of skipping already-present cards.
					this.trackedEmbeds = new WeakMap();
					this.trackedProjectNodes = new WeakMap();
					this.scanForEmbeds(document.body);
					this.scanForProjectNodes(document.body, true);
					
					const leaves = this.plugin.app.workspace.getLeavesOfType('canvas');
					for (const leaf of leaves) {
						const canvas = (leaf.view as any).canvas;
						if (canvas) this.applyFilterForCanvas(canvas);
					}
				},
			),
		);

		this.registerEvent(
			this.plugin.app.workspace.on(
				'muse-garden:apply-canvas-filter' as any,
				(canvas: any) => {
					this.applyFilterForCanvas(canvas);
				}
			)
		);

		this.registerInterval(
			window.setInterval(() => {
				const leaves = this.plugin.app.workspace.getLeavesOfType('canvas');
				for (const leaf of leaves) {
					const canvas = (leaf.view as any).canvas;
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
				// Re-scan so any previously-upgraded embeds that matched the old
				// path are rebuilt with the new path.
				this.scanForEmbeds(document.body);
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
		if (!file) return; // couldn't match to a vault file; leave Obsidian's default player alone

		// Self-heal: remove ALL existing cards and rebuild fresh, rather than
		// trusting that a present card is still correctly wired. This is
		// intentionally more defensive than a presence-only dedup check —
		// see the onload() comment above for why a present-but-stale button
		// is a real failure mode we've seen, not just a theoretical one.
		for (const old of Array.from(embed.querySelectorAll('.muse-canvas-node-card'))) old.remove();

		// Hide (don't remove) Obsidian's own element: removing it can upset
		// Canvas's internal bookkeeping for the node; hiding is safer and
		// still lets us fall back gracefully if our button fails for any reason.
		audioEl.style.display = 'none';

		// Outer wrapper: gives us real padding on all sides, independent of
		// whatever Obsidian's own .canvas-node-content box-model is doing.
		const card = document.createElement('div');
		card.className = 'muse-canvas-node-card';

		// Top row: play/pause button on the LEFT, seek/progress bar filling
		// the rest of the width on the right.
		const topRow = document.createElement('div');
		topRow.className = 'muse-canvas-node-toprow';
		card.appendChild(topRow);

		const button = document.createElement('button');
		button.className = 'muse-canvas-node-playbtn';
		button.setAttribute('aria-label', `Play ${file.basename}`);
		button.dataset.musePlayPath = file.path; // read by the delegated click handler in onload()
		const icon = document.createElement('span');
		icon.className = 'muse-canvas-node-playbtn-icon';
		setIcon(icon, 'play');
		button.appendChild(icon);
		topRow.appendChild(button);

		// No filename label here by design — the canvas node's own
		// .canvas-node-label already shows the filename right above this
		// card, so repeating it inside would be redundant clutter.
		const progress = document.createElement('div');
		progress.className = 'muse-canvas-node-progress';
		const progressFill = document.createElement('div');
		progressFill.className = 'muse-canvas-node-progress-fill';
		progress.appendChild(progressFill);
		topRow.appendChild(progress);

		embed.appendChild(card);

		// Tags on audio nodes — gated on showTagsOnAudioNodes
		if (this.plugin.settings.showTagsOnAudioNodes) {
			const tags = this.plugin.settings.tags[file.path]?.tags ?? [];
			if (tags.length > 0) {
				const tagRow = document.createElement('div');
				tagRow.className = 'muse-canvas-node-tags';
				for (const tag of tags) {
					const chip = document.createElement('span');
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
				progressFill.style.width = '0%';
				return;
			}
			const pct = progressState.duration > 0 ? (progressState.currentTime / progressState.duration) * 100 : 0;
			progressFill.style.width = `${pct}%`;
		});

		this.trackedEmbeds.set(embed, () => {
			unsubscribePlayback();
			unsubscribeProgress();
		});

		this.cleanupWhenRemoved(embed, this.trackedEmbeds);
	}

	private scanForProjectNodes(root: HTMLElement, force = false): void {
		// Project markers render as ordinary markdown file embeds; we don't
		// rely on a special CSS class to find them (unlike audio, there's no
		// distinct "this is a project marker" class) — instead we check every
		// canvas node's label/title against our own known marker paths.
		const candidates: Element[] = [];
		if (root.matches?.('.canvas-node')) candidates.push(root);
		candidates.push(...Array.from(root.querySelectorAll('.canvas-node')));

		for (const node of candidates) {
			this.tryUpgradeProjectNode(node as HTMLElement, force);
		}
	}

	private tryUpgradeProjectNode(nodeEl: HTMLElement, force = false): void {
		// Narrow to markdown-note embeds first (confirmed via DevTools:
		// `.canvas-node-content.markdown-embed`) so we don't bother checking
		// labels on text/link/group nodes that could never be a marker anyway.
		const contentEl = nodeEl.querySelector('.canvas-node-content.markdown-embed') as HTMLElement | null;
		if (!contentEl) return;

		// Try to match via data-path attribute first (most reliable), then
		// fall back to label text comparison.
		const nodeDataPath = nodeEl.dataset.path ?? nodeEl.dataset.filePath ?? '';
		let project = nodeDataPath
			? this.plugin.settings.projects.find((p) => p.markerVaultPath === nodeDataPath)
			: undefined;

		if (!project) {
			// Fallback: match by label text (strip .md extension as Obsidian does)
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

		// Skip the rebuild ONLY if a card is already present AND still has
		// at least one wired-up track row that responds to the delegated
		// click pattern (i.e. has the data attribute). A card with zero
		// rows, or one some Obsidian-internal DOM-reuse has left in a stale
		// state, gets rebuilt fresh rather than trusted at face value — same
		// reasoning as upgradeEmbed's full self-heal rebuild.
		const existingCard = nodeEl.querySelector('.muse-project-card');
		if (existingCard && !force && existingCard.querySelector('[data-muse-play-path]')) return;

		this.upgradeProjectNode(nodeEl, contentEl, project.markerVaultPath);
	}

	private upgradeProjectNode(nodeEl: HTMLElement, contentEl: HTMLElement, markerVaultPath: string): void {
		const project = findProjectByMarkerPath(this.plugin, markerVaultPath);
		if (!project) return;

		// Match the working audio-embed pattern: build our card INSIDE
		// contentEl (clearing its existing children) rather than hiding
		// contentEl and appending a sibling. contentEl (.canvas-node-content)
		// is the element Obsidian actually sizes to fill the node, so our
		// card needs to live inside it to inherit that sizing correctly.
		while (contentEl.firstChild) contentEl.removeChild(contentEl.firstChild);

		const card = document.createElement('div');
		card.className = 'muse-project-card';

		const header = document.createElement('div');
		header.className = 'muse-project-card-header';
		const headerIcon = document.createElement('span');
		headerIcon.className = 'muse-project-card-header-icon';
		setIcon(headerIcon, 'folder');
		header.appendChild(headerIcon);
		header.appendChild(document.createTextNode(project.label));
		card.appendChild(header);

		// Tags on project nodes — gated on showTagsOnProjectNodes
		if (this.plugin.settings.showTagsOnProjectNodes && project.tags.length > 0) {
			const projectTagsEl = document.createElement('div');
			projectTagsEl.className = 'muse-project-card-tags';
			for (const tag of project.tags) {
				const chip = document.createElement('span');
				chip.className = 'muse-project-card-tag-chip';
				chip.textContent = tag;
				projectTagsEl.appendChild(chip);
			}
			card.appendChild(projectTagsEl);
		}

		const trackListEl = document.createElement('div');
		trackListEl.className = 'muse-project-card-tracks';
		card.appendChild(trackListEl);

		contentEl.appendChild(card);

		const renderTracks = () => {
			while (trackListEl.firstChild) trackListEl.removeChild(trackListEl.firstChild);

			const tracks = getProjectTracks(this.plugin, project);
			if (tracks.length === 0) {
				const empty = document.createElement('div');
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
		const wrapper = document.createElement('div');
		wrapper.className = 'muse-project-track-wrapper';

		const row = document.createElement('div');
		row.className = 'muse-project-track-row';
		row.dataset.musePlayPath = track.vaultPath; // read by the delegated click handler in onload()
		wrapper.appendChild(row);

		const icon = document.createElement('span');
		icon.className = 'muse-project-track-icon';
		setIcon(icon, 'play');
		row.appendChild(icon);

		const name = document.createElement('span');
		name.className = 'muse-project-track-name';
		name.textContent = track.name;
		row.appendChild(name);

		const progress = document.createElement('div');
		progress.className = 'muse-project-track-progress';
		const progressFill = document.createElement('div');
		progressFill.className = 'muse-project-track-progress-fill';
		progress.appendChild(progressFill);
		row.appendChild(progress);

		// Tags on project track rows — gated on showTagsInProjectAudioList
		if (this.plugin.settings.showTagsInProjectAudioList && track.tags.length > 0) {
			const tagRow = document.createElement('div');
			tagRow.className = 'muse-project-track-tags';
			for (const tag of track.tags) {
				const chip = document.createElement('span');
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
				progressFill.style.width = '0%';
				return;
			}
			const pct = progressState.duration > 0 ? (progressState.currentTime / progressState.duration) * 100 : 0;
			progressFill.style.width = `${pct}%`;
		});

		// Clean up when this specific row leaves the DOM (project card re-rendered, or node removed).
		const removalObserver = new MutationObserver(() => {
			if (!document.body.contains(wrapper)) {
				unsubscribePlayback();
				unsubscribeProgress();
				removalObserver.disconnect();
			}
		});
		removalObserver.observe(document.body, { childList: true, subtree: true });

		return wrapper;
	}

	/**
	 * Finds any visible canvas audio embed nodes whose src matches `deletedPath`
	 * and replaces their card with a "file missing" warning overlay.
	 */
	private showMissingFileWarning(deletedVaultPath: string): void {
		const embeds = Array.from(document.querySelectorAll('.canvas-node-content.audio-embed'));
		for (const embed of embeds) {
			const card = embed.querySelector('.muse-canvas-node-card');
			if (!card) continue;

			// Find which track this card is for
			const playBtn = card.querySelector('[data-muse-play-path]') as HTMLElement | null;
			if (!playBtn || playBtn.dataset.musePlayPath !== deletedVaultPath) continue;

			// Replace card contents with warning UI
			while (card.firstChild) card.removeChild(card.firstChild);
			card.classList.add('muse-canvas-node-card--missing');

			const warningRow = document.createElement('div');
			warningRow.className = 'muse-missing-warning-row';

			const warningIcon = document.createElement('span');
			warningIcon.className = 'muse-missing-icon';
			setIcon(warningIcon, 'alert-triangle');
			warningRow.appendChild(warningIcon);

			const warningMsg = document.createElement('span');
			warningMsg.className = 'muse-missing-msg';
			warningMsg.textContent = 'File not found';
			warningRow.appendChild(warningMsg);
			card.appendChild(warningRow);

			const btnRow = document.createElement('div');
			btnRow.className = 'muse-missing-btn-row';

			// "Relocate" — let user pick a replacement file from a dropdown
			const relocateBtn = document.createElement('button');
			relocateBtn.className = 'muse-missing-btn';
			relocateBtn.textContent = 'Relocate…';
			relocateBtn.addEventListener('click', () => {
				this.openRelocatePicker(embed as HTMLElement, deletedVaultPath);
			});
			btnRow.appendChild(relocateBtn);

			// "Remove node" — find parent .canvas-node and try to remove it
			const removeBtn = document.createElement('button');
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

	/**
	 * Opens a dropdown list of all audio files in the vault so the user can
	 * pick a replacement for a deleted file, then rebuilds the embed card.
	 */
	private openRelocatePicker(embed: HTMLElement, _oldPath: string): void {
		const audioExts = new Set(this.plugin.settings.audioExtensions.map((e) => e.toLowerCase()));
		const allAudioFiles = this.plugin.app.vault
			.getFiles()
			.filter((f) => audioExts.has(f.extension.toLowerCase()));

		if (allAudioFiles.length === 0) {
			return;
		}

		// Build a small popover list near the card
		const existing = embed.querySelector('.muse-relocate-picker');
		if (existing) { existing.remove(); return; } // toggle

		const picker = document.createElement('div');
		picker.className = 'muse-relocate-picker';

		for (const file of allAudioFiles.sort((a, b) => a.basename.localeCompare(b.basename))) {
			const item = document.createElement('div');
			item.className = 'muse-relocate-item';
			item.textContent = file.basename;
			item.addEventListener('click', () => {
				picker.remove();
				// Re-scan this embed with the new file as if it had always been there.
				// We do this by finding the audio element and faking its src update,
				// then triggering a re-upgrade.
				const audioEl = embed.querySelector('audio') as HTMLAudioElement | null;
				if (audioEl) {
					audioEl.src = this.plugin.app.vault.getResourcePath(file);
					audioEl.style.display = 'none';
				}
				this.upgradeEmbed(embed);
			});
			picker.appendChild(item);
		}

		embed.appendChild(picker);
		// Close on outside click
		setTimeout(() => {
			const close = (e: MouseEvent) => {
				if (!picker.contains(e.target as Node)) {
					picker.remove();
					document.removeEventListener('click', close);
				}
			};
			document.addEventListener('click', close);
		}, 0);
	}

	private cleanupWhenRemoved(el: Element, registry: WeakMap<Element, () => void>): void {
		const removalObserver = new MutationObserver(() => {
			if (!document.body.contains(el)) {
				registry.get(el)?.();
				registry.delete(el);
				removalObserver.disconnect();
			}
		});
		removalObserver.observe(document.body, { childList: true, subtree: true });
	}

	/** Match an <audio> element's resource URL back to a vault TFile. */
	private resolveFileFromSrc(src: string): TFile | null {
		const files = this.plugin.app.vault.getFiles();
		for (const file of files) {
			// getResourcePath returns an app:// URL; the src attribute may have
			// a trailing cache-busting query string Obsidian appends, so compare
			// only the part before "?".
			const resourcePath = this.plugin.app.vault.getResourcePath(file).split('?')[0];
			if (src.split('?')[0] === resourcePath) return file;
		}
		return null;
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

	private applyFilterForCanvas(canvas: any): void {
		if (!canvas) return;

		const activeTags = canvas.activeFilterTags as Set<string> | undefined;
		const filterActive = activeTags && activeTags.size > 0;

		if (!filterActive) {
			if (canvas.nodes) {
				for (const [id, node] of canvas.nodes) {
					if (node.nodeEl) {
						node.nodeEl.style.display = '';
						node.nodeEl.classList.remove('muse-filtered-out');
					}
				}
			}
			if (canvas.edges) {
				for (const [id, edge] of canvas.edges) {
					for (const key in edge) {
						if (key.endsWith('El') && edge[key] && typeof edge[key].style === 'object') {
							edge[key].style.display = '';
							if (typeof edge[key].classList?.remove === 'function') {
								edge[key].classList.remove('muse-filtered-out');
							}
						}
					}
					const domElements = document.querySelectorAll(`[data-id="${id}"]`);
					domElements.forEach((el: any) => {
						el.style.display = '';
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
					// 1. Audio node tags
					const audioTags = this.plugin.settings.tags[file.path]?.tags || [];
					if (audioTags.some((t: string) => activeTagsLower.has(t.toLowerCase().trim().replace(/^#/, '')))) {
						hasTag = true;
					}

					// 2. Project node tags and project track tags
					const project = this.plugin.settings.projects.find((p) => p.markerVaultPath === file.path);
					if (project) {
						if (project.tags && project.tags.some((t: string) => activeTagsLower.has(t.toLowerCase().trim().replace(/^#/, '')))) {
							hasTag = true;
						}
						// Scan folder tracks for active tags
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

					// 3. General file cache tags and frontmatter
					const cache = this.plugin.app.metadataCache.getFileCache(file);
					if (cache) {
						const fileTags = cache.tags || [];
						if (fileTags.some((t: any) => {
							const rawTag = typeof t === 'string' ? t : (t && t.tag) || '';
							return activeTagsLower.has(rawTag.toLowerCase().trim().replace(/^#/, ''));
						})) {
							hasTag = true;
						}
						const frontmatterTags = cache.frontmatter?.tags;
						if (frontmatterTags) {
							const arr = Array.isArray(frontmatterTags) ? frontmatterTags : [frontmatterTags];
							if (arr.some((t: any) => activeTagsLower.has(String(t).toLowerCase().trim().replace(/^#/, '')))) {
								hasTag = true;
							}
						}
					}
				}

				// 4. Text node content hashtags (exact hashtag matches only, no substrings)
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

				// 5. DOM text content hashtags
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

		// Perform Breadth-First Search (BFS) to find ALL nodes in the connected components containing tagged nodes
		const visibleNodeIds = new Set<string>(taggedNodeIds);
		const queue: string[] = Array.from(taggedNodeIds);

		// Build adjacency list for undirected graph traversal
		const adj = new Map<string, Set<string>>();
		if (canvas.edges) {
			for (const [id, edge] of canvas.edges) {
				const fromId = edge.from?.node?.id || edge.fromNode?.id || edge.from?.id;
				const toId = edge.to?.node?.id || edge.toNode?.id || edge.to?.id;
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
						node.nodeEl.style.display = '';
						node.nodeEl.classList.remove('muse-filtered-out');
					} else {
						node.nodeEl.style.display = 'none';
						node.nodeEl.classList.add('muse-filtered-out');
					}
				}
			}
		}

		if (canvas.edges) {
			for (const [id, edge] of canvas.edges) {
				const fromId = edge.from?.node?.id || edge.fromNode?.id || edge.from?.id;
				const toId = edge.to?.node?.id || edge.toNode?.id || edge.to?.id;
				const visible = !!(fromId && toId && visibleNodeIds.has(fromId) && visibleNodeIds.has(toId));
				const displayValue = visible ? '' : 'none';

				for (const key in edge) {
					if (key.endsWith('El') && edge[key] && typeof edge[key].style === 'object') {
						edge[key].style.display = displayValue;
						if (typeof edge[key].classList?.add === 'function') {
							if (visible) {
								edge[key].classList.remove('muse-filtered-out');
							} else {
								edge[key].classList.add('muse-filtered-out');
							}
						}
					}
				}

				const domElements = document.querySelectorAll(`[data-id="${id}"]`);
				domElements.forEach((el: any) => {
					el.style.display = displayValue;
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
