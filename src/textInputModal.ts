import { App, Modal, Setting } from 'obsidian';

/**
 * A minimal single-line text input modal, used in place of window.prompt()
 * (which Obsidian's plugin guidelines disallow — it blocks the whole app and
 * looks out of place next to Obsidian's own modal styling).
 */
export class TextInputModal extends Modal {
	private value: string;
	private onSubmit: (value: string) => void;
	private titleText: string;
	private placeholder: string;

	constructor(
		app: App,
		options: { title: string; placeholder?: string; initialValue?: string },
		onSubmit: (value: string) => void,
	) {
		super(app);
		this.titleText = options.title;
		this.placeholder = options.placeholder ?? '';
		this.value = options.initialValue ?? '';
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.titleText });

		let inputEl: HTMLInputElement;
		new Setting(contentEl).addText((text) => {
			inputEl = text.inputEl;
			text.setPlaceholder(this.placeholder).setValue(this.value);
			text.onChange((v) => (this.value = v));
			text.inputEl.addEventListener('keydown', (evt) => {
				if (evt.key === 'Enter') {
					evt.preventDefault();
					this.submit();
				}
			});
		});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText('Save')
				.setCta()
				.onClick(() => this.submit()),
		);

		window.setTimeout(() => inputEl?.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		const trimmed = this.value.trim();
		if (trimmed) {
			this.onSubmit(trimmed);
		}
		this.close();
	}
}
