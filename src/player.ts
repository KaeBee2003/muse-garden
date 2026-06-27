import { Component, TFile, setIcon } from 'obsidian';
import type MuseGardenPlugin from './main';

/** Snapshot of playback state, broadcast to any UI that wants to mirror it (bottom bar, canvas nodes, etc). */
export interface PlaybackState {
	vaultPath: string | null;
	isPlaying: boolean;
}

/** Fine-grained progress, broadcast far more often than PlaybackState (every timeupdate tick). */
export interface ProgressState {
	vaultPath: string | null;
	currentTime: number;
	duration: number;
}

type PlaybackListener = (state: PlaybackState) => void;
type ProgressListener = (state: ProgressState) => void;

/**
 * Owns a single shared <audio> element and a small persistent bottom bar UI.
 * Lives for the whole plugin lifetime, independent of any one view, so
 * playback keeps going no matter which sidebar/tab is focused.
 *
 * Any other UI (canvas audio nodes, future widgets) can call `subscribe()`
 * to stay in sync with playback state, and call `play()`/`togglePlayPause()`
 * to control it — there is exactly one <audio> element and one source of
 * truth, no matter how many UIs are showing it.
 */
export class MuseGardenPlayer extends Component {
	private plugin: MuseGardenPlugin;
	private audioEl: HTMLAudioElement;
	private barEl: HTMLElement;
	private titleEl!: HTMLElement;
	private tagsEl!: HTMLElement;
	private playPauseBtn!: HTMLElement;
	private seekFillEl!: HTMLElement;
	private seekHandleEl!: HTMLElement;
	private volumeIconEl!: HTMLElement;
	private volumePopoverEl!: HTMLElement;
	private volumeFillEl!: HTMLElement;
	private volumeHandleEl!: HTMLElement;
	private preMuteVolume = 1;
	private currentTimeEl!: HTMLElement;
	private durationEl!: HTMLElement;
	private currentPath: string | null = null;
	private isScrubbing = false;
	private listeners = new Set<PlaybackListener>();
	private progressListeners = new Set<ProgressListener>();
	private mainAreaObserver: ResizeObserver | null = null;

	constructor(plugin: MuseGardenPlugin) {
		super();
		this.plugin = plugin;
		this.audioEl = activeDocument.createElement('audio');
		this.barEl = this.buildBar();
	}

	onload(): void {
		activeDocument.body.appendChild(this.barEl);
		this.setupMainAreaTracking();

		this.registerDomEvent(this.audioEl, 'timeupdate', () => this.onTimeUpdate());
		this.registerDomEvent(this.audioEl, 'loadedmetadata', () => this.onTimeUpdate());
		this.registerDomEvent(this.audioEl, 'play', () => {
			this.setPlayPauseIcon(true);
			this.emitState();
		});
		this.registerDomEvent(this.audioEl, 'pause', () => {
			this.setPlayPauseIcon(false);
			this.emitState();
		});
		this.registerDomEvent(this.audioEl, 'ended', () => {
			this.setPlayPauseIcon(false);
			this.emitState();
		});

		// Re-render tags when settings change (e.g. toggle showTagsInPlayer).
		this.registerEvent(
			this.plugin.app.workspace.on(
				'muse-garden:settings-changed' as Parameters<typeof this.plugin.app.workspace.on>[0],
				() => this.refreshTags(),
			),
		);
	}

	/**
	 * Keeps the bar's left edge and width matched to Obsidian's own main
	 * content area (`.workspace .mod-root`, excludes both sidebars), instead
	 * of spanning the full window width. A full-width bar would otherwise sit
	 * on top of sidebar footers and canvas toolbar controls, which live at
	 * the very bottom of the window outside the main content area.
	 *
	 * Re-measures on resize (sidebar collapsed/resized, window resized) via
	 * ResizeObserver, and re-locates the target element on layout changes
	 * (sidebar toggled entirely) via Obsidian's own workspace event.
	 */
	private setupMainAreaTracking(): void {
		const reposition = () => {
			const mainEl = activeDocument.querySelector('.workspace .mod-root');
			if (!mainEl) {
				// Fall back to full width if we can't find it for some reason,
				// rather than leaving the bar invisible.
				this.barEl.setCssStyles({ left: '0', width: '100%' });
				return;
			}
			const rect = mainEl.getBoundingClientRect();
			this.barEl.setCssStyles({ left: `${rect.left}px`, width: `${rect.width}px` });
		};

		reposition();

		this.mainAreaObserver = new ResizeObserver(() => reposition());
		const mainEl = activeDocument.querySelector('.workspace .mod-root');
		if (mainEl) this.mainAreaObserver.observe(mainEl);
		// Also observe the whole workspace, since the .mod-root element
		// itself can be replaced (e.g. sidebar toggled) without a single
		// persistent node to keep observing.
		const workspaceEl = activeDocument.querySelector('.workspace');
		if (workspaceEl) this.mainAreaObserver.observe(workspaceEl);

		this.registerEvent(this.plugin.app.workspace.on('resize', reposition));
		this.registerEvent(this.plugin.app.workspace.on('layout-change', reposition));
	}

