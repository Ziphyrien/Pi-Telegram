// src/memory/retrieval/hybrid-search.ts — candidate retrieval and final selection
import type { MemoryStore } from "../store/sqlite-store.js";
import { resolveScopeSet } from "../scope.js";
import type { MemoryEntityRef, MemoryNodeRecord, MemoryPromptContextRequest, RawTurnRecord } from "../types.js";
import type { MemoryRetrievalPlan, MemoryRetrievalPlanner } from "./planner.js";
import type { PiLlmRetrievalParticipant } from "./llm-participant.js";
import { cosineSimilarity } from "./vector.js";
import { reciprocalRankFusion } from "./rrf.js";
import { colbertLateInteractionScore } from "./colbert.js";
import { decayBoost } from "./temporal.js";
import { personalizedPageRank } from "./ppr.js";
import { mmrSelect, noveltyScore, type RetrievalCandidateScore } from "./diversity.js";
import { analyzeEvidenceGap } from "./evidence-gap.js";
import { flattenRecursiveClusters, recursiveClusterNodes } from "./clustering.js";

function planePriority(node: MemoryNodeRecord): number {
  switch (node.plane) {
    case "procedural": return 400;
    case "profile": return 300;
    case "project": return 200;
    case "episodic": return 100;
    default: return 0;
  }
}

function scopePriority(node: MemoryNodeRecord): number {
  switch (node.scopeKind) {
    case "chat-local": return 40;
    case "user-global": return 30;
    case "workspace-global": return 30;
    case "system-global": return 10;
    default: return 0;
  }
}

function temporalPriority(node: MemoryNodeRecord): number {
  switch (node.temporalLevel) {
    case "T5": return 50;
    case "T4": return 40;
    case "T3": return 30;
    case "T2": return 20;
    case "T1": return 10;
    default: return 0;
  }
}

function uniqueByFamily(nodes: MemoryNodeRecord[]): MemoryNodeRecord[] {
  const seen = new Set<string>();
  const out: MemoryNodeRecord[] = [];
  for (const node of nodes) {
    const key = node.familyUri || node.canonicalUri;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return out;
}

function uniqueByUri(nodes: MemoryNodeRecord[]): MemoryNodeRecord[] {
  const seen = new Set<string>();
  const out: MemoryNodeRecord[] = [];
  for (const node of nodes) {
    if (seen.has(node.canonicalUri)) continue;
    seen.add(node.canonicalUri);
    out.push(node);
  }
  return out;
}

function filterByPlan(nodes: MemoryNodeRecord[], plan: MemoryRetrievalPlan): MemoryNodeRecord[] {
  return nodes.filter((node) => {
    if (plan.targetPlanes.length && !plan.targetPlanes.includes(node.plane)) return false;
    if (plan.targetLevels.length && !plan.targetLevels.includes(node.temporalLevel)) return false;
    if (plan.scopeHints.length && !plan.scopeHints.includes(node.scopeKind)) return false;
    return true;
  });
}

function entityOverlap(a: MemoryEntityRef[] = [], b: MemoryEntityRef[] = []): number {
  const setA = new Set(a.map((x) => x.entityUri));
  const setB = new Set(b.map((x) => x.entityUri));
  if (!setA.size || !setB.size) return 0;
  let overlap = 0;
  for (const x of setA) {
    if (setB.has(x)) overlap += 1;
  }
  return overlap;
}

function buildPprEdges(
  nodes: MemoryNodeRecord[],
  entityMap: Map<string, MemoryEntityRef[]>,
): Array<{ from: string; to: string; weight: number }> {
  const edges: Array<{ from: string; to: string; weight: number }> = [];

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      let weight = 0;
      if (a.familyUri === b.familyUri) weight += 2;
      const overlap = entityOverlap(entityMap.get(a.canonicalUri), entityMap.get(b.canonicalUri));
      if (overlap > 0) weight += overlap * 1.2;
      if (a.plane === b.plane) weight += 0.3;
      if (!weight) continue;
      edges.push({ from: a.canonicalUri, to: b.canonicalUri, weight });
      edges.push({ from: b.canonicalUri, to: a.canonicalUri, weight });
    }
  }

  return edges;
}

