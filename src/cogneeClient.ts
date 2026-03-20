/**
 * Thin HTTP client for the local Cognee FastAPI server.
 */

export interface SearchResult {
	text?: string;
	[key: string]: unknown;
}

export interface IngestResult {
	added: number;
	total: number;
	errors: Array<{ file: string; error: string }>;
}

export class CogneeClient {
	constructor(
		private baseUrl: string,
		private getHeaders: () => Record<string, string>
	) {}

	private async request<T>(
		path: string,
		method: "GET" | "POST" | "DELETE" = "GET",
		body?: unknown
	): Promise<T> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: { 
				"Content-Type": "application/json",
				...this.getHeaders()
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`Cognee server error ${res.status}: ${err}`);
		}

		return res.json() as Promise<T>;
	}

	async status(): Promise<{ status: string; model: string; provider: string }> {
		return this.request("/status");
	}

	async add(text: string, noteTitle?: string): Promise<{ success: boolean }> {
		return this.request("/add", "POST", {
			text,
			note_title: noteTitle,
		});
	}

	async cognify(): Promise<{ success: boolean }> {
		return this.request("/cognify", "POST", {});
	}

	async search(query: string, limit = 10): Promise<SearchResult[]> {
		const data = await this.request<{ results: SearchResult[] }>("/search", "POST", {
			query,
			limit,
		});
		return data.results;
	}

	async ingestVault(vaultPath?: string): Promise<IngestResult> {
		return this.request("/ingest-vault", "POST", vaultPath ? { vault_path: vaultPath } : {});
	}

	async prune(): Promise<{ success: boolean }> {
		return this.request("/prune", "DELETE");
	}
}