	onunload(): void {
		this.audioEl.pause();
		this.audioEl.remove();
		this.barEl.remove();
		activeDocument.body.removeClass('has-muse-player-bar');
		this.listeners.clear();
		this.progressListeners.clear();
		this.mainAreaObserver?.disconnect();
		this.mainAreaObserver = null;
	}

	/** Stop playback entirely and hide the player bar. */
	stop(): void {
		this.audioEl.pause();
		this.audioEl.src = '';
		this.currentPath = null;
		this.barEl.removeClass('is-visible');
		activeDocument.body.removeClass('has-muse-player-bar');
		this.emitState();
		this.emitProgress();
	}

	/** Play a track by its vault-relative path. */
	play(vaultPath: string): void {
		const file = this.plugin.app.vault.getAbstractFileByPath(vaultPath);
		if (!(file instanceof TFile)) return;

		this.currentPath = vaultPath;
		const resourceUrl = this.plugin.app.vault.getResourcePath(file);
		this.audioEl.src = resourceUrl;
		this.audioEl.play().catch((err) => console.error('Muse Garden: playback failed', err));

		this.titleEl.setText(file.basename);
		this.barEl.addClass('is-visible');
		activeDocument.body.addClass('has-muse-player-bar');
		this.seekFillEl.setCssStyles({ width: '0%' });
		this.seekHandleEl.setCssStyles({ left: '0%' });
		this.refreshTags();
		this.emitState(); // covers the track-switch itself, separate from the 'play' DOM event
		this.emitProgress();
	}

	togglePlayPause(): void {
		if (!this.currentPath) return;
		if (this.audioEl.paused) {
			this.audioEl.play().catch((err) => console.error('Muse Garden: playback failed', err));
		} else {
			this.audioEl.pause();
		}
	}

	/** Toggle play/pause for a specific track. If a different track is currently loaded, switches to it instead. */
	togglePlayPauseFor(vaultPath: string): void {
		if (this.currentPath === vaultPath) {
			this.togglePlayPause();
		} else {
			this.play(vaultPath);
		}
	}

	/** Current snapshot, for UI that's just mounting and needs the state immediately. */
	getState(): PlaybackState {
		return { vaultPath: this.currentPath, isPlaying: !this.audioEl.paused };
	}

	/** True if `vaultPath` is the loaded track AND it's currently playing (not just loaded/paused). */
	isPlayingTrack(vaultPath: string): boolean {
		return this.currentPath === vaultPath && !this.audioEl.paused;
	}

	/**
	 * Subscribe to playback state changes (track switches, play, pause).
	 * Returns an unsubscribe function — callers (e.g. a canvas node about to
	 * be removed from the DOM) MUST call it to avoid leaking listeners.
	 */
	subscribe(listener: PlaybackListener): () => void {
		this.listeners.add(listener);
		listener(this.getState()); // immediate sync on subscribe
		return () => this.listeners.delete(listener);
	}

	/**
	 * Subscribe to fine-grained playback progress (current time / duration),
	 * updated on every timeupdate tick. Separate from subscribe() so UI that
	 * only cares about play/pause state isn't re-invoked dozens of times a
	 * second. Returns an unsubscribe function — callers MUST call it when
	 * their UI is removed, to avoid leaking listeners.
	 */
	subscribeProgress(listener: ProgressListener): () => void {
		this.progressListeners.add(listener);
		listener(this.getProgressState());
		return () => this.progressListeners.delete(listener);
	}

	private getProgressState(): ProgressState {
		return {
			vaultPath: this.currentPath,
			currentTime: this.audioEl.currentTime || 0,
			duration: this.audioEl.duration || 0,
		};
	}