function buildCandidateScores(
  query: string,
  fused: Array<{ node: MemoryNodeRecord; score: number; channels: string[] }>,
  entityMap: Map<string, MemoryEntityRef[]>,
  now: number,
): RetrievalCandidateScore[] {
  return fused.map((item) => ({
    node: item.node,
    entities: entityMap.get(item.node.canonicalUri) ?? [],
    channels: item.channels,
    relevance:
      item.score * 100
      + planePriority(item.node)
      + scopePriority(item.node)
      + temporalPriority(item.node)
      + (item.node.importance * 100)
      + (item.node.confidence * 80)
      + decayBoost(item.node, now)
      + (colbertLateInteractionScore(query, item.node) * 25),
  }));
}

function reorderByCluster(scores: RetrievalCandidateScore[], entityMap: Map<string, MemoryEntityRef[]>): RetrievalCandidateScore[] {
  const clusters = recursiveClusterNodes(scores.map((score) => score.node), entityMap);
  const orderedNodes = flattenRecursiveClusters(clusters);
  const byUri = new Map(scores.map((score) => [score.node.canonicalUri, score]));
  const out: RetrievalCandidateScore[] = [];
  for (const node of orderedNodes) {
    const score = byUri.get(node.canonicalUri);
    if (score) out.push(score);
  }
  for (const score of scores) {
    if (!out.some((item) => item.node.canonicalUri === score.node.canonicalUri)) {
      out.push(score);
    }
  }
  return out;
}

export interface MemoryRetrievalResult {
  plan: MemoryRetrievalPlan;
  nodes: MemoryNodeRecord[];
  recentTurns: RawTurnRecord[];
  evidenceGap: string[];
  channelCoverage: Map<string, string[]>;
  noveltyByUri: Map<string, number>;
  clusterCount: number;
}

export class MemoryHybridRetriever {
  constructor(
    private readonly store: MemoryStore,
    private readonly planner: MemoryRetrievalPlanner,
    private readonly semantic?: {
      model: string;
      embedQuery: (input: string) => Promise<number[]>;
    },
    private readonly llmParticipant?: PiLlmRetrievalParticipant,
  ) {}

  get hasSemantic(): boolean {
    return Boolean(this.semantic);
  }

  get hasLlmParticipation(): boolean {
    return Boolean(this.llmParticipant);
  }

