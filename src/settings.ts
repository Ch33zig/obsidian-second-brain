import { type App, PluginSettingTab, Setting } from "obsidian";
import type CogneePlugin from "./main";

export interface CogneePluginSettings {
	serverUrl: string;
	llmProvider: string;
	llmModel: string;
	apiKey: string;
	autoIngestOnSave: boolean;
}

export const DEFAULT_SETTINGS: CogneePluginSettings = {
	serverUrl: "http://127.0.0.1:8765",
	llmProvider: "openai",
	llmModel: "",
	apiKey: "",
	autoIngestOnSave: false,
};

export class CogneeSettingTab extends PluginSettingTab {
	plugin: CogneePlugin;

	constructor(app: App, plugin: CogneePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "Second Brain" });
		containerEl.createEl("p", {
			text: "Connect your vault to a Cognee knowledge graph.",
			cls: "cognee-settings-desc",
		});

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("URL of the Cognee server.")
			.addText((text) =>
				text
					.setPlaceholder("http://127.0.0.1:8765")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.replace(/\/$/, "");
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("LLM Provider")
			.setDesc("Select the LLM provider for the knowledge graph.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("openai", "OpenAI")
					.addOption("anthropic", "Anthropic")
					.addOption("chutes", "Chutes")
					.setValue(this.plugin.settings.llmProvider)
					.onChange(async (value) => {
						this.plugin.settings.llmProvider = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Model Name")
			.setDesc("The specific model to use.")
			.addText((text) =>
				text
					.setPlaceholder("Enter model name...")
					.setValue(this.plugin.settings.llmModel)
					.onChange(async (value) => {
						this.plugin.settings.llmModel = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("API key for your chosen LLM provider.")
			.addText((text) => {
				text
					.setPlaceholder("Enter API key…")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Auto-ingest on save")
			.setDesc(
				"Automatically add the active note to the knowledge graph when you save it.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoIngestOnSave)
					.onChange(async (value) => {
						this.plugin.settings.autoIngestOnSave = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
