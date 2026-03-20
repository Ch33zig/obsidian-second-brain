import { ItemView, WorkspaceLeaf } from "obsidian";
import type CogneePlugin from "../main";

export const GRAPH_VIEW_TYPE = "cognee-graph-view";

interface GraphNode {
	id: string;
	label: string;
	type: string;
	description: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	mass?: number;
	frozen?: boolean;
	clusterId?: number;
}

interface GraphEdge {
	source: string;
	target: string;
	label: string;
	dist?: number;
}

export class GraphView extends ItemView {
	plugin: CogneePlugin;
	private canvas: HTMLCanvasElement | null = null;
	private nodes: GraphNode[] = [];
	private edges: GraphEdge[] = [];
	private transform = { x: 0, y: 0, scale: 0.1 };
	private isDragging = false;
	private dragStart = { x: 0, y: 0 }; // last mouse pos during pan (offsetX/Y)
	private dragNode: GraphNode | null = null;
	private dragNodeOffset = { x: 0, y: 0 }; // cursor offset from node centre in world space
	private hoveredNode: GraphNode | null = null;
	private activeComponent = new Set<string>();
	private animFrame: number | null = null;
	private simRunning = false;
	private alpha = 1.0;

	constructor(leaf: WorkspaceLeaf, plugin: CogneePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return GRAPH_VIEW_TYPE;
	}
	getDisplayText() {
		return "Second Brain Graph";
	}
	getIcon() {
		return "git-fork";
	}

	async onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass("cognee-graph-container");
		this.contentEl.style.cssText =
			"display:flex;flex-direction:column;height:100%;overflow:hidden;";

		// Toolbar
		const toolbar = this.contentEl.createDiv({ cls: "cognee-graph-toolbar" });
		toolbar.style.cssText =
			"display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--background-secondary);border-bottom:1px solid var(--background-modifier-border);flex-shrink:0;";

		const title = toolbar.createEl("span", { text: "Knowledge Graph" });
		title.style.cssText =
			"font-weight:600;font-size:13px;color:var(--text-normal);flex:1;";

		const refreshBtn = toolbar.createEl("button", { text: "↻ Refresh" });
		refreshBtn.id = "cognee-graph-refresh";
		refreshBtn.onclick = () => this.loadGraph();

		const resetBtn = toolbar.createEl("button", { text: "⊙ Reset view" });
		resetBtn.onclick = () => {
			this.centerView();
		};

		const statsEl = toolbar.createEl("span");
		statsEl.id = "cognee-graph-stats";
		statsEl.style.cssText =
			"font-size:11px;color:var(--text-muted);margin-left:4px;";

		// Canvas
		const canvasWrap = this.contentEl.createDiv();
		canvasWrap.style.cssText =
			"flex:1;position:relative;overflow:hidden;background:var(--background-primary);";

		this.canvas = canvasWrap.createEl("canvas");
		this.canvas.style.cssText = "position:absolute;inset:0;cursor:grab;";

		// Tooltip
		const tooltip = canvasWrap.createDiv();
		tooltip.id = "cognee-graph-tooltip";
		tooltip.style.cssText =
			"position:absolute;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--text-normal);pointer-events:none;opacity:0;transition:opacity 0.15s;max-width:240px;z-index:10;";

