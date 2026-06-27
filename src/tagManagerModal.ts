import { App, Modal, TFile, setIcon } from 'obsidian';
import type MuseGardenPlugin from './main';
import { getAllKnownTags, addTag, removeTag } from './audioStore';
import { getAllKnownProjectTags, addProjectTag, removeProjectTag, getOrCreateProjectForFolder } from './projectStore';

type Mode =
	| { kind: 'track'; vaultPath: string }
	| { kind: 'project'; folderVaultPath: string }
	| { kind: 'global' };

/**
 * Tag Manager Modal — three sections:
 *  1. Existing tags — click to toggle-add/remove on the current track/project.
 *  2. Add new — type a new tag (with live similarity hints).
 *  3. Manage all — rename/delete tags globally across all tracks & projects.
 */
export class TagManagerModal extends Modal {
	private plugin: MuseGardenPlugin;
	private mode: Mode;
	/** Tags currently on this track/project (mutable copy). */
	private activeTags: string[];
	private onChanged: () => void;

	constructor(
		app: App,
		plugin: MuseGardenPlugin,
		mode: Mode,
		onChanged: () => void,
	) {
		super(app);
		this.plugin = plugin;
		this.mode = mode;
		this.onChanged = onChanged;

		// Snapshot the current tags for this entity
		if (mode.kind === 'track') {
			this.activeTags = [...(plugin.settings.tags[mode.vaultPath]?.tags ?? [])];
		} else if (mode.kind === 'project') {
			const proj = plugin.settings.projects.find((p) => p.folderVaultPath === mode.folderVaultPath);
			this.activeTags = proj ? [...proj.tags] : [];
		} else {
			this.activeTags = [];
		}
	}

	onOpen(): void {
		this.modalEl.addClass('muse-tag-manager-modal');
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h3', { text: 'Tag manager', cls: 'muse-tm-heading' });

		const allTrackTags = getAllKnownTags(this.plugin);
		const allProjectTags = getAllKnownProjectTags(this.plugin);
		const allKnown = Array.from(new Set([...allTrackTags, ...allProjectTags])).sort();

		// ── Section 1: Existing known tags (click to toggle) ───────────────
		if (this.mode.kind !== 'global') {
			const existingSec = contentEl.createDiv({ cls: 'muse-tm-section' });
			existingSec.createEl('p', { text: 'Known tags — click to add or remove:', cls: 'muse-tm-label' });
			const chipWrap = existingSec.createDiv({ cls: 'muse-tm-chips' });

			if (allKnown.length === 0) {
				chipWrap.createSpan({ text: 'No tags yet.', cls: 'muse-tm-empty' });
			} else {
				for (const tag of allKnown) {
					const isActive = this.activeTags.includes(tag);
					const chip = chipWrap.createSpan({
						cls: `muse-tm-chip ${isActive ? 'is-active' : ''}`,
						text: tag,
					});
					chip.addEventListener('click', () => {
						void this.toggleTag(tag, isActive);
					});
				}
			}

			// ── Section 2: Add new tag ──────────────────────────────────────
			const addSec = contentEl.createDiv({ cls: 'muse-tm-section' });
			addSec.createEl('p', { text: 'Add a new tag:', cls: 'muse-tm-label' });
			const addRow = addSec.createDiv({ cls: 'muse-tm-add-row' });
			const addInput = addRow.createEl('input', {
				type: 'text',
				placeholder: 'e.g. lofi, drill, wip…',
				cls: 'muse-tm-input',
			});
			const addBtn = addRow.createEl('button', { text: 'Add', cls: 'muse-tm-btn mod-cta' });

			const doAdd = () => {
				const val = addInput.value.trim();
				if (!val) return;
				void this.addNewTag(val).then(() => {
					addInput.value = '';
				});
			};
			addBtn.addEventListener('click', doAdd);
			addInput.addEventListener('keydown', (evt) => {
				if (evt.key === 'Enter') { evt.preventDefault(); doAdd(); }
			});
		}

		// ── Section 3: Manage all tags (rename / delete) ───────────────────
		const mgmtSec = contentEl.createDiv({ cls: 'muse-tm-section' });
		mgmtSec.createEl('p', {
			text: allKnown.length === 0 ? 'No tags to manage yet.' : 'Manage all tags:',
			cls: 'muse-tm-label',
		});

		if (allKnown.length > 0) {
			const list = mgmtSec.createDiv({ cls: 'muse-tm-manage-list' });
			for (const tag of allKnown) {
				const row = list.createDiv({ cls: 'muse-tm-manage-row' });
				const nameEl = row.createSpan({ cls: 'muse-tm-manage-name', text: tag });

				const renameBtn = row.createDiv({ cls: 'clickable-icon muse-tm-icon-btn', attr: { 'aria-label': 'Rename' } });
				setIcon(renameBtn, 'pencil');
				renameBtn.addEventListener('click', () => {
					// Inline rename: replace nameEl with an input
					const input = activeDocument.createElement('input');
					input.className = 'muse-tm-inline-input';
					input.value = tag;
					nameEl.replaceWith(input);
					input.focus();
					input.select();

					const commit = () => {
						const newName = input.value.trim();
						if (newName && newName !== tag) {
							void this.renameTagGlobally(tag, newName);
						} else {
							this.render();
						}
					};
					input.addEventListener('blur', commit);
					input.addEventListener('keydown', (e: KeyboardEvent) => {
						if (e.key === 'Enter') { e.preventDefault(); commit(); }
						if (e.key === 'Escape') { this.render(); }
					});
				});

				const deleteBtn = row.createDiv({ cls: 'clickable-icon muse-tm-icon-btn mod-warning', attr: { 'aria-label': 'Delete' } });
				setIcon(deleteBtn, 'trash');
				deleteBtn.addEventListener('click', () => {
					void this.deleteTagGlobally(tag);
				});
			}
		}
	}

