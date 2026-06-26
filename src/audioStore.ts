import { TFile, TFolder, normalizePath } from 'obsidian';
import type MuseGardenPlugin from './main';

/** A single audio file discovered under a watched directory. */
export interface AudioTrack {
	/** Vault-relative path (works with app.vault APIs, drag-and-drop, canvas file nodes). */
	vaultPath: string;
	/** File name without extension. */
	name: string;
	/** Lowercased extension, no dot (e.g. "wav"). */
	extension: string;
	/** Which watched directory this track came from (by id). */
	directoryId: string;
	/** Manual tags/genres the user has assigned, if any. */
	tags: string[];
}

/** A folder in the tree, with its direct tracks and direct subfolders (recursive). */
export interface FolderNode {
	/** Vault-relative path to this folder. */
	vaultPath: string;
	/** Display name (folder basename, or the watched directory's friendly label at the root). */
	name: string;
	/** Which watched directory this folder belongs to (by id) — same for the whole subtree. */
	directoryId: string;
	subfolders: FolderNode[];
	/** Audio files directly inside this folder — NOT including subfolder contents. */
	tracks: AudioTrack[];
}

function trackFromFile(plugin: MuseGardenPlugin, file: TFile, directoryId: string): AudioTrack {
	return {
		vaultPath: file.path,
		name: file.basename,
		extension: file.extension.toLowerCase(),
		directoryId,
		tags: plugin.settings.tags[file.path]?.tags ?? [],
	};
}

/**
 * Builds one FolderNode per watched directory, each containing its full
 * subfolder/track tree. Live — reads straight from Obsidian's vault index,
 * no caching, so it always reflects the current state of the linked folders.
 */
export function buildFolderTree(plugin: MuseGardenPlugin): FolderNode[] {
	const extensions = new Set(plugin.settings.audioExtensions.map((e) => e.toLowerCase()));
	const roots: FolderNode[] = [];

	for (const dir of plugin.settings.directories) {
		const root = plugin.app.vault.getAbstractFileByPath(normalizePath(dir.vaultLinkPath));
		if (!(root instanceof TFolder)) continue; // link missing/broken; skip silently here

		const node = buildNode(plugin, root, dir.id, extensions);
		node.name = dir.label; // use the friendly label at the watched-directory root
		roots.push(node);
	}

	return roots;
}

function buildNode(
	plugin: MuseGardenPlugin,
	folder: TFolder,
	directoryId: string,
	extensions: Set<string>,
): FolderNode {
	const node: FolderNode = {
		vaultPath: folder.path,
		name: folder.name,
		directoryId,
		subfolders: [],
		tracks: [],
	};

	for (const child of folder.children) {
		if (child instanceof TFile) {
			if (extensions.has(child.extension.toLowerCase())) {
				node.tracks.push(trackFromFile(plugin, child, directoryId));
			}
		} else if (child instanceof TFolder) {
			node.subfolders.push(buildNode(plugin, child, directoryId, extensions));
		}
	}

	// Keep listings stable and predictable: folders first, then tracks, both alphabetical.
	node.subfolders.sort((a, b) => a.name.localeCompare(b.name));
	node.tracks.sort((a, b) => a.name.localeCompare(b.name));

	return node;
}

/** Flattens a folder tree into AudioTrack[], for search filtering across the whole tree. */
export function flattenTree(roots: FolderNode[]): AudioTrack[] {
	const out: AudioTrack[] = [];
	const visit = (node: FolderNode) => {
		out.push(...node.tracks);
		for (const sub of node.subfolders) visit(sub);
	};
	for (const root of roots) visit(root);
	return out;
}

/** Search query used by the Explorer split search bar. */
export interface ExplorerQuery {
	nameQuery: string;
	tags: string[];
}

/**
 * Returns a filtered copy of the tree containing only folders / tracks that
 * match the given query. `nameQuery` matches the track name (not tags);
 * `tags` must ALL be present on the track (AND filter). Folders that contain
 * a matching descendant are kept in the tree; fully-empty branches are pruned.
 */
