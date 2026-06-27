import { FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath, addIcon } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import {
	DEFAULT_SETTINGS,
	MuseGardenSettings,
	MuseGardenSettingTab,
	WatchedDirectory,
	makeId,
	pickLinkName,
} from './settings';
import { MuseExplorerView, VIEW_TYPE_MUSE_EXPLORER } from './explorerView';
import { MuseGardenPlayer } from './player';
import { CanvasAudioSync } from './canvasSync';
import { CanvasDropZone } from './canvasDropZone';
import { syncProjectTagsFromCache } from './projectStore';
import { WebEmbedModal } from './webEmbedModal';

export default class MuseGardenPlugin extends Plugin {
	settings!: MuseGardenSettings;
	player!: MuseGardenPlayer;

	async onload() {
		addIcon('muse-garden-logo', MUSE_GARDEN_LOGO_SVG);

		await this.loadSettings();
		await this.migrateHiddenLinkFolder();
		await this.migrateToConfigFolder();
		this.addSettingTab(new MuseGardenSettingTab(this.app, this));

		// Re-create any symlinks that might be missing (e.g. vault moved, or
		// the user manually deleted the link folder). Runs once at startup.
		await this.ensureAllSymlinks();

		// Persistent bottom player bar; lives for the whole plugin lifetime.
		this.player = new MuseGardenPlayer(this);
		this.addChild(this.player); // Obsidian calls player.onload()/onunload() for us.

		// Keeps canvas audio-node embeds synced to the same shared player
		// instead of having their own independent playback.
		this.addChild(new CanvasAudioSync(this));

		// Lets Explorer tracks be dragged directly onto an open canvas.
		this.addChild(new CanvasDropZone(this));


		// MuseGarden Explorer sidebar view.
		this.registerView(VIEW_TYPE_MUSE_EXPLORER, (leaf) => new MuseExplorerView(leaf, this));
		this.addRibbonIcon('muse-garden-logo', 'Open musegarden explorer', () => {
			void this.activateExplorerView();
		});
		this.addCommand({
			id: 'open-muse-explorer',
			name: 'Open musegarden explorer',
			callback: () => {
				void this.activateExplorerView();
			},
		});

		this.addCommand({
			id: 'add-web-embed-to-canvas',
			name: 'Add web audio/video embed to canvas',
			callback: () => {
				new WebEmbedModal(this.app).open();
			},
		});

		// Sync project tags from marker file properties on layout ready and metadata cache changes
		this.app.workspace.onLayoutReady(() => {
			let anyChanged = false;
			for (const proj of this.settings.projects) {
				if (syncProjectTagsFromCache(this, proj)) {
					anyChanged = true;
				}
			}
			if (anyChanged) {
				void this.saveSettings();
			}
			this.app.workspace.trigger('muse-garden:settings-changed');
		});

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				const proj = this.settings.projects.find((p) => p.markerVaultPath === file.path);
				if (proj) {
					const changed = syncProjectTagsFromCache(this, proj);
					if (changed) {
						void this.saveSettings();
						this.app.workspace.trigger('muse-garden:settings-changed');
					}
				}
			}),
		);
	}

	onunload() {
		// Intentionally do NOT remove the symlinks on unload/disable.
		// Disabling the plugin shouldn't delete the user's links; only an
		// explicit "remove folder" action in settings should do that.
		// (player cleanup is handled automatically via addChild().)
	}

	/**
	 * One-time fix-up for anyone who installed an earlier build that used a
	 * dot-prefixed link folder (e.g. ".muse-garden-links"). Obsidian excludes
	 * dot-folders from its vault index entirely, so tracks under the old
	 * folder were invisible to the plugin even though they existed on disk.
	 * This recreates each symlink under the new, non-dotted folder name and
	 * removes the old dotted one.
	 */
	private async migrateHiddenLinkFolder(): Promise<void> {
		if (!this.settings.linkFolder.startsWith('.')) return; // already migrated/fresh install

		const oldFolder = this.settings.linkFolder;
		const base = this.getVaultBasePath();
		this.settings.linkFolder = 'MuseGardenLinks';
		if (!base) {
			await this.saveSettings();
			return;
		}

		const newFolderAbs = path.join(base, this.settings.linkFolder);
		await fs.promises.mkdir(newFolderAbs, { recursive: true });

		for (const dir of this.settings.directories) {
			const linkName = path.basename(dir.vaultLinkPath);
			const newVaultLinkPath = normalizePath(`${this.settings.linkFolder}/${linkName}`);
			const newAbsPath = path.join(newFolderAbs, linkName);

			try {
				await fs.promises.symlink(dir.externalPath, newAbsPath, 'dir');
				dir.vaultLinkPath = newVaultLinkPath;
			} catch (err) {
				console.error(`Muse Garden: migration failed for "${dir.label}"`, err);
			}
		}

		// Best-effort cleanup of the old dotted folder.
		const oldFolderAbs = path.join(base, oldFolder);
		await fs.promises.rm(oldFolderAbs, { recursive: true, force: true }).catch(() => {});

		await this.saveSettings();
		new Notice('Muse garden: updated link folder so tracks show up correctly. Reopen the explorer.');
	}

	/**
	 * One-time fix-up that consolidates the separate top-level
	 * "MuseGardenLinks" / "MuseGardenProjectMarkers" folders (from earlier
	 * builds) into a single "MuseGardenConfig" parent folder, so the vault
	 * root stays tidy. Moves real symlinks (via fs, same as the dot-folder
	 * migration) and re-points marker files (via the vault API, since those
	 * are plain vault-managed .md files, not symlinks).
	 */
	private async migrateToConfigFolder(): Promise<void> {
		const alreadyMigrated =
			this.settings.linkFolder.startsWith('MuseGardenConfig/') &&
			this.settings.markerFolder.startsWith('MuseGardenConfig/');
		if (alreadyMigrated) return;

		const oldLinkFolder = this.settings.linkFolder;
		const oldMarkerFolder = this.settings.markerFolder;
		const newLinkFolder = 'MuseGardenConfig/Links';
		const newMarkerFolder = 'MuseGardenConfig/ProjectMarkers';

		const base = this.getVaultBasePath();
		if (!base) {
			// No filesystem access (shouldn't happen on desktop, but be safe):
			// still update settings so future symlink creation uses the new
			// path, even though we can't move anything that already exists.
			this.settings.linkFolder = newLinkFolder;
			this.settings.markerFolder = newMarkerFolder;
			await this.saveSettings();
			return;
		}

		// --- Move symlinked directories ---
		const newLinkFolderAbs = path.join(base, newLinkFolder);
		await fs.promises.mkdir(newLinkFolderAbs, { recursive: true });

		// Track old->new vaultLinkPath per directory so we can rewrite any
		// project's folderVaultPath that lived under one of these links —
		// otherwise a project's marker would keep pointing at a path that no
		// longer exists once the directory's own link path changes here too.
		const linkPathRewrites: Array<{ oldPrefix: string; newPrefix: string }> = [];

		for (const dir of this.settings.directories) {
			const linkName = path.basename(dir.vaultLinkPath);
			const oldVaultLinkPath = dir.vaultLinkPath;
			const newVaultLinkPath = normalizePath(`${newLinkFolder}/${linkName}`);
			const newAbsPath = path.join(newLinkFolderAbs, linkName);

			try {
				await fs.promises.symlink(dir.externalPath, newAbsPath, 'dir');
				dir.vaultLinkPath = newVaultLinkPath;
				linkPathRewrites.push({ oldPrefix: oldVaultLinkPath, newPrefix: newVaultLinkPath });
			} catch (err) {
				console.error(`Muse Garden: config-folder migration failed for link "${dir.label}"`, err);
			}
		}
		const oldLinkFolderAbs = path.join(base, oldLinkFolder);
		await fs.promises.rm(oldLinkFolderAbs, { recursive: true, force: true }).catch(() => {});

		// Rewrite project.folderVaultPath for any project whose real folder
		// lived under a directory link that just moved above.
		for (const project of this.settings.projects) {
			for (const { oldPrefix, newPrefix } of linkPathRewrites) {
				if (project.folderVaultPath === oldPrefix || project.folderVaultPath.startsWith(`${oldPrefix}/`)) {
					project.folderVaultPath = newPrefix + project.folderVaultPath.slice(oldPrefix.length);
					break;
				}
			}
		}

		// --- Move project marker files (plain vault files, use vault API not fs) ---
		const newMarkerFolderVaultPath = normalizePath(newMarkerFolder);
		if (!this.app.vault.getAbstractFileByPath(newMarkerFolderVaultPath)) {
			await this.app.vault.createFolder(newMarkerFolderVaultPath).catch(() => {});
		}
		for (const project of this.settings.projects) {
			const oldFile = this.app.vault.getAbstractFileByPath(project.markerVaultPath);
			if (oldFile instanceof TFile) {
				const newPath = normalizePath(`${newMarkerFolder}/${path.basename(project.markerVaultPath)}`);
				try {
					await this.app.fileManager.renameFile(oldFile, newPath);
					project.markerVaultPath = newPath;
				} catch (err) {
					console.error(`Muse Garden: config-folder migration failed for marker "${project.label}"`, err);
				}
			}
		}
		const oldMarkerFolderVaultPath = this.app.vault.getAbstractFileByPath(normalizePath(oldMarkerFolder));
		if (oldMarkerFolderVaultPath) {
			await this.app.fileManager.trashFile(oldMarkerFolderVaultPath).catch(() => {});
		}

		this.settings.linkFolder = newLinkFolder;
		this.settings.markerFolder = newMarkerFolder;
		await this.saveSettings();
		new Notice('Muse garden: reorganized config into musegardenconfig/. Reopen any open canvases.');
	}



	async activateExplorerView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_MUSE_EXPLORER)[0];
		if (existing) {
			await workspace.revealLeaf(existing);
			return;
		}

		const leaf: WorkspaceLeaf | null = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_MUSE_EXPLORER, active: true });
		await workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		const raw = (await this.loadData()) as Record<string, unknown> | null | undefined;

		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			raw as Partial<MuseGardenSettings>,
		);

		// Backfill: ProjectMarker.tags didn't exist in earlier versions, so
		// projects saved before this field was added won't have it even
		// after the Object.assign above (that only fills in missing
		// top-level settings keys, not missing properties on array items).
		for (const project of this.settings.projects) {
			if (!Array.isArray(project.tags)) project.tags = [];
		}

		// Migration: earlier builds had a single `showTagsOnCanvas` boolean.
		// Carry its value forward into the two canvas-specific toggles so
		// behaviour doesn't silently change on first upgrade.
		const legacyShowTags = raw?.['showTagsOnCanvas'];
		if (typeof legacyShowTags === 'boolean') {
			// Only override if the new fields weren't already explicitly set in data.json
			if (!('showTagsOnAudioNodes' in (raw ?? {}))) {
				this.settings.showTagsOnAudioNodes = legacyShowTags;
			}
			if (!('showTagsOnProjectNodes' in (raw ?? {}))) {
				this.settings.showTagsOnProjectNodes = legacyShowTags;
			}
		}
	}


	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Returns the real, absolute path to the vault root on disk, or null on mobile / unsupported adapters. */
	getVaultBasePath(): string | null {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		// Defensive fallback: some plugins (e.g. obsidian-git) wrap the adapter
		// in a way that breaks `instanceof` checks but still exposes basePath
		// as a direct property.
		const maybeBasePath = (adapter as unknown as { basePath?: string }).basePath;
		return typeof maybeBasePath === 'string' ? maybeBasePath : null;
	}

	/** Absolute path to the vault folder where Muse Garden keeps its symlinks. */
	private getLinkFolderAbsolute(): string | null {
		const base = this.getVaultBasePath();
		if (!base) return null;
		return path.join(base, this.settings.linkFolder);
	}

	/** Create the link folder on disk if it doesn't exist yet. */
	private async ensureLinkFolderExists(): Promise<string | null> {
		const abs = this.getLinkFolderAbsolute();
		if (!abs) return null;
		await fs.promises.mkdir(abs, { recursive: true });
		return abs;
	}

	/**
	 * Add a new watched directory: creates a symlink inside the vault that
	 * points at `externalPath`, and records it in settings.
	 */
	async addDirectory(externalPath: string): Promise<void> {
		const linkFolderAbs = await this.ensureLinkFolderExists();
		if (!linkFolderAbs) {
			new Notice('Could not resolve vault path (mobile or unsupported adapter).');
			return;
		}

		const linkName = pickLinkName(this.settings.directories, externalPath);
		const linkAbsPath = path.join(linkFolderAbs, linkName);
		const vaultLinkPath = normalizePath(`${this.settings.linkFolder}/${linkName}`);

		try {
			await this.createSymlink(externalPath, linkAbsPath);
		} catch (err) {
			this.reportSymlinkError(err);
			return;
		}

		const dir: WatchedDirectory = {
			id: makeId(),
			label: path.basename(externalPath) || externalPath,
			externalPath,
			vaultLinkPath,
		};
		this.settings.directories.push(dir);
		await this.saveSettings();
		new Notice(`Linked "${dir.label}"`);
	}

	/** Remove a watched directory: deletes the symlink and forgets it in settings. */
	async removeDirectory(id: string): Promise<void> {
		const dir = this.settings.directories.find((d) => d.id === id);
		if (!dir) return;

		const base = this.getVaultBasePath();
		if (base) {
			const linkAbsPath = path.join(base, dir.vaultLinkPath);
			try {
				// lstat (not stat) so we detect the symlink itself, not its target.
				const stat = await fs.promises.lstat(linkAbsPath);
				if (stat.isSymbolicLink()) {
					await fs.promises.unlink(linkAbsPath);
				}
			} catch {
				// Link was already missing; nothing to clean up on disk.
			}
		}

		this.settings.directories = this.settings.directories.filter((d) => d.id !== id);
		await this.saveSettings();
	}

	/** Re-create any symlinks that are missing on disk (doesn't touch existing ones). */
	private async ensureAllSymlinks(): Promise<void> {
		const base = this.getVaultBasePath();
		if (!base) return;
		await this.ensureLinkFolderExists();

		for (const dir of this.settings.directories) {
			const linkAbsPath = path.join(base, dir.vaultLinkPath);
			const exists = await fs.promises
				.lstat(linkAbsPath)
				.then(() => true)
				.catch(() => false);
			if (!exists) {
				try {
					await this.createSymlink(dir.externalPath, linkAbsPath);
				} catch (err) {
					console.error(`Muse Garden: failed to restore link for "${dir.label}"`, err);
				}
			}
		}
	}

	/**
	 * Create a directory symlink, picking the right `type` per platform.
	 *
	 * Windows: prefer 'junction'. Unlike 'dir'-type symlinks, junctions do
	 * NOT require Developer Mode or running-as-administrator — confirmed
	 * Windows-specific behavior, not a Node quirk (see e.g. nodejs/node#18518
	 * and nodejs/node#47783). If junction creation fails for any reason
	 * (rare; can happen on some non-NTFS or network-mounted paths), we fall
	 * back to 'dir', which DOES need elevated permissions — reportSymlinkError
	 * already gives the user clear instructions for that case.
	 *
	 * macOS/Linux: the `type` argument is ignored by the OS entirely, so
	 * 'dir' is simply the conventional value to pass.
	 */
	private async createSymlink(target: string, linkPath: string): Promise<void> {
		if (process.platform === 'win32') {
			try {
				await fs.promises.symlink(target, linkPath, 'junction');
				return;
			} catch (err) {
				console.warn('Muse Garden: junction creation failed, falling back to dir symlink', err);
			}
		}
		await fs.promises.symlink(target, linkPath, 'dir');
	}

	private reportSymlinkError(err: unknown): void {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === 'EPERM' || code === 'EACCES') {
			new Notice(
				'Permission denied creating the link.\n' +
					'On Windows, enable Developer Mode (Settings → For developers) ' +
					'or run Obsidian as administrator once, then try again.',
				10000,
			);
		} else if (code === 'EEXIST') {
			new Notice('A link with that name already exists.');
		} else {
			new Notice(`Could not create link (${String(err)}).`, 8000);
			console.error('Muse Garden symlink error:', err);
		}
	}
}

