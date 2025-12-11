import { App, Modal, Notice, Setting } from "obsidian";
import type AutomaticAudioNotes from "../main";
import {
	ExportService,
	DEFAULT_METADATA_OPTIONS,
	type ExportFormat,
	type ExportStructure,
	type ExportContent,
	type ExportOptions,
	type ExportResult,
	type MetadataOptions,
} from "../services/ExportService";

type CategoryFilterMode = "all" | "category" | "subcategory";

export class ExportModal extends Modal {
	private exportService: ExportService;
	private plugin: AutomaticAudioNotes;

	// Form state
	private format: ExportFormat = "markdown";
	private structure: ExportStructure = "single";
	private content: ExportContent = "both";
	private categoryFilterMode: CategoryFilterMode = "all";
	private selectedCategory: string = "";
	private selectedSubcategory: string = "";
	private startDate: string = "";
	private endDate: string = "";
	private metadata: MetadataOptions = { ...DEFAULT_METADATA_OPTIONS };

	// UI elements
	private previewEl: HTMLElement | null = null;
	private exportButton: HTMLButtonElement | null = null;
	private meetingCount: number = 0;
	private subcategoryDropdownContainer: HTMLElement | null = null;
	private categoryDropdownContainer: HTMLElement | null = null;

	constructor(app: App, plugin: AutomaticAudioNotes) {
		super(app);
		this.plugin = plugin;
		this.exportService = new ExportService(app, plugin);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("aan-export-modal");

		contentEl.createEl("h2", { text: "Export Audio Notes" });
		contentEl.createEl("p", {
			text: "Export your meeting notes and transcripts for use with NotebookLM or other tools.",
			cls: "aan-export-description",
		});

		this.createContentSection(contentEl);
		this.createMetadataSection(contentEl);
		this.createFilterSection(contentEl);
		this.createFormatSection(contentEl);
		this.createPreviewSection(contentEl);
		this.createActionButtons(contentEl);

		// Initial preview
		void this.updatePreview();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private createContentSection(containerEl: HTMLElement): void {
		const section = containerEl.createDiv({ cls: "aan-export-section" });
		section.createEl("h3", { text: "What to Export" });

		new Setting(section)
			.setName("Content type")
			.setDesc("Choose what content to include in the export")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("both", "Notes & Transcripts")
					.addOption("notes", "Notes only")
					.addOption("transcripts", "Transcripts only")
					.setValue(this.content)
					.onChange((value) => {
						this.content = value as ExportContent;
						void this.updatePreview();
					});
			});
	}

	private createMetadataSection(containerEl: HTMLElement): void {
		const section = containerEl.createDiv({ cls: "aan-export-section" });
		section.createEl("h3", { text: "Metadata to Include" });

		new Setting(section)
			.setName("Title")
			.setDesc("Include meeting title as header")
			.addToggle((toggle) => {
				toggle.setValue(this.metadata.includeTitle).onChange((value) => {
					this.metadata.includeTitle = value;
				});
			});

		new Setting(section)
			.setName("Date")
			.setDesc("Include meeting date")
			.addToggle((toggle) => {
				toggle.setValue(this.metadata.includeDate).onChange((value) => {
					this.metadata.includeDate = value;
				});
			});

		new Setting(section)
			.setName("Category")
			.setDesc("Include category/label information")
			.addToggle((toggle) => {
				toggle.setValue(this.metadata.includeCategory).onChange((value) => {
					this.metadata.includeCategory = value;
				});
			});

		new Setting(section)
			.setName("Tags")
			.setDesc("Include all tags")
			.addToggle((toggle) => {
				toggle.setValue(this.metadata.includeTags).onChange((value) => {
					this.metadata.includeTags = value;
				});
			});

		new Setting(section)
			.setName("File path")
			.setDesc("Include source file path from vault")
			.addToggle((toggle) => {
				toggle.setValue(this.metadata.includeFilePath).onChange((value) => {
					this.metadata.includeFilePath = value;
				});
			});
	}

	private createFilterSection(containerEl: HTMLElement): void {
		const section = containerEl.createDiv({ cls: "aan-export-section" });
		section.createEl("h3", { text: "Filter Meetings" });

		// Category filter mode
		new Setting(section)
			.setName("Filter by")
			.setDesc("Choose how to filter meetings")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("all", "All meetings")
					.addOption("category", "By category (e.g., Job, Education)")
					.addOption("subcategory", "By specific label (e.g., job/client-meeting)")
					.setValue(this.categoryFilterMode)
					.onChange((value) => {
						this.categoryFilterMode = value as CategoryFilterMode;
						this.updateFilterDropdowns();
						void this.updatePreview();
					});
			});

		// Category dropdown container
		this.categoryDropdownContainer = section.createDiv({ cls: "aan-export-filter-dropdown" });

		// Subcategory dropdown container
		this.subcategoryDropdownContainer = section.createDiv({ cls: "aan-export-filter-dropdown" });

		// Initialize filter dropdowns
		this.updateFilterDropdowns();

		// Date range
		new Setting(section)
			.setName("Start date")
			.setDesc("Only include meetings from this date onward (optional)")
			.addText((input) => {
				input.inputEl.type = "date";
				input.setValue(this.startDate).onChange((value) => {
					this.startDate = value;
					void this.updatePreview();
				});
			});

		new Setting(section)
			.setName("End date")
			.setDesc("Only include meetings up to this date (optional)")
			.addText((input) => {
				input.inputEl.type = "date";
				input.setValue(this.endDate).onChange((value) => {
					this.endDate = value;
					void this.updatePreview();
				});
			});
	}

	private updateFilterDropdowns(): void {
		// Clear containers
		if (this.categoryDropdownContainer) {
			this.categoryDropdownContainer.empty();
		}
		if (this.subcategoryDropdownContainer) {
			this.subcategoryDropdownContainer.empty();
		}

		if (this.categoryFilterMode === "category" && this.categoryDropdownContainer) {
			const categories = this.exportService.getAvailableCategories();
			new Setting(this.categoryDropdownContainer)
				.setName("Category")
				.setDesc("Select a category to filter by")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "Select category...");
					dropdown.addOption("uncategorized", "Uncategorized");
					for (const category of categories) {
						if (category.id !== "all" && category.id !== "uncategorized") {
							const icon = (this.plugin.settings.meetingLabelCategories || [])
								.find(c => c.id === category.id)?.icon || "";
							const displayName = icon ? `${icon} ${category.name}` : category.name;
							dropdown.addOption(category.tagPrefix, displayName);
						}
					}
					dropdown.setValue(this.selectedCategory).onChange((value) => {
						this.selectedCategory = value;
						void this.updatePreview();
					});
				});
		}

		if (this.categoryFilterMode === "subcategory" && this.subcategoryDropdownContainer) {
			const subcategories = this.exportService.getAvailableSubcategories();

			if (subcategories.length === 0) {
				this.subcategoryDropdownContainer.createEl("p", {
					text: "No subcategories found. Create meetings with labels to see them here.",
					cls: "aan-export-no-subcategories",
				});
			} else {
				new Setting(this.subcategoryDropdownContainer)
					.setName("Specific label")
					.setDesc("Select a specific label to filter by")
					.addDropdown((dropdown) => {
						dropdown.addOption("", "Select label...");

						// Group by category
						let currentCategory = "";
						for (const sub of subcategories) {
							const categoryLabel = sub.category || "Other";
							if (categoryLabel !== currentCategory) {
								currentCategory = categoryLabel;
								// Add optgroup-like separator (using em-dash prefix)
								dropdown.addOption(`__category_${categoryLabel}`, `── ${categoryLabel} ──`);
							}
							dropdown.addOption(sub.tag, `${sub.displayName} (${sub.count})`);
						}

						dropdown.setValue(this.selectedSubcategory).onChange((value) => {
							// Ignore category separator selections
							if (value.startsWith("__category_")) {
								dropdown.setValue(this.selectedSubcategory);
								return;
							}
							this.selectedSubcategory = value;
							void this.updatePreview();
						});
					});
			}
		}
	}

	private createFormatSection(containerEl: HTMLElement): void {
		const section = containerEl.createDiv({ cls: "aan-export-section" });
		section.createEl("h3", { text: "Export Format" });

		new Setting(section)
			.setName("File format")
			.setDesc("Choose the output file format")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("markdown", "Markdown (.md)")
					.addOption("text", "Plain Text (.txt)")
					.addOption("json", "JSON (.json)")
					.setValue(this.format)
					.onChange((value) => {
						this.format = value as ExportFormat;
					});
			});

		new Setting(section)
			.setName("File structure")
			.setDesc("Export as a single combined file or one file per meeting")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("single", "Single combined file")
					.addOption("multiple", "One file per meeting")
					.setValue(this.structure)
					.onChange((value) => {
						this.structure = value as ExportStructure;
					});
			});
	}

	private createPreviewSection(containerEl: HTMLElement): void {
		const section = containerEl.createDiv({ cls: "aan-export-section" });
		section.createEl("h3", { text: "Preview" });

		this.previewEl = section.createDiv({ cls: "aan-export-preview" });
		this.previewEl.setText("Loading preview...");
	}

	private createActionButtons(containerEl: HTMLElement): void {
		const buttonContainer = containerEl.createDiv({ cls: "aan-export-buttons" });

		new Setting(buttonContainer)
			.addButton((btn) => {
				this.exportButton = btn.buttonEl;
				btn
					.setButtonText("Export")
					.setCta()
					.onClick(() => void this.performExport());
			})
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	private async updatePreview(): Promise<void> {
		if (!this.previewEl) return;

		this.previewEl.setText("Counting meetings...");

		try {
			const options = this.buildExportOptions();
			const meetings = await this.exportService.collectMeetingsForExport(options);
			this.meetingCount = meetings.length;

			if (this.meetingCount === 0) {
				this.previewEl.empty();
				this.previewEl.createEl("p", {
					text: "No meetings match your filters.",
					cls: "aan-export-preview-empty",
				});
				if (this.exportButton) {
					this.exportButton.disabled = true;
				}
				return;
			}

			this.previewEl.empty();

			const summaryEl = this.previewEl.createEl("p", {
				cls: "aan-export-preview-summary",
			});
			summaryEl.setText(`Found ${this.meetingCount} meeting${this.meetingCount !== 1 ? "s" : ""} to export.`);

			// Show sample of meeting titles
			const listEl = this.previewEl.createEl("ul", {
				cls: "aan-export-preview-list",
			});
			const maxToShow = 5;
			for (let i = 0; i < Math.min(meetings.length, maxToShow); i++) {
				const meeting = meetings[i];
				const li = listEl.createEl("li");
				li.createEl("span", {
					text: meeting.event.title,
					cls: "aan-export-preview-title",
				});
				li.createEl("span", {
					text: ` (${meeting.event.displayDate})`,
					cls: "aan-export-preview-date",
				});

				// Show label if present
				if (meeting.event.label) {
					li.createEl("span", {
						text: ` [${meeting.event.label.displayName}]`,
						cls: "aan-export-preview-label",
					});
				}

				// Indicate if transcript is available
				if (meeting.transcript) {
					li.createEl("span", {
						text: " [transcript]",
						cls: "aan-export-preview-badge",
					});
				}
			}

			if (meetings.length > maxToShow) {
				listEl.createEl("li", {
					text: `... and ${meetings.length - maxToShow} more`,
					cls: "aan-export-preview-more",
				});
			}

			if (this.exportButton) {
				this.exportButton.disabled = false;
			}
		} catch (error) {
			this.previewEl.setText("Error loading preview: " + (error as Error).message);
		}
	}

	private getCategoryFilter(): string | null {
		switch (this.categoryFilterMode) {
			case "all":
				return null;
			case "category":
				return this.selectedCategory || null;
			case "subcategory":
				return this.selectedSubcategory || null;
			default:
				return null;
		}
	}

	private buildExportOptions(): ExportOptions {
		return {
			format: this.format,
			structure: this.structure,
			content: this.content,
			categoryFilter: this.getCategoryFilter(),
			dateRange: {
				start: this.startDate ? new Date(this.startDate) : null,
				end: this.endDate ? new Date(this.endDate) : null,
			},
			metadata: { ...this.metadata },
		};
	}

	private async performExport(): Promise<void> {
		const options = this.buildExportOptions();

		try {
			new Notice("Preparing export...");

			const meetings = await this.exportService.collectMeetingsForExport(options);

			if (meetings.length === 0) {
				new Notice("No meetings to export.");
				return;
			}

			const results = await this.exportService.exportMeetings(meetings, options);

			if (options.structure === "single") {
				// Single file - download directly
				await this.downloadFile(results[0]);
				new Notice(`Exported ${meetings.length} meeting${meetings.length !== 1 ? "s" : ""} to ${results[0].filename}`);
			} else {
				// Multiple files - create a zip or download folder
				await this.downloadMultipleFiles(results);
				new Notice(`Exported ${results.length} file${results.length !== 1 ? "s" : ""}`);
			}

			this.close();
		} catch (error) {
			console.error("Export error:", error);
			new Notice("Export failed: " + (error as Error).message);
		}
	}

	private async downloadFile(result: ExportResult): Promise<void> {
		const blob = new Blob([result.content], { type: this.getMimeType(result.filename) });
		const url = URL.createObjectURL(blob);

		const a = document.createElement("a");
		a.href = url;
		a.download = result.filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	private async downloadMultipleFiles(results: ExportResult[]): Promise<void> {
		// For multiple files, we'll create them in a folder within the vault
		// or download them one by one (depending on browser support)

		// Option 1: Save to vault
		const exportFolder = "Audio Notes Export";

		try {
			// Ensure export folder exists
			const folderExists = this.app.vault.getAbstractFileByPath(exportFolder);
			if (!folderExists) {
				await this.app.vault.createFolder(exportFolder);
			}

			for (const result of results) {
				const filePath = `${exportFolder}/${result.filename}`;
				const existingFile = this.app.vault.getAbstractFileByPath(filePath);
				if (existingFile) {
					await this.app.vault.delete(existingFile);
				}
				await this.app.vault.create(filePath, result.content);
			}

			new Notice(`Files saved to "${exportFolder}" folder in your vault.`);
		} catch (error) {
			// Fallback: download files one by one
			console.warn("Could not save to vault, downloading files instead:", error);

			for (const result of results) {
				await this.downloadFile(result);
				// Small delay between downloads to avoid browser blocking
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}
	}

	private getMimeType(filename: string): string {
		if (filename.endsWith(".json")) {
			return "application/json";
		} else if (filename.endsWith(".md")) {
			return "text/markdown";
		} else {
			return "text/plain";
		}
	}
}
