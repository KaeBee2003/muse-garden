import { TFile, TFolder, normalizePath } from 'obsidian';
import type MuseGardenPlugin from './main';
import type { ProjectMarker } from './settings';
import { makeProjectId } from './settings';
import { AudioTrack } from './audioStore';

/** Frontmatter key used to round-trip the marker -> real folder mapping if settings.json is ever lost. */
const FOLDER_PATH_KEY = 'muse-garden-folder';

/** Finds an existing ProjectMarker for `folderVaultPath`, if one has been created already. */
export function findProjectForFolder(
	plugin: MuseGardenPlugin,
	folderVaultPath: string,
): ProjectMarker | undefined {
	return plugin.settings.projects.find((p) => p.folderVaultPath === folderVaultPath);
}

export function findProjectByMarkerPath(
	plugin: MuseGardenPlugin,
	markerVaultPath: string,
): ProjectMarker | undefined {
	return plugin.settings.projects.find((p) => p.markerVaultPath === markerVaultPath);
}

/**
 * Returns the ProjectMarker and its marker TFile for `folderVaultPath`, creating
 * the marker .md file (in our own MuseGardenProjectMarkers space, never inside the
 * user's real folders) and a settings entry if one doesn't exist yet.
 */
export async function getOrCreateProjectForFolder(
	plugin: MuseGardenPlugin,
	folderVaultPath: string,
): Promise<{ project: ProjectMarker; markerFile: TFile }> {
	const existing = findProjectForFolder(plugin, folderVaultPath);
	if (existing) {
		let file = plugin.app.vault.getAbstractFileByPath(existing.markerVaultPath);
		if (!(file instanceof TFile)) {
			file = await writeMarkerFile(plugin, existing.markerVaultPath, folderVaultPath);
		}
		return { project: existing, markerFile: file as TFile };
	}

	const folder = plugin.app.vault.getAbstractFileByPath(folderVaultPath);
	const label = folder instanceof TFolder ? folder.name : folderVaultPath.split('/').pop() ?? folderVaultPath;

	await ensureMarkerFolderExists(plugin);
	const markerVaultPath = await pickMarkerPath(plugin, label);
	const markerFile = await writeMarkerFile(plugin, markerVaultPath, folderVaultPath);

	const project: ProjectMarker = {
		id: makeProjectId(),
		folderVaultPath,
		markerVaultPath,
		label,
		tags: [],
	};
	plugin.settings.projects.push(project);
	await plugin.saveSettings();
	return { project, markerFile };
}

/** Add a tag to a Project (folder-level, distinct from any track's own tags). No-op if already present. */
export async function addProjectTag(plugin: MuseGardenPlugin, project: ProjectMarker, tag: string): Promise<void> {
	const clean = tag.trim();
	if (!clean) return;

	if (!project.tags.includes(clean)) {
		project.tags.push(clean);
		await plugin.saveSettings();
	}

	const markerFile = plugin.app.vault.getAbstractFileByPath(project.markerVaultPath);
	if (markerFile instanceof TFile) {
		await plugin.app.fileManager.processFrontMatter(markerFile, (frontmatter) => {
			const existingTags = frontmatter.tags || [];
			if (Array.isArray(existingTags)) {
				if (!existingTags.includes(clean)) {
					existingTags.push(clean);
					frontmatter.tags = existingTags;
				}
			} else {
				const str = String(existingTags).trim();
				frontmatter.tags = str ? [str, clean] : [clean];
			}
		});
	}

	plugin.app.workspace.trigger('muse-garden:settings-changed');
}

/** Remove a tag from a Project. */
export async function removeProjectTag(plugin: MuseGardenPlugin, project: ProjectMarker, tag: string): Promise<void> {
	if (project.tags.includes(tag)) {
		project.tags = project.tags.filter((t) => t !== tag);
		await plugin.saveSettings();
	}

	const markerFile = plugin.app.vault.getAbstractFileByPath(project.markerVaultPath);
	if (markerFile instanceof TFile) {
		await plugin.app.fileManager.processFrontMatter(markerFile, (frontmatter) => {
			const existingTags = frontmatter.tags;
			if (Array.isArray(existingTags)) {
				frontmatter.tags = existingTags.filter((t) => t !== tag);
			} else if (typeof existingTags === 'string' && existingTags === tag) {
				frontmatter.tags = [];
			}
		});
	}

	plugin.app.workspace.trigger('muse-garden:settings-changed');
}

/** Syncs a project's in-memory tags with its marker file's frontmatter properties. Returns true if tags changed. */
export function syncProjectTagsFromCache(plugin: MuseGardenPlugin, project: ProjectMarker): boolean {
	const file = plugin.app.vault.getAbstractFileByPath(project.markerVaultPath);
	if (file instanceof TFile) {
		const cache = plugin.app.metadataCache.getFileCache(file);
		const tags = cache?.frontmatter?.tags;
		let newTags: string[] = [];
		if (Array.isArray(tags)) {
			newTags = tags.map((t) => String(t).trim()).filter(Boolean);
		} else if (tags) {
			newTags = [String(tags).trim()].filter(Boolean);
		}

		const sortedOld = [...project.tags].sort().join(',');
		const sortedNew = [...newTags].sort().join(',');
		if (sortedOld !== sortedNew) {
			project.tags = newTags;
			return true;
		}
	}
	return false;
}