const MUSE_GARDEN_LOGO_SVG = `<svg viewBox="0 0 830 781">
<path d="M0 0 C4.69049218 4.2017206 7.64889509 8.9628319 10.8125 14.375 C11.34093506 15.27130127 11.86937012 16.16760254 12.41381836 17.09106445 C13.95482835 19.72048175 15.48075986 22.35795619 17 25 C17.38091797 25.65822754 17.76183594 26.31645508 18.15429688 26.99462891 C47.79674621 78.69822935 62.20567878 140.58597284 62.25 199.875 C62.25101212 201.10822495 62.25101212 201.10822495 62.25204468 202.36636353 C62.14492413 285.53495965 32.86809494 367.05591474 -19 432 C-20.10408203 433.39412109 -20.10408203 433.39412109 -21.23046875 434.81640625 C-26.07849871 440.84855681 -31.19455307 446.57450327 -36.4609375 452.23828125 C-38.45728452 454.40969255 -40.36541029 456.60866006 -42.25 458.875 C-47.39299258 464.80732477 -53.3545982 469.98439616 -59.13378906 475.28222656 C-60.81616285 476.83078516 -62.48517067 478.39191889 -64.1484375 479.9609375 C-70.89732928 486.27558423 -77.9334548 492.01650573 -85.25732422 497.64257812 C-86.92365262 498.94053076 -88.56080336 500.26694117 -90.19140625 501.609375 C-100.84240947 510.31970873 -112.36141582 517.68629608 -124 525 C-124.73557129 525.4626123 -125.47114258 525.92522461 -126.22900391 526.40185547 C-176.4303839 557.64504725 -232.80813743 576.04364922 -291 585 C-292.36214907 585.22423069 -293.72416178 585.44929419 -295.0859375 585.67578125 C-357.42164179 595.19323727 -426.13503942 589.07976311 -485.73828125 568.75927734 C-488.11846023 567.96023194 -490.50977324 567.20569584 -492.90625 566.45703125 C-507.33246149 561.89362375 -521.1714656 556.12169542 -535 550 C-535.82016602 549.6376123 -536.64033203 549.27522461 -537.48535156 548.90185547 C-555.09414751 541.04886956 -571.84383483 531.49757491 -588 521 C-588.64308105 520.58363281 -589.28616211 520.16726563 -589.94873047 519.73828125 C-597.91875871 514.5590577 -605.68912231 509.1840643 -613.21582031 503.37207031 C-615.37252095 501.71352385 -617.54237645 500.07269343 -619.7109375 498.4296875 C-621.37028579 497.16210491 -623.02914021 495.89387555 -624.6875 494.625 C-625.89273315 493.71379395 -625.89273315 493.71379395 -627.12231445 492.78417969 C-627.86956787 492.20829102 -628.61682129 491.63240234 -629.38671875 491.0390625 C-630.05920654 490.52553223 -630.73169434 490.01200195 -631.42456055 489.48291016 C-633 488 -633 488 -634 485 C-595.75000001 455.75000001 -595.75000001 455.75000001 -593.62402344 454.12426758 C-592.21059349 453.04339983 -590.79718196 451.96250799 -589.38378906 450.8815918 C-585.79275299 448.13533495 -582.2013752 445.38952697 -578.609375 442.64453125 C-572.23318164 437.77129775 -565.85893186 432.8957448 -559.5 428 C-552.40936531 422.54091682 -545.29963842 417.106922 -538.18945312 411.67333984 C-534.62571009 408.94966737 -531.06288197 406.2247987 -527.5 403.5 C-523.20359801 400.21422442 -518.90697288 396.92874259 -514.609375 393.64453125 C-508.23318164 388.77129775 -501.85893186 383.8957448 -495.5 379 C-488.40936531 373.54091682 -481.29963842 368.106922 -474.18945312 362.67333984 C-470.62571009 359.94966737 -467.06288197 357.2247987 -463.5 354.5 C-459.20359801 351.21422442 -454.90697288 347.92874259 -450.609375 344.64453125 C-444.23318164 339.77129775 -437.85893186 334.8957448 -431.5 330 C-424.40936531 324.54091682 -417.29963842 319.106922 -410.18945312 313.67333984 C-406.62571009 310.94966737 -403.06288197 308.2247987 -399.5 305.5 C-395.20359801 302.21422442 -390.90697288 298.92874259 -386.609375 295.64453125 C-380.23318164 290.77129775 -373.85893186 285.8957448 -367.5 281 C-360.40936531 275.54091682 -353.29963842 270.106922 -346.18945312 264.67333984 C-342.62571009 261.94966737 -339.06288197 259.2247987 -335.5 256.5 C-331.20359801 253.21422442 -326.90697288 249.92874259 -322.609375 246.64453125 C-316.23318164 241.77129775 -309.85893186 236.8957448 -303.5 232 C-296.40936531 226.54091682 -289.29963842 221.106922 -282.18945312 215.67333984 C-278.62571009 212.94966737 -275.06288197 210.2247987 -271.5 207.5 C-267.20359801 204.21422442 -262.90697288 200.92874259 -258.609375 197.64453125 C-252.23318164 192.77129775 -245.85893186 187.8957448 -239.5 183 C-232.40936531 177.54091682 -225.29963842 172.106922 -218.18945312 166.67333984 C-214.62571009 163.94966737 -211.06288197 161.2247987 -207.5 158.5 C-203.20359801 155.21422442 -198.90697288 151.92874259 -194.609375 148.64453125 C-188.23318164 143.77129775 -181.85893186 138.8957448 -175.5 134 C-168.40936531 128.54091682 -161.29963842 123.106922 -154.18945312 117.67333984 C-150.62571009 114.94966737 -147.06288197 112.2247987 -143.5 109.5 C-139.20359801 106.21422442 -134.90697288 102.92874259 -130.609375 99.64453125 C-124.23318164 94.77129775 -117.85893186 89.8957448 -111.5 85 C-104.40936531 79.54091682 -97.29963842 74.106922 -90.18945312 68.67333984 C-86.62571009 65.94966737 -83.06288197 63.2247987 -79.5 60.5 C-75.20359801 57.21422442 -70.90697288 53.92874259 -66.609375 50.64453125 C-60.23318164 45.77129775 -53.85893186 40.8957448 -47.5 36 C-41.15427527 31.11442337 -34.79350162 26.24870137 -28.4296875 21.38671875 C-25.41134378 19.08034983 -22.39605192 16.77006455 -19.3828125 14.45703125 C-18.62774414 13.87800049 -17.87267578 13.29896973 -17.09472656 12.70239258 C-15.66108577 11.60287902 -14.22809596 10.50251591 -12.79589844 9.40112305 C-8.59029089 6.17782084 -4.32776031 3.05753456 0 0 Z" fill="currentColor" transform="translate(768,192)"/>
<path d="M0 0 C3.2513033 0.60590835 5.19347605 1.68115293 7.765625 3.73828125 C8.48234375 4.30482422 9.1990625 4.87136719 9.9375 5.45507812 C10.700625 6.06802734 11.46375 6.68097656 12.25 7.3125 C13.8792625 8.60145687 15.50948858 9.88919659 17.140625 11.17578125 C17.95853516 11.82240723 18.77644531 12.4690332 19.61914062 13.13525391 C23.03810602 15.8130695 26.51372146 18.41080904 30 21 C36.50026935 25.8411607 42.90331047 30.7981505 49.2890625 35.7890625 C54.15193845 39.58243996 59.05431553 43.31536655 64 47 C70.49948228 51.84224377 76.90328261 56.79812873 83.2890625 61.7890625 C88.79205091 66.08177168 94.3555058 70.28486094 99.95214844 74.4543457 C105.8875361 78.88823036 111.72922197 83.43799299 117.56811523 87.99780273 C122.63553171 91.95094692 127.74489064 95.83546603 132.8984375 99.67578125 C138.89988628 104.17308859 144.84151994 108.74930844 150.79443359 113.31054688 C154.36119432 116.04266822 157.93070359 118.77119272 161.5 121.5 C162.91668053 122.5833152 164.33334718 123.66664855 165.75 124.75 C166.45125 125.28625 167.1525 125.8225 167.875 126.375 C208.25 157.25 208.25 157.25 210.37402344 158.87426758 C211.79392684 159.96006647 213.21384878 161.04584112 214.63378906 162.1315918 C218.12608433 164.80200585 221.61808046 167.47280895 225.109375 170.14453125 C232.89953992 176.10518774 240.69648829 182.05682511 248.5 188 C256.9876614 194.46422508 265.46672292 200.93956084 273.93945312 207.42333984 C277.45900665 210.1163821 280.97956226 212.8081138 284.5 215.5 C285.91667128 216.58332729 287.33333796 217.66666062 288.75 218.75 C289.45125 219.28625 290.1525 219.8225 290.875 220.375 C298.66666667 226.33333333 306.45833333 232.29166667 314.25 238.25 C314.95261963 238.78713623 315.65523926 239.32427246 316.37915039 239.87768555 C317.78261224 240.9512442 319.1854542 242.02561375 320.58764648 243.10083008 C324.32641998 245.96598917 328.07781245 248.81253068 331.84765625 251.63671875 C332.6365625 252.23097656 333.42546875 252.82523438 334.23828125 253.4375 C335.76175449 254.58458573 337.28898224 255.72670568 338.8203125 256.86328125 C339.49964844 257.37632812 340.17898438 257.889375 340.87890625 258.41796875 C341.4829126 258.86938232 342.08691895 259.3207959 342.70922852 259.78588867 C343.13518311 260.18654541 343.5611377 260.58720215 344 261 C344 261.66 344 262.32 344 263 C341.7448532 264.83115462 339.47650806 266.5497166 337.125 268.25 C335.64210459 269.34092093 334.16037559 270.43342875 332.6796875 271.52734375 C331.90592773 272.0982373 331.13216797 272.66913086 330.33496094 273.25732422 C326.59349161 276.04973409 322.9233708 278.9314568 319.25 281.8125 C312.89058168 286.78703957 306.47099743 291.67157792 300 296.5 C292.7990085 301.87452727 285.6694135 307.32991968 278.58911133 312.86230469 C271.40688035 318.47329845 264.1650291 324.00444947 256.91943359 329.53320312 C254.107635 331.6819294 251.30365845 333.84066058 248.5 336 C241.40936531 341.45908318 234.29963842 346.893078 227.18945312 352.32666016 C223.62571009 355.05033263 220.06288197 357.7752013 216.5 360.5 C212.20359801 363.78577558 207.90697288 367.07125741 203.609375 370.35546875 C197.23318164 375.22870225 190.85893186 380.1042552 184.5 385 C177.40936531 390.45908318 170.29963842 395.893078 163.18945312 401.32666016 C159.62571009 404.05033263 156.06288197 406.7752013 152.5 409.5 C148.20359801 412.78577558 143.90697288 416.07125741 139.609375 419.35546875 C133.23318164 424.22870225 126.85893186 429.1042552 120.5 434 C111.94789849 440.58426721 103.36880362 447.13321953 94.79296875 453.68652344 C76.34870349 467.78124403 76.34870349 467.78124403 58 482 C55.01250136 480.64686058 52.81617902 479.11284688 50.42578125 476.875 C49.43130981 475.9466333 49.43130981 475.9466333 48.41674805 474.99951172 C47.72234619 474.33967285 47.02794434 473.67983398 46.3125 473 C45.59425049 472.3208252 44.87600098 471.64165039 44.13598633 470.94189453 C38.80402915 465.85769704 33.77498784 460.61347923 29 455 C28.18917969 454.07703125 27.37835938 453.1540625 26.54296875 452.203125 C14.22223513 438.06863283 3.01453086 422.84862348 -7 407 C-7.35690918 406.43635742 -7.71381836 405.87271484 -8.08154297 405.29199219 C-10.82532936 400.92045109 -13.43524985 396.47856827 -16 392 C-16.48339844 391.15888672 -16.96679688 390.31777344 -17.46484375 389.45117188 C-41.86549223 346.64355041 -56.87478237 299.84202218 -63 251 C-63.11714355 250.09958984 -63.23428711 249.19917969 -63.35498047 248.27148438 C-70.79629743 188.69672096 -60.60501649 127.61758835 -39 72 C-38.67064453 71.15050781 -38.34128906 70.30101562 -38.00195312 69.42578125 C-33.37918069 57.75645717 -27.16818744 47.11578809 -20.75390625 36.3515625 C-16.19428615 28.6887179 -11.86469036 20.90105711 -7.53076172 13.10913086 C-6.98049316 12.12050049 -6.43022461 11.13187012 -5.86328125 10.11328125 C-5.14072144 8.81064331 -5.14072144 8.81064331 -4.40356445 7.48168945 C-2.97789852 4.96092163 -1.50059308 2.47676895 0 0 Z" fill="currentColor" transform="translate(65,185)"/>
<path d="M0 0 C5.01383938 4.15268376 9.4883312 8.5103024 13.875 13.3125 C19.28515685 19.15734693 24.79282722 24.8812321 30.4375 30.5 C31.14100586 31.2002832 31.84451172 31.90056641 32.56933594 32.62207031 C34.7109631 34.75000045 36.85502308 36.8754468 39 39 C41.87801616 41.8511487 44.75248109 44.70581414 47.625 47.5625 C48.2636499 48.19285156 48.9022998 48.82320312 49.56030273 49.47265625 C52.5421436 52.43839603 55.41274219 55.43873034 58.14282227 58.63842773 C63.47043387 64.80324739 69.32637712 70.47002301 75.08984375 76.22265625 C76.36119407 77.49468167 77.63239604 78.76685539 78.90345764 80.03916931 C81.55698335 82.69416228 84.21229094 85.34735643 86.86889648 87.99926758 C90.25566535 91.38033978 93.63792393 94.76588258 97.01885128 98.15279484 C99.63973018 100.77730568 102.26300892 103.39940744 104.88699532 106.02081108 C106.13432544 107.26747921 107.38092731 108.51487648 108.62675285 109.76304817 C114.33878086 115.48347351 120.02521239 121.15058657 126.17848206 126.40086365 C129.66705285 129.46352926 132.89459184 132.79338114 136.15625 136.09375 C136.9028186 136.84410522 137.64938721 137.59446045 138.4185791 138.36755371 C141.57701112 141.54216504 144.72939279 144.72275916 147.88232422 147.90283203 C150.20069745 150.23940361 152.5221552 152.57287999 154.84375 154.90625 C155.54294556 155.6137439 156.24214111 156.32123779 156.96252441 157.0501709 C160.9153029 161.02231302 164.96647756 164.80519582 169.22737122 168.4458313 C184.87115959 182.16166762 197.40259748 200.24291705 208 218 C208.68425049 219.14251221 208.68425049 219.14251221 209.38232422 220.30810547 C215.9113578 231.4259733 220.66644683 242.87466158 224.75 255.0625 C224.97495148 255.72728363 225.19990295 256.39206726 225.43167114 257.07699585 C229.57791487 269.44981326 229.57791487 269.44981326 228 273 C226.69995117 274.4128418 226.69995117 274.4128418 225.04296875 275.69921875 C224.43146973 276.18124756 223.8199707 276.66327637 223.18994141 277.15991211 C222.52913574 277.66401611 221.86833008 278.16812012 221.1875 278.6875 C220.50606934 279.21931885 219.82463867 279.7511377 219.12255859 280.29907227 C214.19685955 284.12844321 209.21509254 287.88462 204.20703125 291.60546875 C200.38156068 294.45123085 196.59767347 297.35097323 192.8125 300.25 C192.09497559 300.79946289 191.37745117 301.34892578 190.63818359 301.91503906 C189.16640189 303.0423473 187.6947232 304.16979002 186.22314453 305.29736328 C183.28737388 307.54577801 180.3491011 309.79091054 177.41088867 312.03613281 C171.76737139 316.34895067 166.12802452 320.66698112 160.5 325 C153.40936531 330.45908318 146.29963842 335.893078 139.18945312 341.32666016 C135.62571009 344.05033263 132.06288197 346.7752013 128.5 349.5 C124.20359801 352.78577558 119.90697288 356.07125741 115.609375 359.35546875 C109.23318164 364.22870225 102.85893186 369.1042552 96.5 374 C89.40936531 379.45908318 82.29963842 384.893078 75.18945312 390.32666016 C71.62571009 393.05033263 68.06288197 395.7752013 64.5 398.5 C60.20359801 401.78577558 55.90697288 405.07125741 51.609375 408.35546875 C50.15622807 409.46611714 48.70310288 410.57679398 47.25 411.6875 C46.54206299 412.22858398 45.83412598 412.76966797 45.10473633 413.32714844 C40.79161714 416.62526863 36.48708071 419.93426031 32.1875 423.25 C26.16542292 427.88821593 20.0927124 432.45516589 14 437 C7.51907445 432.99552567 1.62954037 428.3760228 -4.28198242 423.59448242 C-9.04060604 419.75031898 -13.88215946 416.0431245 -18.79296875 412.39453125 C-22.61843961 409.54876894 -26.40231321 406.64900978 -30.1875 403.75 C-31.26813721 402.92254272 -31.26813721 402.92254272 -32.37060547 402.07836914 C-33.84532952 400.94888018 -35.31993803 399.81924035 -36.79443359 398.68945312 C-40.36119432 395.95733178 -43.93070359 393.22880728 -47.5 390.5 C-48.91668053 389.4166848 -50.33334718 388.33335145 -51.75 387.25 C-52.45125 386.71375 -53.1525 386.1775 -53.875 385.625 C-60.25 380.75 -60.25 380.75 -62.37402344 379.12573242 C-63.79392684 378.03993353 -65.21384878 376.95415888 -66.63378906 375.8684082 C-70.12608433 373.19799415 -73.61808046 370.52719105 -77.109375 367.85546875 C-84.89953992 361.89481226 -92.69648829 355.94317489 -100.5 350 C-108.9876614 343.53577492 -117.46672292 337.06043916 -125.93945312 330.57666016 C-129.45900665 327.8836179 -132.97956226 325.1918862 -136.5 322.5 C-137.91667128 321.41667271 -139.33333796 320.33333938 -140.75 319.25 C-141.45125 318.71375 -142.1525 318.1775 -142.875 317.625 C-163.0625 302.1875 -163.0625 302.1875 -183.25 286.75 C-183.95253906 286.21310547 -184.65507812 285.67621094 -185.37890625 285.12304688 C-186.78388635 284.04796542 -188.18755174 282.97116347 -189.58984375 281.89257812 C-193.30090734 279.04190078 -197.03551813 276.23165474 -200.8125 273.46875 C-201.59689453 272.88802734 -202.38128906 272.30730469 -203.18945312 271.70898438 C-204.69559542 270.5949738 -206.20962676 269.49152729 -207.73242188 268.40039062 C-212.6822969 264.71511665 -212.6822969 264.71511665 -214.08984375 261.546875 C-213.08994957 233.20204874 -185.94170012 200.05546656 -168 180 C-167.54189941 179.48550293 -167.08379883 178.97100586 -166.61181641 178.44091797 C-159.90101856 170.94171217 -152.8755421 163.78020873 -145.69458008 156.73120117 C-141.8436466 152.9318275 -138.22595384 149.01434703 -134.69458008 144.91723633 C-132.09468053 141.97572774 -129.30670534 139.24234885 -126.5 136.5 C-122.39956998 132.45073088 -118.46850375 128.35369549 -114.73828125 123.95703125 C-111.78518422 120.63230853 -108.57244491 117.56553758 -105.41015625 114.44140625 C-102.73145468 111.72797273 -100.25391882 108.89222977 -97.77734375 105.99609375 C-95.12305044 103.01511819 -92.27011363 100.24712517 -89.40625 97.46875 C-86.78389151 94.77827831 -84.3401503 91.96902677 -81.87841797 89.13232422 C-78.77626451 85.61085187 -75.54238852 82.21646385 -72.3125 78.8125 C-65.97455001 72.1056901 -59.68487426 65.35831433 -53.43994141 58.56494141 C-51.44908119 56.40125644 -49.45331002 54.24212591 -47.45776367 52.08276367 C-41.74522814 45.90052874 -36.05172863 39.70109531 -30.36767578 33.49267578 C-28.97420848 31.97185124 -27.57912249 30.45252676 -26.18359375 28.93359375 C-20.41783649 22.65612428 -14.69198511 16.34450545 -9 10 C-7.31278465 8.12474385 -5.62529093 6.24973813 -3.9375 4.375 C-3.18339844 3.53710938 -2.42929687 2.69921875 -1.65234375 1.8359375 C-1.10707031 1.23007812 -0.56179688 0.62421875 0 0 Z" fill="currentColor" transform="translate(409,0)"/>
</svg>`;
