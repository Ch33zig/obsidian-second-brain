import { Plugin } from "obsidian";
import { type CogneePluginSettings, DEFAULT_SETTINGS, CogneeSettingTab } from "./settings";
import { CogneeClient } from "./cogneeClient";
import { SecondBrainView, SECOND_BRAIN_VIEW_TYPE } from "./ui/SecondBrainView";
import { GraphView, GRAPH_VIEW_TYPE } from "./ui/GraphView";

export default class CogneePlugin extends Plugin {
	settings!: CogneePluginSettings;
	client!: CogneeClient;

	async onload() {
		await this.loadSettings();

		this.client = new CogneeClient(this.settings.serverUrl, () => ({
			"x-api-key": this.settings.apiKey,
			"x-llm-provider": this.settings.llmProvider,
			"x-llm-model": this.settings.llmModel,
		}));

		// Register the side-panel view
		this.registerView(SECOND_BRAIN_VIEW_TYPE, (leaf) => {
			return new SecondBrainView(leaf, this.client);
		});

		// Register the graph visualisation view
		this.registerView(GRAPH_VIEW_TYPE, (leaf) => new GraphView(leaf, this));

		// Ribbon icon – opens the second brain panel
		this.addRibbonIcon("brain", "Open Second Brain", () => {
			void this.activateView();
		});

		// Graph ribbon icon
		this.addRibbonIcon("git-fork", "Open Knowledge Graph", () => {
			void this.activateGraphView();
		});

		// ── Commands ─────────────────────────────────────────────────────────

		this.addCommand({
			id: "cognee-open-panel",
			name: "Open Second Brain panel",
			callback: () => void this.activateView(),
		});



		this.addCommand({
			id: "cognee-search",
			name: "Search Second Brain…",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "cognee-open-graph",
			name: "Open Knowledge Graph visualisation",
			callback: () => void this.activateGraphView(),
		});

		// ── Auto-ingest on save ───────────────────────────────────────────────

		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (!this.settings.autoIngestOnSave) return;
				if (!file.name.endsWith(".md")) return;
				const content = await this.app.vault.read(file as Parameters<typeof this.app.vault.read>[0]);
				try {
					await this.client.add(content, file.name.replace(/\.md$/, ""));
				} catch {
					// silent – background ingest shouldn't spam notices
				}
			})
		);

		// ── Settings tab ─────────────────────────────────────────────────────

		this.addSettingTab(new CogneeSettingTab(this.app, this));
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(SECOND_BRAIN_VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(GRAPH_VIEW_TYPE);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<CogneePluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Re-create client if URL changed
		this.client = new CogneeClient(this.settings.serverUrl, () => ({
			"x-api-key": this.settings.apiKey,
			"x-llm-provider": this.settings.llmProvider,
			"x-llm-model": this.settings.llmModel,
		}));
	}

	private async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(SECOND_BRAIN_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
			await leaf.setViewState({ type: SECOND_BRAIN_VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	private async activateGraphView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(GRAPH_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: GRAPH_VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}
}