  async retrieve(request: MemoryPromptContextRequest, limits: {
    maxRetrievedMemories: number;
    maxRecentTurns: number;
  }): Promise<MemoryRetrievalResult> {
    const fallbackPlan = this.planner.plan(request, limits);
    const plan = await this.llmParticipant?.plan(request, fallbackPlan, limits) ?? fallbackPlan;
    const scopes = resolveScopeSet(request.botHash, request.chatId, request.userId, request.workspaceCwd);
    const queryText = [request.prompt, ...plan.clues].join("\n");

    const sparseNodes = plan.targetChannels.includes("sparse")
      ? this.store.searchMemories(scopes, [...plan.searchTerms, ...plan.clues], plan.maxCandidates).nodes
      : [];
    const entityAnchors = plan.targetChannels.includes("graph")
      ? this.store.searchByEntityAnchors(scopes, [...plan.searchTerms, ...plan.clues], plan.maxCandidates)
      : [];
    const baseSeeds = uniqueByUri([...sparseNodes, ...entityAnchors]).slice(0, Math.max(1, Math.floor(plan.maxCandidates / 2)));
    const graphNeighbors = plan.targetChannels.includes("graph")
      ? this.store.searchByGraphNeighborhood(scopes, baseSeeds.map((node) => node.canonicalUri), plan.maxCandidates)
      : [];
    const temporalNodes = plan.targetChannels.includes("temporal")
      ? this.store.listRecentNodes(scopes, plan.maxCandidates)
      : [];
    const hierarchicalNodes = baseSeeds.length
      ? this.store.listFamilyMembers(scopes, baseSeeds.map((node) => node.familyUri), plan.maxCandidates * 2)
      : [];
    const semanticNodes: MemoryNodeRecord[] = [];

    if (this.semantic && plan.targetChannels.includes("dense")) {
      try {
        const queryVector = await this.semantic.embedQuery(queryText);
        const embedded = this.store.listEmbeddingRecords(scopes, this.semantic.model, plan.maxCandidates * 4);
        embedded
          .map((item) => ({ node: item.node, score: cosineSimilarity(queryVector, item.embedding.vector) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, plan.maxCandidates)
          .forEach((item) => semanticNodes.push(item.node));
      } catch {
        // semantic retrieval remains optional
      }
    }

    const mergedNodes = uniqueByUri([...sparseNodes, ...entityAnchors, ...graphNeighbors, ...temporalNodes, ...hierarchicalNodes, ...semanticNodes]);
    const { entitiesByNode } = this.store.getArtifactsForNodes(mergedNodes.map((node) => node.canonicalUri));

    const pprNodes = plan.targetChannels.includes("graph")
      ? personalizedPageRank(
        mergedNodes.map((node) => ({ id: node.canonicalUri, value: node })),
        buildPprEdges(mergedNodes, entitiesByNode),
        baseSeeds.map((node) => node.canonicalUri),
      ).map((item) => item.node.value)
      : [];

    const fused = reciprocalRankFusion([
      { channel: "sparse", nodes: sparseNodes, weight: 1.0 },
      { channel: "entity", nodes: entityAnchors, weight: 1.05 },
      { channel: "graph", nodes: graphNeighbors, weight: 0.9 },
      { channel: "temporal", nodes: temporalNodes, weight: 0.8 },
      { channel: "hierarchical", nodes: hierarchicalNodes, weight: 0.95 },
      { channel: "dense", nodes: semanticNodes, weight: 1.15 },
      { channel: "ppr", nodes: pprNodes, weight: 0.9 },
    ].filter((list) => list.nodes.length));

    const now = Date.now();
    const scoredCandidates = buildCandidateScores(queryText, fused, entitiesByNode, now)
      .sort((a, b) => b.relevance - a.relevance);

    const filteredCandidates = filterByPlan(scoredCandidates.map((score) => score.node), plan);
    const candidatePool = filteredCandidates.length >= Math.max(1, Math.floor(plan.maxFinalMemories / 2))
      ? scoredCandidates.filter((score) => filteredCandidates.some((node) => node.canonicalUri === score.node.canonicalUri))
      : scoredCandidates;

    const clusteredCandidates = reorderByCluster(candidatePool, entitiesByNode);
    const mmrCandidates = mmrSelect(clusteredCandidates, Math.max(plan.maxFinalMemories * 2, plan.maxFinalMemories));

    const llmRanked = await this.llmParticipant?.rerank(request, plan, mmrCandidates.map((item) => item.node));
    const selectedNodes = uniqueByFamily(llmRanked ?? mmrCandidates.map((item) => item.node)).slice(0, plan.maxFinalMemories);

    const selectedScores = selectedNodes.map((node) => mmrCandidates.find((item) => item.node.canonicalUri === node.canonicalUri) ?? {
      node,
      relevance: 0,
      entities: entitiesByNode.get(node.canonicalUri) ?? [],
    });
    const noveltyByUri = new Map<string, number>();
    const noveltySelected: RetrievalCandidateScore[] = [];
    for (const score of selectedScores) {
      noveltyByUri.set(score.node.canonicalUri, noveltyScore(score, noveltySelected));
      noveltySelected.push(score);
    }

    const channelCoverage = new Map<string, string[]>();
    for (const item of fused) {
      for (const channel of item.channels) {
        const list = channelCoverage.get(channel) ?? [];
        list.push(item.node.canonicalUri);
        channelCoverage.set(channel, list);
      }
    }

    const evidenceGap = analyzeEvidenceGap(plan, selectedNodes, channelCoverage).gaps;

    const recentTurns = plan.targetChannels.includes("recent")
      ? this.store.searchMemories(scopes, [], Math.max(plan.maxCandidates, plan.maxRecentTurns)).recentTurns
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, plan.maxRecentTurns)
          .reverse()
      : [];

    const clusterCount = recursiveClusterNodes(candidatePool.map((score) => score.node), entitiesByNode).length;

    return {
      plan,
      nodes: selectedNodes,
      recentTurns,
      evidenceGap,
      channelCoverage,
      noveltyByUri,
      clusterCount,
    };
  }
}
