import { ItemView, WorkspaceLeaf, Notice, FileSystemAdapter } from "obsidian";
import type { CogneeClient, SearchResult } from "../cogneeClient";

export const SECOND_BRAIN_VIEW_TYPE = "cognee-second-brain";

export class SecondBrainView extends ItemView {
	private client: CogneeClient;

	// DOM refs
	private queryInput!: HTMLInputElement;
	private resultsContainer!: HTMLDivElement;
	private statusBadge!: HTMLSpanElement;

	constructor(leaf: WorkspaceLeaf, client: CogneeClient) {
		super(leaf);
		this.client = client;
	}

	getViewType(): string {
		return SECOND_BRAIN_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Second Brain";
	}

	getIcon(): string {
		return "brain";
	}

	async onOpen(): Promise<void> {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("cognee-view");

		// ── Header ──────────────────────────────────────────────────────────
		const header = root.createDiv({ cls: "cognee-header" });
		header.createEl("h2", { text: "Second Brain" });
		this.statusBadge = header.createSpan({
			cls: "cognee-badge cognee-badge--unknown",
			text: "…",
		});

		// ── Query area ───────────────────────────────────────────────────────
		const querySection = root.createDiv({ cls: "cognee-section" });
		querySection.createEl("label", {
			text: "Ask your Second Brain",
			cls: "cognee-label",
		});

		const queryRow = querySection.createDiv({ cls: "cognee-row" });
		this.queryInput = queryRow.createEl("input", {
			type: "text",
			placeholder: "What are the key ideas in my notes?",
			cls: "cognee-input",
			attr: { id: "cognee-query-input" },
		});
		this.queryInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") void this.doSearch();
		});

		const searchBtn = queryRow.createEl("button", {
			text: "Search",
			cls: "cognee-btn cognee-btn--primary",
		});
		searchBtn.id = "cognee-search-btn";
		searchBtn.addEventListener("click", () => void this.doSearch());

		// ── Results ──────────────────────────────────────────────────────────
		this.resultsContainer = root.createDiv({ cls: "cognee-results" });

		// ── Actions ──────────────────────────────────────────────────────────
		const actionsSection = root.createDiv({ cls: "cognee-actions" });

		const ingestBtn = actionsSection.createEl("button", {
			text: "Ingest entire vault",
			cls: "cognee-btn cognee-btn--secondary",
			attr: { id: "cognee-ingest-vault-btn" },
		});
		ingestBtn.addEventListener("click", () => void this.doIngestVault());

		const pruneBtn = actionsSection.createEl("button", {
			text: "Prune database",
			cls: "cognee-btn cognee-btn--danger",
			attr: { id: "cognee-prune-btn" },
		});
		pruneBtn.style.cssText =
			"color: var(--text-error); border-color: var(--background-modifier-error);";
		pruneBtn.addEventListener("click", () => void this.doPrune());

		// Check server on open
		void this.checkStatus();
	}

	async onClose(): Promise<void> {
		// nothing to clean up
	}

	// ── Private helpers ─────────────────────────────────────────────────────

	private async checkStatus() {
		try {
			const s = await this.client.status();
			this.statusBadge.textContent = s.status === "ok" ? "Online" : "Unknown";
			this.statusBadge.className =
				s.status === "ok"
					? "cognee-badge cognee-badge--ok"
					: "cognee-badge cognee-badge--error";
		} catch {
			this.statusBadge.textContent = "Offline";
			this.statusBadge.className = "cognee-badge cognee-badge--error";
		}
	}

	private async doSearch() {
		const query = this.queryInput.value.trim();
		if (!query) return;

		this.resultsContainer.empty();
		const loading = this.resultsContainer.createDiv({
			cls: "cognee-loading",
			text: "Searching…",
		});

		try {
			const results = await this.client.search(query);
			loading.remove();
			if (!results || results.length === 0) {
				this.resultsContainer.createDiv({
					cls: "cognee-empty",
					text: "No results found.",
				});
				return;
			}
			this.renderResults(results);
		} catch (err) {
			loading.remove();
			this.resultsContainer.createDiv({
				cls: "cognee-error",
				text: `Error: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	private renderResults(results: SearchResult[]) {
		for (const r of results) {
			const card = this.resultsContainer.createDiv({
				cls: "cognee-result-card",
			});

			const text = r.text ?? r.chunk_text ?? r.content ?? JSON.stringify(r);
			card.createEl("p", { text: String(text), cls: "cognee-result-text" });

			// Show score / metadata if available
			if (r.score !== undefined || r.node_id !== undefined) {
				const meta = card.createDiv({ cls: "cognee-result-meta" });
				if (r.score !== undefined) {
					meta.createSpan({
						text: `Score: ${Number(r.score).toFixed(3)}`,
						cls: "cognee-meta-score",
					});
				}
				if (r.node_id !== undefined) {
					meta.createSpan({
						text: ` · ID: ${String(r.node_id)}`,
						cls: "cognee-meta-id",
					});
				}
			}
		}
	}

	private async doIngestVault() {
		new Notice("Ingesting vault… this may take several minutes.");
		try {
			// Provide the vault's absolute filesystem path to the local server
			let vaultPath: string | undefined;
			if (this.app.vault.adapter instanceof FileSystemAdapter) {
				vaultPath = this.app.vault.adapter.getBasePath();
			}

			const result = await this.client.ingestVault(vaultPath);
			new Notice(`Vault ingested: ${result.added} notes added and cognified.`);
		} catch (err) {
			new Notice(
				`Vault ingest failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private async doPrune() {
		new Notice("Pruning the graph database...");
		try {
			await this.client.prune();
			new Notice("Database pruned successfully! You can now ingest freshly.");
		} catch (err) {
			new Notice(
				`Prune failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
