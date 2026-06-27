import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import * as path from 'path';
import type MuseGardenPlugin from './main';
import { TextInputModal } from './textInputModal';

/** A single external folder the user has linked into the vault. */
export interface WatchedDirectory {
	/** Stable unique id, independent of renames. */
	id: string;
	/** Friendly name shown in the Explorer (defaults to folder name). */
	label: string;
	/** Absolute filesystem path to the real external folder (e.g. D:\\FL Studio Projects). */
	externalPath: string;
	/** Vault-relative path to the symlink that points at externalPath. */
	vaultLinkPath: string;
}

/**
 * A "Project" the user has dragged onto canvas: a real folder (somewhere
 * under a watched directory) represented by a small marker .md file that
 * lives in our own plugin-managed space, never inside the user's actual
 * FL Studio / audio folders. Canvas needs a real vault file to point a
 * `file` node at; the marker IS that file. CanvasAudioSync-style code
 * detects nodes embedding a marker and renders a custom Project card
 * instead of Obsidian's default note preview.
 */
export interface ProjectMarker {
	id: string;
	/** The real folder this project represents (vault-relative, e.g. a path under a symlinked directory). */
	folderVaultPath: string;
	/** Vault-relative path to the marker .md file itself. */
	markerVaultPath: string;
	/** Display name (defaults to the folder's basename). */
	label: string;
	/** Tags on the Project/folder itself — distinct from any individual track's tags. */
	tags: string[];
}

export interface MuseGardenSettings {
	directories: WatchedDirectory[];
	/** Folder (vault-relative) where Muse Garden creates its symlinks. */
	linkFolder: string;
	/** Folder (vault-relative) where Muse Garden creates Project marker files. */
	markerFolder: string;
	/** Audio file extensions to treat as tracks. */
	audioExtensions: string[];
	/** path -> { tags, genre } sidecar, keyed by vault-relative file path. */
	tags: Record<string, { tags: string[] }>;
	projects: ProjectMarker[];

	// ── Tag Visibility (6 independent toggles) ─────────────────────────────
	/** Show tag chips on Audio (file) nodes on canvas. */
	showTagsOnAudioNodes: boolean;
	/** Show tag chips on the Project card header on canvas (project-level tags). */
	showTagsOnProjectNodes: boolean;
	/** Show tag chips in the audio track list inside a Project canvas node. */
	showTagsInProjectAudioList: boolean;
	/** Show tag chips on track/folder rows in the Explorer sidebar. */
	showTagsInExplorer: boolean;
	/** Show tag chips when a search query is active in the Explorer. */
	showTagsInSearchResults: boolean;
	/** Show tag chips for the currently playing track in the bottom player bar. */
	showTagsInPlayer: boolean;

	/** Persisted player volume, 0-1. */
	volume: number;
}

export const DEFAULT_SETTINGS: MuseGardenSettings = {
	directories: [],
	linkFolder: 'MuseGardenConfig/Links',
	markerFolder: 'MuseGardenConfig/ProjectMarkers',
	audioExtensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aiff', 'aif'],
	tags: {},
	projects: [],
	showTagsOnAudioNodes: false,
	showTagsOnProjectNodes: false,
	showTagsInProjectAudioList: false,
	showTagsInExplorer: true,
	showTagsInSearchResults: true,
	showTagsInPlayer: true,
	volume: 1,
};