		this.setupCanvas(tooltip);
		this.loadGraph();
	}

	private centerView() {
		if (!this.canvas) return;
		const w = this.canvas.width || 800;
		const h = this.canvas.height || 600;
		const scale = 0.1;
		this.transform = {
			x: w / 2 - (w / 2) * scale,
			y: h / 2 - (h / 2) * scale,
			scale: scale,
		};
		this.draw();
	}

	private setupCanvas(tooltip: HTMLElement) {
		if (!this.canvas) return;
		const c = this.canvas;

		const resize = () => {
			const wrap = c.parentElement!;
			c.width = wrap.clientWidth;
			c.height = wrap.clientHeight;
			this.draw();
		};
		new ResizeObserver(resize).observe(c.parentElement!);
		resize();

		// Pan & zoom
		c.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				const factor = e.deltaY < 0 ? 1.1 : 0.9;
				const rect = c.getBoundingClientRect();
				const mx = e.clientX - rect.left;
				const my = e.clientY - rect.top;
				this.transform.x = mx - (mx - this.transform.x) * factor;
				this.transform.y = my - (my - this.transform.y) * factor;
				this.transform.scale *= factor;
				this.draw();
			},
			{ passive: false },
		);

		c.addEventListener("mousedown", (e) => {
			const world = this.screenToWorld(e.offsetX, e.offsetY);
			const hit = this.nodeAt(world.x, world.y);
			if (hit) {
				this.dragNode = hit;
				// Remember where inside the node the user clicked so it doesn't snap to centre
				this.dragNodeOffset = { x: hit.x - world.x, y: hit.y - world.y };

				// Identify the entire connected component cluster
				this.activeComponent.clear();
				const queue = [hit.id];
				this.activeComponent.add(hit.id);

				while (queue.length > 0) {
					const curr = queue.shift()!;
					for (const e of this.edges) {
						if (e.source === curr && !this.activeComponent.has(e.target)) {
							this.activeComponent.add(e.target);
							queue.push(e.target);
						}
						if (e.target === curr && !this.activeComponent.has(e.source)) {
							this.activeComponent.add(e.source);
							queue.push(e.source);
						}
					}
				}

				// Unfreeze only the active cluster, guaranteeing the rest of the graph stays frozen
				for (const n of this.nodes) {
					if (this.activeComponent.has(n.id)) n.frozen = false;
				}

				this.alpha = Math.max(this.alpha, 0.1);
				if (!this.simRunning) this.simulate();
			} else {
				this.isDragging = true;
				this.dragStart = { x: e.offsetX, y: e.offsetY };
			}
			c.style.cursor = "grabbing";
		});

		c.addEventListener("mousemove", (e) => {
			if (this.dragNode) {
				// Move node by world-space delta, preserving pick-up offset
				const w = this.screenToWorld(e.offsetX, e.offsetY);
				this.dragNode.x = w.x + this.dragNodeOffset.x;
				this.dragNode.y = w.y + this.dragNodeOffset.y;
				this.dragNode.vx = 0;
				this.dragNode.vy = 0;

				this.alpha = Math.max(this.alpha, 0.1);
				if (!this.simRunning) this.simulate();

				this.draw();
				return;
			}
			if (this.isDragging) {
				// Pan: delta in screen pixels, applied directly to transform
				this.transform.x += e.offsetX - this.dragStart.x;
				this.transform.y += e.offsetY - this.dragStart.y;
				this.dragStart = { x: e.offsetX, y: e.offsetY };
				this.draw();
				return;
			}
			// Hover tooltip
			const world = this.screenToWorld(e.offsetX, e.offsetY);
			const hit = this.nodeAt(world.x, world.y);
			if (hit !== this.hoveredNode) {
				this.hoveredNode = hit;
				this.draw();
			}
			if (hit) {
				tooltip.style.opacity = "1";
				tooltip.style.left = e.offsetX + 14 + "px";
				tooltip.style.top = e.offsetY + 14 + "px";
				tooltip.innerHTML = `<strong>${hit.label}</strong><br><span style="color:var(--text-muted);font-size:10px">${hit.type}</span>${hit.description ? `<br><span style="color:var(--text-muted);margin-top:4px;display:block">${hit.description.slice(0, 120)}${hit.description.length > 120 ? "…" : ""}</span>` : ""}`;
			} else {
				tooltip.style.opacity = "0";
			}
		});

		c.addEventListener("mouseup", () => {
			this.dragNode = null;
			this.activeComponent.clear();
			this.isDragging = false;
			c.style.cursor = "grab";
		});

		c.addEventListener("mouseleave", () => {
			if (this.dragNode || this.isDragging) {
				this.dragNode = null;
				this.activeComponent.clear();
				this.isDragging = false;
				c.style.cursor = "grab";
			}
			if (this.hoveredNode) {
				this.hoveredNode = null;
				tooltip.style.opacity = "0";
				this.draw();
			}
		});
	}

	private screenToWorld(sx: number, sy: number) {
		return {
			x: (sx - this.transform.x) / this.transform.scale,
			y: (sy - this.transform.y) / this.transform.scale,
		};
	}

	private nodeAt(wx: number, wy: number): GraphNode | null {
		const R = 30;
		for (const n of this.nodes) {
			if (n.x === undefined || n.y === undefined) continue;
			const dx = n.x - wx,
				dy = n.y - wy;
			if (dx * dx + dy * dy < R * R * 2) return n;
		}
		return null;
	}

	private async loadGraph() {
		const statsEl = document.getElementById("cognee-graph-stats");
		if (statsEl) statsEl.textContent = "Loading…";

		try {
			const base = this.plugin.settings.serverUrl || "http://localhost:8765";
			const res = await fetch(`${base}/graph`);
			const data = await res.json();

			const rawNodes: GraphNode[] = data.nodes || [];
			const rawEdges: GraphEdge[] = data.edges || [];

			// Remove EntityType and TextSummary nodes completely from the graph
			this.nodes = rawNodes.filter((n) => {
				if (!n.type) return true;
				const lowerType = n.type.toLowerCase();
				return lowerType !== "entitytype" && lowerType !== "textsummary";
			});

			const validNodeIds = new Set(this.nodes.map((n) => n.id));
			this.edges = rawEdges.filter(
				(e) => validNodeIds.has(e.source) && validNodeIds.has(e.target),
			);

			// Compute degrees to give massive nodes more repulsion and gravity resistance
			const degrees = new Map<string, number>();
			for (const n of this.nodes) degrees.set(n.id, 0);
			for (const e of this.edges) {
				degrees.set(e.source, (degrees.get(e.source) || 0) + 1);
				degrees.set(e.target, (degrees.get(e.target) || 0) + 1);
			}

			// Initialise random positions and masses
			const cx = (this.canvas?.width || 800) / 2;
			const cy = (this.canvas?.height || 600) / 2;
			for (let i = 0; i < this.nodes.length; i++) {
				const n = this.nodes[i];
				if (!n) continue;
				n.mass = 1 + (degrees.get(n.id) || 0) * 0.3;
				// Start them reasonably close. The massive repulsive force difference 
				// will organically blast unrelated clusters far away from each other 
				// while letting connected ones stick tightly together since they began near each other.
				n.x = cx + (Math.random() - 0.5) * 400;
				n.y = cy + (Math.random() - 0.5) * 400;
				n.vx = 0;
				n.vy = 0;
				n.frozen = false;
			}

			for (const e of this.edges) {
				const massA = 1 + (degrees.get(e.source) || 0) * 0.3;
				const massB = 1 + (degrees.get(e.target) || 0) * 0.3;
				// Vary the target distance based on the nodes' masses + some randomness
				// giving a very organic, sprawling look
				e.dist = 120 + (massA + massB) * 20 + Math.random() * 50;
			}

			// Identify complete disjoint clusters and assign them unique cluster IDs for coloring
			let currentClusterId = 0;
			for (const n of this.nodes) {
				if (n.clusterId !== undefined) continue;

				n.clusterId = currentClusterId;
				const q = [n.id];

				while (q.length > 0) {
					const curr = q.shift()!;
					for (const e of this.edges) {
						if (e.source === curr) {
							const t = this.nodes.find((node) => node.id === e.target);
							if (t && t.clusterId === undefined) {
								t.clusterId = currentClusterId;
								q.push(t.id);
							}
						}
						if (e.target === curr) {
							const s = this.nodes.find((node) => node.id === e.source);
							if (s && s.clusterId === undefined) {
								s.clusterId = currentClusterId;
								q.push(s.id);
							}
						}
					}
				}
				currentClusterId++;
			}

			if (statsEl)
				statsEl.textContent = `${this.nodes.length} nodes · ${this.edges.length} edges`;

			this.alpha = 1.0;
			this.centerView();
			this.simulate();
		} catch (err) {
			if (statsEl) statsEl.textContent = "Could not reach server";
		}
	}

	/** Simple force-directed layout (no D3 dependency). */
	private simulate() {
		this.simRunning = true;
		const nodeMap = new Map(this.nodes.map((n) => [n.id, n]));

		const step = () => {
			if (!this.simRunning) {
				this.draw();
				return;
			}

			this.alpha *= 0.985; // Moderate decay for a smooth but reasonably fast cooldown

			// We DO NOT apply gravity to individual nodes, because radial point-gravity
			// artificially forces the graph into a perfect circle at equilibrium.

			// Repulsion
			for (let i = 0; i < this.nodes.length; i++) {
				for (let j = i + 1; j < this.nodes.length; j++) {
					const a = this.nodes[i],
						b = this.nodes[j];
					if (!a || !b) continue;
					let dx = b.x - a.x;
					let dy = b.y - a.y;
					if (dx === 0 && dy === 0) {
						dx = (Math.random() - 0.5) * 2;
						dy = (Math.random() - 0.5) * 2;
					}
					const distSq = dx * dx + dy * dy;

					const isSameCluster =
						a.clusterId !== undefined && a.clusterId === b.clusterId;

					// By cutting off repulsion at a certain distance, we stop the entire graph
					// from acting like a single interconnected balloon. This ensures
					// disconnected clusters don't push each other when one is dragged.
					if (isSameCluster && distSq > 1000000) continue;
					if (!isSameCluster && distSq > 3000000) continue;

					const dist = Math.max(8, Math.sqrt(distSq));

					const massForce = (a.mass || 1) * (b.mass || 1);

					// Make different clusters repel each other harder than nodes in the same cluster
					const repulsionScalar = isSameCluster ? 25000 : 35000;
					const force = (repulsionScalar * massForce * this.alpha) / distSq;

					const fx = (dx / dist) * force;
					const fy = (dy / dist) * force;
					a.vx -= fx / (a.mass || 1);
					a.vy -= fy / (a.mass || 1);
					b.vx += fx / (b.mass || 1);
					b.vy += fy / (b.mass || 1);
				}
			}

			// Attraction (edges)
			for (const e of this.edges) {
				const a = nodeMap.get(e.source),
					b = nodeMap.get(e.target);
				if (!a || !b) continue;
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
				const targetDist = e.dist || 200;

				// Non-linear spring for organic feel
				const diff = dist - targetDist;
				const force =
					(diff * 0.03 +
						Math.sign(diff) * Math.pow(Math.abs(diff), 1.1) * 0.002) *
					this.alpha;

				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;
				a.vx += fx / (a.mass || 1);
				a.vy += fy / (a.mass || 1);
				b.vx -= fx / (b.mass || 1);
				b.vy -= fy / (b.mass || 1);
			}

			// Integrate
			const damping = 0.95; // heavy glide to completely naturally slide to a stop
			for (const n of this.nodes) {
				if (n === this.dragNode) continue;
				if (n.frozen) {
					n.vx = 0;
					n.vy = 0;
					continue;
				}

				n.vx *= damping;
				n.vy *= damping;

				// Cap velocity to prevent crazy bouncing
				const vMag = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
				const maxV = 60;
				if (vMag > maxV) {
					n.vx = (n.vx / vMag) * maxV;
					n.vy = (n.vy / vMag) * maxV;
				}

				n.x += n.vx;
				n.y += n.vy;
			}

			this.draw();

			// Stop the animation if we've cooled down enough
			if (this.alpha > 0.005) {
				this.animFrame = requestAnimationFrame(() => step());
			} else {
				this.simRunning = false;
				// Action completely settled: permanently freeze all nodes so that future
				// global decays (wakes) cannot randomly vibrate nodes that didn't explicitly unfreeze!
				for (const n of this.nodes) n.frozen = true;
			}
		};

		if (this.animFrame !== null) cancelAnimationFrame(this.animFrame);
		step();
	}

	private draw() {
		if (!this.canvas) return;
		const ctx = this.canvas.getContext("2d")!;
		const w = this.canvas.width,
			h = this.canvas.height;

		const computed = getComputedStyle(document.body);
		const bg =
			computed.getPropertyValue("--background-primary").trim() || "#1e1e1e";
		const fg = computed.getPropertyValue("--text-normal").trim() || "#dcddde";
		const lineCol =
			computed.getPropertyValue("--background-modifier-border").trim() ||
			"#444";
		const nodeCol =
			computed.getPropertyValue("--text-muted").trim() || "#a8a8a8";
		const accent =
			computed.getPropertyValue("--interactive-accent").trim() || "#7c3aed";

		// A theme-fitting muted palette using standard obsidian CSS variables
		const clusterColors = [
			computed.getPropertyValue("--color-blue").trim() || "#2e5a88",
			computed.getPropertyValue("--color-purple").trim() || "#5c3882",
			computed.getPropertyValue("--color-green").trim() || "#376f4e",
			computed.getPropertyValue("--color-orange").trim() || "#915324",
			computed.getPropertyValue("--color-pink").trim() || "#873c65",
			computed.getPropertyValue("--color-cyan").trim() || "#256c7a",
			computed.getPropertyValue("--color-yellow").trim() || "#8a7a25",
			computed.getPropertyValue("--color-red").trim() || "#8e2c2c",
		];

		ctx.clearRect(0, 0, w, h);

		// Background
		ctx.fillStyle = bg;
		ctx.fillRect(0, 0, w, h);

		if (this.nodes.length === 0) {
			ctx.fillStyle = nodeCol;
			ctx.font = "16px Inter, sans-serif";
			ctx.textAlign = "center";
			ctx.fillText(
				"No graph data yet. Ingest notes and build the knowledge graph.",
				w / 2,
				h / 2,
			);
			return;
		}

		ctx.save();
		ctx.translate(this.transform.x, this.transform.y);
		ctx.scale(this.transform.scale, this.transform.scale);

		const nodeMap = new Map(this.nodes.map((n) => [n.id, n]));

		const connectedNodeIds = new Set<string>();
		if (this.hoveredNode) {
			connectedNodeIds.add(this.hoveredNode.id);
			for (const e of this.edges) {
				if (e.source === this.hoveredNode.id) connectedNodeIds.add(e.target);
				if (e.target === this.hoveredNode.id) connectedNodeIds.add(e.source);
			}
		}

		// Edges
		for (const e of this.edges) {
			const a = nodeMap.get(e.source),
				b = nodeMap.get(e.target);
			if (!a || !b || a.x === undefined || b.x === undefined) continue;

			const isHoveredEdge =
				this.hoveredNode &&
				(e.source === this.hoveredNode.id || e.target === this.hoveredNode.id);

			ctx.beginPath();
			ctx.moveTo(a.x, a.y!);
			ctx.lineTo(b.x, b.y!);
			ctx.strokeStyle = isHoveredEdge ? accent : lineCol;
			ctx.lineWidth = (isHoveredEdge ? 2 : 1) / this.transform.scale;
			ctx.stroke();

			// Edge label at midpoint
			if (this.transform.scale > 0.6 && e.label) {
				const mx = (a.x + b.x) / 2,
					my = (a.y! + b.y!) / 2;
				ctx.fillStyle = nodeCol;
				ctx.font = `${9 / this.transform.scale}px Inter, sans-serif`;
				ctx.textAlign = "center";
				ctx.fillText(e.label, mx, my);
			}
		}

		// Nodes
		const baseR = 28;
		for (const n of this.nodes) {
			if (!n.x && n.x !== 0) continue;
			const isHighlighted = connectedNodeIds.has(n.id);

			const isSubject = n.type && n.type.toLowerCase() === "subject";
			const r = isSubject ? baseR * 1.6 : baseR;

			const color =
				clusterColors[(n.clusterId || 0) % clusterColors.length] || nodeCol;

			// Circle
			ctx.beginPath();
			ctx.arc(n.x, n.y!, r * (isHighlighted ? 1.3 : 1), 0, Math.PI * 2);
			ctx.fillStyle = isHighlighted ? accent : color;
			ctx.fill();

			// Label
			if (this.transform.scale > 0.4) {
				ctx.fillStyle = fg;
				ctx.font = `${11 / this.transform.scale}px Inter, sans-serif`;
				ctx.textAlign = "center";
				ctx.fillText(
					n.label.length > 20 ? n.label.slice(0, 18) + "…" : n.label,
					n.x,
					n.y! + r + 13 / this.transform.scale,
				);
			}
		}

		ctx.restore();
	}

	async onClose() {
		if (this.animFrame !== null) cancelAnimationFrame(this.animFrame);
		this.simRunning = false;
	}
}