/** All distinct tags used on projects, for autocomplete/picker. */
export function getAllKnownProjectTags(plugin: MuseGardenPlugin): string[] {
	const set = new Set<string>();
	for (const project of plugin.settings.projects) {
		for (const tag of project.tags) set.add(tag);
	}
	return Array.from(set).sort();
}

/** Direct-children-only audio tracks for a project's real folder (subfolders intentionally excluded). */
export function getProjectTracks(plugin: MuseGardenPlugin, project: ProjectMarker): AudioTrack[] {
	const initial = plugin.app.vault.getAbstractFileByPath(project.folderVaultPath);
	const folder: TFolder | null =
		initial instanceof TFolder
			? initial
			: repairFolderPath(plugin, project); // null if repair couldn't find it either
	if (!folder) return [];

	const extensions = new Set(plugin.settings.audioExtensions.map((e) => e.toLowerCase()));
	const tracks: AudioTrack[] = [];
	const directoryId =
		plugin.settings.directories.find((d) => project.folderVaultPath.startsWith(d.vaultLinkPath))?.id ?? '';

	for (const child of folder.children) {
		if (child instanceof TFile && extensions.has(child.extension.toLowerCase())) {
			tracks.push({
				vaultPath: child.path,
				name: child.basename,
				extension: child.extension.toLowerCase(),
				directoryId,
				tags: plugin.settings.tags[child.path]?.tags ?? [],
			});
		}
	}
	tracks.sort((a, b) => a.name.localeCompare(b.name));
	return tracks;
}

/**
 * Attempts to find the project's real folder under a currently-watched
 * directory by basename, when the stored folderVaultPath no longer
 * resolves (e.g. the watched directory's own link path moved after this
 * project's marker was created — see the MuseGardenConfig migration in
 * main.ts, which fixed this going forward but can't retroactively repair
 * markers created before the fix). Updates and saves settings on success.
 */
function repairFolderPath(plugin: MuseGardenPlugin, project: ProjectMarker): TFolder | null {
	const targetName = project.folderVaultPath.split('/').pop();
	if (!targetName) return null;

	for (const dir of plugin.settings.directories) {
		const root = plugin.app.vault.getAbstractFileByPath(dir.vaultLinkPath);
		if (!(root instanceof TFolder)) continue;

		const found = findFolderByName(root, targetName);
		if (found) {
			project.folderVaultPath = found.path;
			void plugin.saveSettings();
			return found;
		}
	}
	return null;
}

function findFolderByName(root: TFolder, name: string): TFolder | null {
	if (root.name === name) return root;
	for (const child of root.children) {
		if (child instanceof TFolder) {
			const found = findFolderByName(child, name);
			if (found) return found;
		}
	}
	return null;
}

async function ensureMarkerFolderExists(plugin: MuseGardenPlugin): Promise<void> {
	const path = normalizePath(plugin.settings.markerFolder);
	const existing = plugin.app.vault.getAbstractFileByPath(path);
	if (!(existing instanceof TFolder)) {
		await plugin.app.vault.createFolder(path).catch(() => {
			// Folder may have been created concurrently; ignore "already exists" errors.
		});
	}
}

/** Picks a non-colliding marker filename based on the project label. */
async function pickMarkerPath(plugin: MuseGardenPlugin, label: string): Promise<string> {
	const safeName = label.replace(/[\\/:*?"<>|]/g, '_') || 'project';
	let candidate = `${plugin.settings.markerFolder}/${safeName}.md`;
	let i = 2;
	while (plugin.app.vault.getAbstractFileByPath(normalizePath(candidate))) {
		candidate = `${plugin.settings.markerFolder}/${safeName}-${i}.md`;
		i++;
	}
	return normalizePath(candidate);
}

async function writeMarkerFile(
	plugin: MuseGardenPlugin,
	markerVaultPath: string,
	folderVaultPath: string,
): Promise<TFile> {
	const content = [
		'---',
		`${FOLDER_PATH_KEY}: "${folderVaultPath}"`,
		'tags: []',
		'---',
		'',
		'This file represents a Muse Garden Project node. Do not delete — it is',
		'referenced by a canvas. Muse Garden manages this file automatically.',
		'',
	].join('\n');

	const existing = plugin.app.vault.getAbstractFileByPath(markerVaultPath);
	if (existing instanceof TFile) {
		await plugin.app.vault.modify(existing, content);
		return existing;
	} else {
		return await plugin.app.vault.create(markerVaultPath, content);
	}
}