export function filterTree(roots: FolderNode[], query: ExplorerQuery): FolderNode[] {
	const nameQ = query.nameQuery.trim().toLowerCase();
	const tagFilters = query.tags.map((t) => t.toLowerCase());
	const hasAnyFilter = nameQ.length > 0 || tagFilters.length > 0;
	if (!hasAnyFilter) return roots;

	const trackMatches = (t: AudioTrack): boolean => {
		if (nameQ && !t.name.toLowerCase().includes(nameQ)) return false;
		if (tagFilters.length > 0 && !tagFilters.every((tf) => t.tags.some((tag) => tag.toLowerCase() === tf))) return false;
		return true;
	};

	const filterNode = (node: FolderNode): FolderNode | null => {
		const matchedTracks = node.tracks.filter(trackMatches);
		const filteredSubfolders = node.subfolders
			.map(filterNode)
			.filter((n): n is FolderNode => n !== null);
		const folderNameMatches = !nameQ && node.name.toLowerCase().includes('');

		if (matchedTracks.length === 0 && filteredSubfolders.length === 0) {
			return null;
		}
		return {
			...node,
			tracks: matchedTracks,
			subfolders: filteredSubfolders,
		};
	};

	return roots.map(filterNode).filter((n): n is FolderNode => n !== null);
}


/**
 * Scans the vault (live, no caching) under each watched directory's symlink
 * and returns every audio file found, decorated with tags from settings.
 */
export function scanAllTracks(plugin: MuseGardenPlugin): AudioTrack[] {
	const tracks: AudioTrack[] = [];
	const extensions = new Set(
		plugin.settings.audioExtensions.map((e) => e.toLowerCase()),
	);

	for (const dir of plugin.settings.directories) {
		const root = plugin.app.vault.getAbstractFileByPath(
			normalizePath(dir.vaultLinkPath),
		);
		if (!(root instanceof TFolder)) continue; // link missing/broken; skip silently here

		walkFolder(root, (file) => {
			const ext = file.extension.toLowerCase();
			if (!extensions.has(ext)) return;
			tracks.push(trackFromFile(plugin, file, dir.id));
		});
	}

	return tracks;
}

function walkFolder(folder: TFolder, onFile: (file: TFile) => void): void {
	for (const child of folder.children) {
		if (child instanceof TFile) {
			onFile(child);
		} else if (child instanceof TFolder) {
			walkFolder(child, onFile);
		}
	}
}

/** Returns tracks whose name or tags match `query` (case-insensitive substring match). */
export function filterTracks(tracks: AudioTrack[], query: string): AudioTrack[] {
	const q = query.trim().toLowerCase();
	if (!q) return tracks;
	return tracks.filter(
		(t) =>
			t.name.toLowerCase().includes(q) ||
			t.tags.some((tag) => tag.toLowerCase().includes(q)),
	);
}

/** Add a tag to a track, persisted in settings. No-op if already present. */
export async function addTag(plugin: MuseGardenPlugin, vaultPath: string, tag: string): Promise<void> {
	const clean = tag.trim();
	if (!clean) return;
	const entry = plugin.settings.tags[vaultPath] ?? { tags: [] };
	if (!entry.tags.includes(clean)) {
		entry.tags.push(clean);
	}
	plugin.settings.tags[vaultPath] = entry;
	await plugin.saveSettings();
	plugin.app.workspace.trigger('muse-garden:settings-changed');
}

/** Remove a tag from a track, persisted in settings. */
export async function removeTag(plugin: MuseGardenPlugin, vaultPath: string, tag: string): Promise<void> {
	const entry = plugin.settings.tags[vaultPath];
	if (!entry) return;
	entry.tags = entry.tags.filter((t) => t !== tag);
	plugin.settings.tags[vaultPath] = entry;
	await plugin.saveSettings();
	plugin.app.workspace.trigger('muse-garden:settings-changed');
}

/** All distinct tags used across the vault, for autocomplete/filter chips. */
export function getAllKnownTags(plugin: MuseGardenPlugin): string[] {
	const set = new Set<string>();
	for (const entry of Object.values(plugin.settings.tags)) {
		for (const tag of entry.tags) set.add(tag);
	}
	return Array.from(set).sort();
}
