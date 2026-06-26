import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import { getActiveCanvas } from './canvasNodeCreate';

export class WebEmbedModal extends Modal {
	private urlInput = '';
	private manualCode = '';
	private activeTab: 'auto' | 'manual' = 'auto';

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText('Add Web Audio/Video Embed');

		// Tab headers
		const tabHeaders = contentEl.createDiv({ cls: 'muse-modal-tabs' });
		const autoTab = tabHeaders.createDiv({
			cls: `muse-modal-tab ${this.activeTab === 'auto' ? 'is-active' : ''}`,
			text: 'From URL (Spotify/YouTube/Drive)',
		});
		const manualTab = tabHeaders.createDiv({
			cls: `muse-modal-tab ${this.activeTab === 'manual' ? 'is-active' : ''}`,
			text: 'Pasted Iframe Code',
		});

		const tabContent = contentEl.createDiv({ cls: 'muse-modal-tab-content' });

		const renderContent = () => {
			tabContent.empty();
			autoTab.classList.toggle('is-active', this.activeTab === 'auto');
			manualTab.classList.toggle('is-active', this.activeTab === 'manual');

			if (this.activeTab === 'auto') {
				new Setting(tabContent)
					.setName('Web URL')
					.setDesc('Paste a link from Spotify, YouTube, or Google Drive (e.g., share links).')
					.addText((text) =>
						text
							.setPlaceholder('https://open.spotify.com/track/...')
							.setValue(this.urlInput)
							.onChange((val) => {
								this.urlInput = val;
							}),
					);

				const btnSetting = new Setting(tabContent).addButton((btn) =>
					btn
						.setButtonText('Add to Canvas')
						.setCta()
						.onClick(() => {
							this.handleAddUrl();
						}),
				);
			} else {
				tabContent.createEl('label', { text: 'Iframe Embed Code:', cls: 'muse-tm-label' });
				const txt = tabContent.createEl('textarea', {
					cls: 'muse-tm-textarea',
					attr: { placeholder: '<iframe ...></iframe>' },
				});
				txt.value = this.manualCode;
				txt.addEventListener('input', () => {
					this.manualCode = txt.value;
				});

				new Setting(tabContent).addButton((btn) =>
					btn
						.setButtonText('Add to Canvas')
						.setCta()
						.onClick(() => {
							this.handleAddManual();
						}),
				);
			}
		};

		autoTab.addEventListener('click', () => {
			this.activeTab = 'auto';
			renderContent();
		});

		manualTab.addEventListener('click', () => {
			this.activeTab = 'manual';
			renderContent();
		});

		renderContent();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private handleAddUrl(): void {
		const rawUrl = this.urlInput.trim();
		if (!rawUrl) {
			new Notice('Please paste a URL first.');
			return;
		}

		const embedHtml = this.parseUrlToEmbed(rawUrl);
		if (!embedHtml) {
			new Notice('Unsupported URL format. Try using "Pasted Iframe Code" instead.');
			return;
		}

		this.insertEmbedOnCanvas(embedHtml);
		this.close();
	}

	private handleAddManual(): void {
		const code = this.manualCode.trim();
		if (!code) {
			new Notice('Please paste iframe embed code first.');
			return;
		}

		if (!code.includes('<iframe')) {
			new Notice('Pasted code does not seem to contain an <iframe> element.');
			return;
		}

		this.insertEmbedOnCanvas(code);
		this.close();
	}