function makeId(): string {
	return `dir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeProjectId(): string {
	return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Turn an absolute external path into a safe, unique vault folder name. */
function safeLinkName(existing: Set<string>, externalPath: string): string {
	const base = path.basename(externalPath).replace(/[\\/:*?"<>|]/g, '_') || 'folder';
	let candidate = base;
	let i = 2;
	while (existing.has(candidate)) {
		candidate = `${base}-${i}`;
		i++;
	}
	return candidate;
}

/**
 * Minimal shape of the Electron `dialog` module surface we rely on.
 * Electron's renderer-process `require` isn't part of Obsidian's public
 * API/types, so we declare just the slice we use rather than pulling in
 * full Electron typings.
 */
interface ElectronOpenDialogResult {
	canceled: boolean;
	filePaths: string[];
}
interface ElectronDialog {
	showOpenDialog(options: { properties: string[] }): Promise<ElectronOpenDialogResult>;
}
interface ElectronRendererModule {
	remote?: { dialog: ElectronDialog };
	dialog?: ElectronDialog;
}

export class MuseGardenSettingTab extends PluginSettingTab {
	plugin: MuseGardenPlugin;

	constructor(app: App, plugin: MuseGardenPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Tag visibility').setHeading();

		new Setting(containerEl)
			.setName('Show tags on audio nodes (canvas)')
			.setDesc('Display tag chips directly on audio file nodes on the canvas.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showTagsOnAudioNodes).onChange(async (value) => {
					this.plugin.settings.showTagsOnAudioNodes = value;
					await this.plugin.saveSettings();
					this.plugin.app.workspace.trigger('muse-garden:settings-changed');
				}),
			);

		new Setting(containerEl)
			.setName('Show tags on project nodes (canvas)')
			.setDesc('Show the project folder\'s own tags on its canvas card header.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showTagsOnProjectNodes).onChange(async (value) => {
					this.plugin.settings.showTagsOnProjectNodes = value;
					await this.plugin.saveSettings();
					this.plugin.app.workspace.trigger('muse-garden:settings-changed');
				}),
			);

		new Setting(containerEl)
			.setName('Show tags in audio list of a project (canvas)')
			.setDesc('Show each track\'s tags inside the audio list of a project canvas node.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showTagsInProjectAudioList).onChange(async (value) => {
					this.plugin.settings.showTagsInProjectAudioList = value;
					await this.plugin.saveSettings();
					this.plugin.app.workspace.trigger('muse-garden:settings-changed');
				}),
			);

		new Setting(containerEl)
			.setName('Show tags in explorer')
			.setDesc('Display tag chips on track and folder rows in the explorer sidebar.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showTagsInExplorer).onChange(async (value) => {
					this.plugin.settings.showTagsInExplorer = value;
					await this.plugin.saveSettings();
					this.plugin.app.workspace.trigger('muse-garden:settings-changed');
				}),
			);

		new Setting(containerEl)
			.setName('Show tags in search results')
			.setDesc('Display tag chips on tracks when a search is active in the explorer.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showTagsInSearchResults).onChange(async (value) => {
					this.plugin.settings.showTagsInSearchResults = value;
					await this.plugin.saveSettings();
					this.plugin.app.workspace.trigger('muse-garden:settings-changed');
				}),
			);

		new Setting(containerEl)
			.setName('Show tags in music player')
			.setDesc('Display the current track\'s tags in the bottom player bar.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showTagsInPlayer).onChange(async (value) => {
					this.plugin.settings.showTagsInPlayer = value;
					await this.plugin.saveSettings();
					this.plugin.app.workspace.trigger('muse-garden:settings-changed');
				}),
			);

		// ── Watched folders ──────────────────────────────────────────────────
		new Setting(containerEl).setName('Watched folders').setHeading();

		containerEl.createEl('p', {
			text:
				'Add the folders where your FL Studio projects or audio exports live. ' +
				'Muse Garden links each one into your vault (via a symlink) so Obsidian ' +
				'and Canvas can browse and play the files natively.',
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('Add a folder')
			.setDesc('Pick an external folder to watch.')
			.addButton((btn) =>
				btn
					.setButtonText('Choose folder…')
					.setCta()
					.onClick(() => {
						void this.pickAndAddDirectory();
					}),
			);

		if (this.plugin.settings.directories.length === 0) {
			containerEl.createEl('p', {
				text: 'No folders added yet.',
				cls: 'setting-item-description',
			});
		}

		for (const dir of this.plugin.settings.directories) {
			new Setting(containerEl)
				.setName(dir.label)
				.setDesc(dir.externalPath)
				.addExtraButton((btn) =>
					btn
						.setIcon('pencil')
						.setTooltip('Rename')
						.onClick(() => {
							new TextInputModal(
								this.app,
								{ title: 'Rename folder', initialValue: dir.label },
								(next) => {
									dir.label = next;
									void this.plugin.saveSettings().then(() => this.display());
								},
							).open();
						}),
				)
				.addExtraButton((btn) =>
					btn
						.setIcon('trash')
						.setTooltip('Remove')
						.onClick(() => {
							void this.plugin.removeDirectory(dir.id).then(() => this.display());
						}),
				);
		}
	}

	private async pickAndAddDirectory(): Promise<void> {
		// Electron's dialog is reachable from the renderer via window.require in
		// Obsidian desktop. This is a deliberate, narrow use of an Electron API
		// that isn't part of Obsidian's public typings (see ElectronDialog above).
		const electronRequire = (window as unknown as { require?: (id: string) => unknown }).require;
		const electron = electronRequire?.('electron') as ElectronRendererModule | undefined;
		if (!electron) {
			new Notice('Folder picker is only available on desktop.');
			return;
		}
		const dialogApi = electron.remote ? electron.remote.dialog : electron.dialog;
		if (!dialogApi) {
			new Notice('Folder picker is only available on desktop.');
			return;
		}
		const result = await dialogApi.showOpenDialog({ properties: ['openDirectory'] });
		if (result.canceled || result.filePaths.length === 0) return;

		const externalPath = result.filePaths[0];
		if (!externalPath) return;
		await this.plugin.addDirectory(externalPath);
		this.display();
	}
}

/** Pure helper used by main.ts to compute a non-colliding link name. */
export function pickLinkName(existing: WatchedDirectory[], externalPath: string): string {
	const used = new Set(existing.map((d) => path.basename(d.vaultLinkPath)));
	return safeLinkName(used, externalPath);
}

export { makeId, makeProjectId };