	private emitProgress(): void {
		const state = this.getProgressState();
		for (const listener of this.progressListeners) listener(state);
	}

	private emitState(): void {
		const state = this.getState();
		for (const listener of this.listeners) listener(state);
	}

	/** Refresh the tag chips row based on the currently playing track and showTagsInPlayer setting. */
	private refreshTags(): void {
		if (!this.tagsEl) return;
		this.tagsEl.empty();

		const showTags = this.plugin.settings.showTagsInPlayer;
		const tags = this.currentPath ? (this.plugin.settings.tags[this.currentPath]?.tags ?? []) : [];

		if (showTags && tags.length > 0) {
			this.tagsEl.setCssStyles({ display: 'flex' });
			for (const tag of tags) {
				this.tagsEl.createSpan({ cls: 'muse-player-tag-chip', text: tag });
			}
		} else {
			this.tagsEl.setCssStyles({ display: 'none' });
		}
	}

	private buildBar(): HTMLElement {
		const bar = activeDocument.createElement('div');
		bar.className = 'muse-garden-player-bar';

		// ── Info: icon + title + tags ─────────────────────────────────────
		const info = bar.createDiv({ cls: 'muse-player-info' });
		const musicIcon = info.createSpan({ cls: 'muse-player-icon' });
		setIcon(musicIcon, 'music');

		const infoText = info.createDiv({ cls: 'muse-player-info-text' });
		this.titleEl = infoText.createSpan({ cls: 'muse-player-title', text: 'Nothing playing' });
		this.tagsEl = infoText.createDiv({ cls: 'muse-player-tags' });
		this.tagsEl.setCssStyles({ display: 'none' });

		// ── Controls: play/pause ──────────────────────────────────────────
		const controls = bar.createDiv({ cls: 'muse-player-controls' });
		this.playPauseBtn = controls.createEl('button', { cls: 'muse-player-playpause' });
		setIcon(this.playPauseBtn, 'play');
		this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());

		// ── Timeline: current time + seek bar + duration ──────────────────
		const timeline = bar.createDiv({ cls: 'muse-player-timeline' });
		this.currentTimeEl = timeline.createSpan({ cls: 'muse-player-time', text: '0:00' });

		// Custom progress bar (not a native <input type="range">): gives us a
		// colored fill and a smooth CSS-transitioned width, which a native
		// range input can't do without non-standard vendor pseudo-elements.
		const seekTrack = timeline.createDiv({ cls: 'muse-player-seek-track' });
		this.seekFillEl = seekTrack.createDiv({ cls: 'muse-player-seek-fill' });
		this.seekHandleEl = seekTrack.createDiv({ cls: 'muse-player-seek-handle' });

		const seekToClientX = (clientX: number) => {
			const rect = seekTrack.getBoundingClientRect();
			const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
			return pct;
		};
		seekTrack.addEventListener('mousedown', (evt: MouseEvent) => {
			this.isScrubbing = true;
			const pct = seekToClientX(evt.clientX);
			this.setSeekVisual(pct);
			const onMove = (moveEvt: MouseEvent) => this.setSeekVisual(seekToClientX(moveEvt.clientX));
			const onUp = (upEvt: MouseEvent) => {
				const finalPct = seekToClientX(upEvt.clientX);
				if (this.audioEl.duration) this.audioEl.currentTime = finalPct * this.audioEl.duration;
				this.isScrubbing = false;
				window.removeEventListener('mousemove', onMove);
				window.removeEventListener('mouseup', onUp);
			};
			window.addEventListener('mousemove', onMove);
			window.addEventListener('mouseup', onUp);
		});

		this.durationEl = timeline.createSpan({ cls: 'muse-player-time', text: '0:00' });

		// ── Volume control — icon only; vertical popover on hover ─────────
		const volumeWrap = bar.createDiv({ cls: 'muse-player-volume' });
		this.volumeIconEl = volumeWrap.createSpan({ cls: 'muse-player-volume-icon' });
		setIcon(this.volumeIconEl, 'volume-2');

		// Mute toggle on click
		this.volumeIconEl.addEventListener('click', () => this.toggleMute());