	private parseUrlToEmbed(url: string): string | null {
		// 1. Spotify
		// e.g. https://open.spotify.com/track/00FMfKay6lHHQpFLTSaCZe?si=da13c2bdb34b4f71
		// e.g. https://open.spotify.com/playlist/5epj2r7jLSu8th6ViOKW4M?si=6154a833118b4aed
		// e.g. https://open.spotify.com/album/321...
		if (url.includes('open.spotify.com')) {
			const cleanUrl = url.split('?')[0] || ''; // Strip tracking params
			const parts = cleanUrl.split('/');
			const typeIdx = parts.findIndex((p) => p === 'track' || p === 'playlist' || p === 'album');
			if (typeIdx !== -1 && parts[typeIdx + 1]) {
				const type = parts[typeIdx];
				const id = parts[typeIdx + 1];
				const embedUrl = `https://open.spotify.com/embed/${type}/${id}?utm_source=generator`;
				return `<iframe src="${embedUrl}" width="100%" height="352" frameBorder="0" allowfullscreen="" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
			}
		}

		// 2. YouTube
		// e.g. https://www.youtube.com/watch?v=hb0XLX0b4Y4
		// e.g. https://youtu.be/hb0XLX0b4Y4
		// e.g. https://www.youtube.com/playlist?list=PL9Z0stL3aRykpU8abEkuDZAN-kgYy5hKj
		if (url.includes('youtube.com') || url.includes('youtu.be')) {
			let videoId: string | null = null;
			let playlistId: string | null = null;

			try {
				const parsed = new URL(url);
				if (parsed.hostname.includes('youtu.be')) {
					videoId = parsed.pathname.substring(1);
				} else {
					videoId = parsed.searchParams.get('v');
					playlistId = parsed.searchParams.get('list');
				}

				if (playlistId) {
					// Playlist embed
					return `<iframe width="100%" height="315" src="https://www.youtube.com/embed/videoseries?list=${playlistId}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
				} else if (videoId) {
					// Video embed
					return `<iframe width="100%" height="315" src="https://www.youtube.com/embed/${videoId}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
				}
			} catch (e) {
				// Fall through
			}
		}

		// 3. Google Drive
		// e.g. https://drive.google.com/file/d/FILE_ID/view?usp=sharing
		// e.g. https://drive.google.com/open?id=FILE_ID
		if (url.includes('drive.google.com')) {
			let fileId: string | null = null;
			if (url.includes('/file/d/')) {
				const parts = url.split('/file/d/');
				const secondPart = parts[1];
				if (secondPart) {
					fileId = secondPart.split('/')[0] || null;
				}
			} else if (url.includes('id=')) {
				try {
					const parsed = new URL(url);
					fileId = parsed.searchParams.get('id');
				} catch (e) {}
			}

			if (fileId) {
				return `<iframe src="https://drive.google.com/file/d/${fileId}/preview" width="100%" height="350" frameborder="0" allow="autoplay"></iframe>`;
			}
		}

		// 4. SoundCloud
		// If they paste a SoundCloud link directly, we can't easily resolve the track ID purely client-side without API,
		// but if we match a SoundCloud share URL, we can output a Notice suggesting iframe code,
		// or generate a standard player embed using a resolve URL (SoundCloud oEmbed player supports this!):
		// e.g. https://w.soundcloud.com/player/?url=ENCODED_URL
		if (url.includes('soundcloud.com')) {
			const encoded = encodeURIComponent(url);
			return `<iframe width="100%" height="166" scrolling="no" frameborder="no" allow="autoplay; encrypted-media" src="https://w.soundcloud.com/player/?url=${encoded}&color=%23ff5500&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true"></iframe>`;
		}

		return null;
	}

	private extractSrcFromIframe(html: string): string | null {
		try {
			const parser = new DOMParser();
			const doc = parser.parseFromString(html, 'text/html');
			const iframe = doc.querySelector('iframe');
			if (iframe) {
				const src = iframe.getAttribute('src');
				if (src) return src;
			}
		} catch (e) {}

		const match = html.match(/<iframe[^>]*\bsrc=["']([^"']+)["']/i);
		return (match && match[1]) ? match[1] : null;
	}

	private insertEmbedOnCanvas(embedHtml: string): void {
		const active = getActiveCanvas(this.app);
		if (!active) {
			new Notice('Please open a canvas tab first.');
			return;
		}

		const viewport = active.canvas.viewportBounds?.() ?? { x: 0, y: 0, width: 400, height: 300 };
		const pos = {
			x: viewport.x + viewport.width / 2 - 200,
			y: viewport.y + viewport.height / 2 - 150,
		};

		// Cast UndocumentedCanvas to any to invoke createLinkNode/createTextNode safely
		const canvas = active.canvas as any;
		const srcUrl = this.extractSrcFromIframe(embedHtml);

		if (srcUrl && typeof canvas.createLinkNode === 'function') {
			canvas.createLinkNode({
				url: srcUrl,
				pos,
				size: { width: 400, height: 350 },
				save: true,
				focus: true,
			});
			canvas.requestSave?.();
			new Notice('Web embed card added to canvas!');
		} else if (typeof canvas.createTextNode === 'function') {
			canvas.createTextNode({
				pos,
				size: { width: 400, height: 350 },
				text: embedHtml,
				focus: true,
			});
			canvas.requestSave?.();
			new Notice('Web embed card added to canvas!');
		} else {
			new Notice('Could not insert node: Canvas API is not supported on this version of Obsidian Canvas.');
		}
	}
}
