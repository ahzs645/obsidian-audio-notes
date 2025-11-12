import { App, Modal } from "obsidian";

export interface ConfirmModalOptions {
	title?: string;
	message: string;
	confirmText?: string;
	cancelText?: string;
}

export function confirmWithModal(
	app: App,
	options: ConfirmModalOptions
): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new ConfirmModal(app, options, resolve);
		modal.open();
	});
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly options: ConfirmModalOptions,
		private readonly resolve: (value: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const { title, message, confirmText, cancelText } = this.options;
		contentEl.empty();
		if (title) {
			contentEl.createEl("h2", { text: title });
		}
		contentEl.createEl("p", { text: message });

		const buttons = contentEl.createDiv("modal-button-container");
		const cancelButton = buttons.createEl("button", {
			text: cancelText ?? "Cancel",
		});
		cancelButton.addEventListener("click", () => this.closeWith(false));

		const confirmButton = buttons.createEl("button", {
			text: confirmText ?? "Confirm",
			cls: "mod-warning",
		});
		confirmButton.addEventListener("click", () => this.closeWith(true));
		confirmButton.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private closeWith(result: boolean) {
		this.close();
		this.resolve(result);
	}
}