	/** Toggle a known tag on/off for the current entity. */
	private async toggleTag(tag: string, wasActive: boolean): Promise<void> {
		if (this.mode.kind === 'track') {
			if (wasActive) {
				await removeTag(this.plugin, this.mode.vaultPath, tag);
				this.activeTags = this.activeTags.filter((t) => t !== tag);
			} else {
				await addTag(this.plugin, this.mode.vaultPath, tag);
				this.activeTags.push(tag);
			}
		} else if (this.mode.kind === 'project') {
			const { project: proj } = await getOrCreateProjectForFolder(this.plugin, this.mode.folderVaultPath);
			if (wasActive) {
				await removeProjectTag(this.plugin, proj, tag);
				this.activeTags = this.activeTags.filter((t) => t !== tag);
			} else {
				await addProjectTag(this.plugin, proj, tag);
				this.activeTags.push(tag);
			}
		}
		this.onChanged();
		this.render();
	}

	/** Add a brand-new tag to the current entity. */
	private async addNewTag(tag: string): Promise<void> {
		if (this.mode.kind === 'track') {
			await addTag(this.plugin, this.mode.vaultPath, tag);
			if (!this.activeTags.includes(tag)) this.activeTags.push(tag);
		} else if (this.mode.kind === 'project') {
			const { project: proj } = await getOrCreateProjectForFolder(this.plugin, this.mode.folderVaultPath);
			await addProjectTag(this.plugin, proj, tag);
			if (!this.activeTags.includes(tag)) this.activeTags.push(tag);
		}
		this.onChanged();
		this.render();
	}

	/** Rename a tag across ALL tracks and projects. */
	private async renameTagGlobally(oldTag: string, newTag: string): Promise<void> {
		const clean = newTag.trim();
		if (!clean || clean === oldTag) { this.render(); return; }

		// Track tags
		for (const [path, entry] of Object.entries(this.plugin.settings.tags)) {
			const idx = entry.tags.indexOf(oldTag);
			if (idx !== -1 && !entry.tags.includes(clean)) {
				entry.tags[idx] = clean;
				this.plugin.settings.tags[path] = entry;
			} else if (idx !== -1) {
				entry.tags.splice(idx, 1);
				this.plugin.settings.tags[path] = entry;
			}
		}

		// Project tags
		for (const proj of this.plugin.settings.projects) {
			const idx = proj.tags.indexOf(oldTag);
			if (idx !== -1) {
				if (!proj.tags.includes(clean)) {
					proj.tags[idx] = clean;
				} else {
					proj.tags.splice(idx, 1);
				}

				const markerFile = this.plugin.app.vault.getAbstractFileByPath(proj.markerVaultPath);
				if (markerFile instanceof TFile) {
				await this.plugin.app.fileManager.processFrontMatter(markerFile, (frontmatter: Record<string, unknown>) => {
					const existingTags = frontmatter['tags'];
					if (Array.isArray(existingTags)) {
						const i = existingTags.indexOf(oldTag);
						if (i !== -1) {
							if (!existingTags.includes(clean)) {
								existingTags[i] = clean;
							} else {
								existingTags.splice(i, 1);
							}
						}
					} else if (typeof existingTags === 'string' && existingTags === oldTag) {
						frontmatter['tags'] = clean;
					}
					});
				}
			}
		}

		// Update activeTags snapshot
		const ai = this.activeTags.indexOf(oldTag);
		if (ai !== -1) this.activeTags[ai] = clean;

		await this.plugin.saveSettings();
		this.plugin.app.workspace.trigger('muse-garden:settings-changed');
		this.onChanged();
		this.render();
	}

	/** Delete a tag from ALL tracks and projects. */
	private async deleteTagGlobally(tag: string): Promise<void> {
		for (const [path, entry] of Object.entries(this.plugin.settings.tags)) {
			entry.tags = entry.tags.filter((t) => t !== tag);
			this.plugin.settings.tags[path] = entry;
		}
		for (const proj of this.plugin.settings.projects) {
			if (proj.tags.includes(tag)) {
				proj.tags = proj.tags.filter((t) => t !== tag);
				const markerFile = this.plugin.app.vault.getAbstractFileByPath(proj.markerVaultPath);
				if (markerFile instanceof TFile) {
				await this.plugin.app.fileManager.processFrontMatter(markerFile, (frontmatter: Record<string, unknown>) => {
					const existingTags = frontmatter['tags'];
					if (Array.isArray(existingTags)) {
							frontmatter['tags'] = existingTags.filter((t) => t !== tag);
						} else if (typeof existingTags === 'string' && existingTags === tag) {
							frontmatter['tags'] = [];
						}
					});
				}
			}
		}
		this.activeTags = this.activeTags.filter((t) => t !== tag);

		await this.plugin.saveSettings();
		this.plugin.app.workspace.trigger('muse-garden:settings-changed');
		this.onChanged();
		this.render();
	}
}