		// Scroll wheel changes volume
		this.volumeIconEl.addEventListener('wheel', (evt) => {
			evt.preventDefault();
			const delta = evt.deltaY < 0 ? 0.05 : -0.05;
			this.setVolume(Math.min(1, Math.max(0, this.audioEl.volume + delta)));
		}, { passive: false });

		// Vertical slider popover (shown via CSS :hover on volumeWrap)
		this.volumePopoverEl = volumeWrap.createDiv({ cls: 'muse-player-volume-popover' });
		const volumeTrack = this.volumePopoverEl.createDiv({ cls: 'muse-player-volume-track' });
		this.volumeFillEl = volumeTrack.createDiv({ cls: 'muse-player-volume-fill' });
		this.volumeHandleEl = volumeTrack.createDiv({ cls: 'muse-player-volume-handle' });

		// Vertical track interaction: clientY-based, inverted (top = max)
		const volumeFromClientY = (clientY: number) => {
			const rect = volumeTrack.getBoundingClientRect();
			// Invert: top of track = 100%, bottom = 0%
			return Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height));
		};
		volumeTrack.addEventListener('mousedown', (evt) => {
			evt.stopPropagation();
			const apply = (clientY: number) => this.setVolume(volumeFromClientY(clientY));
			apply(evt.clientY);
			const onMove = (moveEvt: MouseEvent) => apply(moveEvt.clientY);
			const onUp = () => {
				window.removeEventListener('mousemove', onMove);
				window.removeEventListener('mouseup', onUp);
			};
			window.addEventListener('mousemove', onMove);
			window.addEventListener('mouseup', onUp);
		});

		// Scroll wheel on popover too
		this.volumePopoverEl.addEventListener('wheel', (evt) => {
			evt.preventDefault();
			const delta = evt.deltaY < 0 ? 0.05 : -0.05;
			this.setVolume(Math.min(1, Math.max(0, this.audioEl.volume + delta)));
		}, { passive: false });

		this.setVolume(this.plugin.settings.volume, false);

		// Close button after volume icon/controls
		const closeBtn = bar.createEl('button', { cls: 'muse-player-close', attr: { 'aria-label': 'Close player' } });
		setIcon(closeBtn, 'x');
		closeBtn.addEventListener('click', () => this.stop());

		return bar;
	}

	private toggleMute(): void {
		if (this.audioEl.volume > 0) {
			this.preMuteVolume = this.audioEl.volume;
			this.setVolume(0);
		} else {
			this.setVolume(this.preMuteVolume || 1);
		}
	}

	/** Sets playback volume (0-1), updates the visual slider, and persists to settings unless `persist` is false. */
	private setVolume(volume: number, persist = true): void {
		const clamped = Math.min(1, Math.max(0, volume));
		this.audioEl.volume = clamped;
		// Vertical fill: fill from bottom upward (height % = volume %)
		this.volumeFillEl.setCssStyles({ height: `${clamped * 100}%` });
		// Handle position: 0% = bottom, 100% = top  →  top = (1 - clamped) * 100%
		this.volumeHandleEl.setCssStyles({ top: `${(1 - clamped) * 100}%` });
		setIcon(this.volumeIconEl, clamped === 0 ? 'volume-x' : clamped < 0.5 ? 'volume-1' : 'volume-2');
		if (persist) {
			this.plugin.settings.volume = clamped;
			void this.plugin.saveSettings();
		}
	}

	private setSeekVisual(pct: number): void {
		this.seekFillEl.setCssStyles({ width: `${pct * 100}%` });
		this.seekHandleEl.setCssStyles({ left: `${pct * 100}%` });
		this.currentTimeEl.setText(formatTime(pct * (this.audioEl.duration || 0)));
	}

	private onTimeUpdate(): void {
		this.durationEl.setText(formatTime(this.audioEl.duration || 0));
		if (!this.isScrubbing) {
			this.currentTimeEl.setText(formatTime(this.audioEl.currentTime || 0));
			if (this.audioEl.duration) {
				const pct = this.audioEl.currentTime / this.audioEl.duration;
				this.seekFillEl.setCssStyles({ width: `${pct * 100}%` });
				this.seekHandleEl.setCssStyles({ left: `${pct * 100}%` });
			}
		}
		this.emitProgress();
	}

	private setPlayPauseIcon(isPlaying: boolean): void {
		setIcon(this.playPauseBtn, isPlaying ? 'pause' : 'play');
	}
}

function formatTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) return '0:00';
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, '0')}`;
}
