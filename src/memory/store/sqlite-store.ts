// src/memory/store/sqlite-store.ts — primary SQLite memory store
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryCandidate, MemoryEmbeddingRecord, MemoryEntityRef, MemoryNodeRecord, MemoryRelationRef, MemorySearchResult, MemoryScopeSet, RawTurnRecord } from "../types.js";

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapNode(row: Record<string, unknown>): MemoryNodeRecord {
  return {
    canonicalUri: String(row.canonical_uri),
    familyUri: String(row.family_uri),
    scopeKind: row.scope_kind as MemoryNodeRecord["scopeKind"],
    scopeId: String(row.scope_id),
    scopeUri: String(row.scope_uri),
    plane: row.plane as MemoryNodeRecord["plane"],
    temporalLevel: row.temporal_level as MemoryNodeRecord["temporalLevel"],
    type: String(row.type),
    summary: String(row.summary),
    canonicalText: String(row.canonical_text),
    keywords: fromJson<string[]>(row.keywords_json, []),
    importance: Number(row.importance || 0),
    confidence: Number(row.confidence || 0),
    temperature: row.temperature as MemoryNodeRecord["temperature"],
    sourceKind: row.source_kind as MemoryNodeRecord["sourceKind"],
    sourceChatId: Number(row.source_chat_id || 0),
    userId: row.user_id == null ? undefined : Number(row.user_id),
    workspaceId: String(row.workspace_id || ""),
    eventType: row.event_type == null ? undefined : String(row.event_type),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    lastAccessedAt: Number(row.last_accessed_at || 0),
    accessCount: Number(row.access_count || 0),
    metadata: fromJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

function mapTurn(row: Record<string, unknown>): RawTurnRecord {
  return {
    turnUri: String(row.turn_uri),
    turnGroupId: String(row.turn_group_id),
    scopeKind: row.scope_kind as RawTurnRecord["scopeKind"],
    scopeId: String(row.scope_id),
    scopeUri: String(row.scope_uri),
    chatId: Number(row.chat_id || 0),
    userId: row.user_id == null ? undefined : Number(row.user_id),
    workspaceId: String(row.workspace_id || ""),
    botHash: String(row.bot_hash || ""),
    sourceKind: row.source_kind as RawTurnRecord["sourceKind"],
    role: row.role as RawTurnRecord["role"],
    content: String(row.content || ""),
    timestamp: Number(row.timestamp || 0),
    metadata: fromJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_uri TEXT NOT NULL UNIQUE,
        family_uri TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        scope_uri TEXT NOT NULL,
        plane TEXT NOT NULL,
        temporal_level TEXT NOT NULL,
        type TEXT NOT NULL,
        canonical_text TEXT NOT NULL,
        summary TEXT NOT NULL,
        event_type TEXT,
        keywords_json TEXT NOT NULL,
        importance REAL NOT NULL,
        confidence REAL NOT NULL,
        temperature TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_chat_id INTEGER NOT NULL,
        user_id INTEGER,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_nodes_scope ON memory_nodes(scope_kind, scope_id, plane, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_family ON memory_nodes(family_uri);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_workspace ON memory_nodes(workspace_id, plane, updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        canonical_uri UNINDEXED,
        scope_kind UNINDEXED,
        scope_id UNINDEXED,
        plane UNINDEXED,
        summary,
        canonical_text,
        keywords
      );

      CREATE TABLE IF NOT EXISTS memory_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_uri TEXT NOT NULL,
        entity_uri TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_label TEXT NOT NULL,
        confidence REAL NOT NULL,
        UNIQUE(canonical_uri, entity_uri)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_entities_label ON memory_entities(entity_label);
      CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_uri);

      CREATE TABLE IF NOT EXISTS memory_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_uri TEXT NOT NULL,
        edge_uri TEXT NOT NULL UNIQUE,
        subject_uri TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object_uri TEXT NOT NULL,
        confidence REAL NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_edges_subject ON memory_edges(subject_uri, predicate);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_object ON memory_edges(object_uri, predicate);

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        canonical_uri TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        embedding_dim INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (canonical_uri, embedding_model)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model ON memory_embeddings(embedding_model, updated_at DESC);

      CREATE TABLE IF NOT EXISTS raw_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_uri TEXT NOT NULL UNIQUE,
        turn_group_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        scope_uri TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        user_id INTEGER,
        workspace_id TEXT NOT NULL,
        bot_hash TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_raw_turns_scope ON raw_turns(scope_kind, scope_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_raw_turns_chat ON raw_turns(chat_id, timestamp DESC);
    `);
  }

  private syncFts(candidate: MemoryCandidate): void {
    this.db.prepare("DELETE FROM memory_fts WHERE canonical_uri = ?").run(candidate.canonicalUri);
    this.db.prepare(
      `INSERT INTO memory_fts (canonical_uri, scope_kind, scope_id, plane, summary, canonical_text, keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      candidate.canonicalUri,
      candidate.scopeKind,
      candidate.scopeId,
      candidate.plane,
      candidate.summary,
      candidate.canonicalText,
      candidate.keywords.join(" "),
    );
  }

  upsertCandidate(candidate: MemoryCandidate, timestampMs: number): string {
    const existing = candidate.upsertByFamily
      ? this.db.prepare(`
          SELECT canonical_uri
          FROM memory_nodes
          WHERE family_uri = ?
            AND temporal_level = ?
            AND plane = ?
            AND scope_kind = ?
            AND scope_id = ?
          LIMIT 1
        `).get(candidate.familyUri, candidate.temporalLevel, candidate.plane, candidate.scopeKind, candidate.scopeId) as Record<string, unknown> | undefined
      : undefined;

    if (existing) {
      const canonicalUri = String(existing.canonical_uri);
      this.db.prepare(`
        UPDATE memory_nodes
        SET scope_kind = ?, scope_id = ?, scope_uri = ?, plane = ?, temporal_level = ?, type = ?,
            canonical_text = ?, summary = ?, event_type = ?, keywords_json = ?, importance = ?, confidence = ?, temperature = ?,
            source_kind = ?, source_chat_id = ?, user_id = ?, workspace_id = ?, updated_at = ?,
            metadata_json = ?
        WHERE canonical_uri = ?
      `).run(
        candidate.scopeKind,
        candidate.scopeId,
        candidate.scopeUri,
        candidate.plane,
        candidate.temporalLevel,
        candidate.type,
        candidate.canonicalText,
        candidate.summary,
        candidate.eventType ?? null,
        toJson(candidate.keywords),
        candidate.importance,
        candidate.confidence,
        candidate.temperature,
        candidate.sourceKind,
        candidate.sourceChatId,
        candidate.userId ?? null,
        candidate.workspaceId,
        timestampMs,
        toJson(candidate.metadata),
        canonicalUri,
      );
      this.syncFts({ ...candidate, canonicalUri });
      return canonicalUri;
    }

    this.db.prepare(`
      INSERT INTO memory_nodes (
        canonical_uri, family_uri, scope_kind, scope_id, scope_uri, plane, temporal_level, type,
        canonical_text, summary, event_type, keywords_json, importance, confidence, temperature,
        source_kind, source_chat_id, user_id, workspace_id, created_at, updated_at,
        last_accessed_at, access_count, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.canonicalUri,
      candidate.familyUri,
      candidate.scopeKind,
      candidate.scopeId,
      candidate.scopeUri,
      candidate.plane,
      candidate.temporalLevel,
      candidate.type,
      candidate.canonicalText,
      candidate.summary,
      candidate.eventType ?? null,
      toJson(candidate.keywords),
      candidate.importance,
      candidate.confidence,
      candidate.temperature,
      candidate.sourceKind,
      candidate.sourceChatId,
      candidate.userId ?? null,
      candidate.workspaceId,
      timestampMs,
      timestampMs,
      timestampMs,
      0,
      toJson(candidate.metadata),
    );
    this.syncFts(candidate);
    return candidate.canonicalUri;
  }

  upsertGraphArtifacts(canonicalUri: string, entities: MemoryEntityRef[] = [], relations: MemoryRelationRef[] = []): void {
    this.db.prepare("DELETE FROM memory_entities WHERE canonical_uri = ?").run(canonicalUri);
    this.db.prepare("DELETE FROM memory_edges WHERE canonical_uri = ?").run(canonicalUri);

    const insertEntity = this.db.prepare(`
      INSERT OR REPLACE INTO memory_entities (canonical_uri, entity_uri, entity_type, entity_label, confidence)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const entity of entities) {
      insertEntity.run(canonicalUri, entity.entityUri, entity.entityType, entity.label, entity.confidence);
    }

    const insertEdge = this.db.prepare(`
      INSERT OR REPLACE INTO memory_edges (canonical_uri, edge_uri, subject_uri, predicate, object_uri, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const relation of relations) {
      insertEdge.run(canonicalUri, relation.edgeUri, relation.subjectUri, relation.predicate, relation.objectUri, relation.confidence);
    }
  }

  upsertEmbedding(canonicalUri: string, model: string, vector: number[], timestampMs: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_embeddings (canonical_uri, embedding_model, embedding_json, embedding_dim, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(canonicalUri, model, toJson(vector), vector.length, timestampMs);
  }

  listEmbeddingRecords(scopes: MemoryScopeSet, model: string, limit: number): Array<{ node: MemoryNodeRecord; embedding: MemoryEmbeddingRecord }> {
    const scopeWhere = this.buildScopeWhere(scopes);
    const rows = this.db.prepare(`
      SELECT n.*, e.embedding_model, e.embedding_json
      FROM memory_nodes n
      JOIN memory_embeddings e ON e.canonical_uri = n.canonical_uri
      WHERE e.embedding_model = ? AND (${scopeWhere.clause})
      ORDER BY n.updated_at DESC
      LIMIT ?
    `).all(model, ...scopeWhere.params, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      node: mapNode(row),
      embedding: {
        canonicalUri: String(row.canonical_uri),
        model: String(row.embedding_model),
        vector: fromJson<number[]>(row.embedding_json, []),
      },
    }));
  }

  searchByEntityAnchors(scopes: MemoryScopeSet, searchTerms: string[], limit: number): MemoryNodeRecord[] {
    if (!searchTerms.length) return [];
    const scopeWhere = this.buildScopeWhere(scopes);
    const clauses = searchTerms.map(() => "LOWER(me.entity_label) LIKE ?").join(" OR ");
    const params = searchTerms.map((term) => `%${term.toLowerCase()}%`);
    const rows = this.db.prepare(`
      SELECT DISTINCT n.*
      FROM memory_entities me
      JOIN memory_nodes n ON n.canonical_uri = me.canonical_uri
      WHERE (${clauses}) AND (${scopeWhere.clause})
      ORDER BY n.updated_at DESC, n.importance DESC
      LIMIT ?
    `).all(...params, ...scopeWhere.params, limit) as Array<Record<string, unknown>>;
    return rows.map(mapNode);
  }

  insertRawTurn(turn: RawTurnRecord): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO raw_turns (
        turn_uri, turn_group_id, scope_kind, scope_id, scope_uri, chat_id, user_id, workspace_id,
        bot_hash, source_kind, role, content, timestamp, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn.turnUri,
      turn.turnGroupId,
      turn.scopeKind,
      turn.scopeId,
      turn.scopeUri,
      turn.chatId,
      turn.userId ?? null,
      turn.workspaceId,
      turn.botHash,
      turn.sourceKind,
      turn.role,
      turn.content,
      turn.timestamp,
      toJson(turn.metadata),
    );
  }

  private buildScopeWhere(scopes: MemoryScopeSet): { clause: string; params: Array<string> } {
    const clauses = ["(scope_kind = ? AND scope_id = ?)"];
    const params: string[] = [scopes.chat.kind, scopes.chat.id];

    if (scopes.user) {
      clauses.push("(scope_kind = ? AND scope_id = ?)");
      params.push(scopes.user.kind, scopes.user.id);
    }

    clauses.push("(scope_kind = ? AND scope_id = ?)");
    params.push(scopes.workspace.kind, scopes.workspace.id);

    return { clause: clauses.join(" OR "), params };
  }

  searchMemories(scopes: MemoryScopeSet, searchTerms: string[], limit: number): MemorySearchResult {
    const scopeWhere = this.buildScopeWhere(scopes);
    const nodes: MemoryNodeRecord[] = [];

    const matchQuery = searchTerms.join(" ").trim();
    if (matchQuery) {
      try {
        const rows = this.db.prepare(`
          SELECT n.*, bm25(memory_fts, 2.0, 1.0, 1.5) AS rank_score
          FROM memory_fts
          JOIN memory_nodes n ON n.canonical_uri = memory_fts.canonical_uri
          WHERE memory_fts MATCH ? AND (${scopeWhere.clause})
          ORDER BY rank_score, n.updated_at DESC
          LIMIT ?
        `).all(matchQuery, ...scopeWhere.params, limit * 3) as Array<Record<string, unknown>>;
        for (const row of rows) nodes.push(mapNode(row));
      } catch {
        // fall back to recency-only retrieval below
      }
    }

    const seen = new Set(nodes.map((x) => x.canonicalUri));
    const recentRows = this.db.prepare(`
      SELECT *
      FROM memory_nodes
      WHERE (${scopeWhere.clause})
      ORDER BY updated_at DESC, importance DESC
      LIMIT ?
    `).all(...scopeWhere.params, limit * 4) as Array<Record<string, unknown>>;

    for (const row of recentRows) {
      const node = mapNode(row);
      if (seen.has(node.canonicalUri)) continue;
      seen.add(node.canonicalUri);
      nodes.push(node);
    }

    const recentTurnsRows = this.db.prepare(`
      SELECT *
      FROM raw_turns
      WHERE scope_kind = ? AND scope_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(scopes.chat.kind, scopes.chat.id, Math.max(1, limit * 2)) as Array<Record<string, unknown>>;

    return {
      nodes,
      recentTurns: recentTurnsRows.map(mapTurn),
    };
  }

  getNode(canonicalUri: string): MemoryNodeRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memory_nodes WHERE canonical_uri = ? LIMIT 1").get(canonicalUri) as Record<string, unknown> | undefined;
    return row ? mapNode(row) : undefined;
  }

  listRecentNodes(scopes: MemoryScopeSet, limit: number): MemoryNodeRecord[] {
    const scopeWhere = this.buildScopeWhere(scopes);
    const rows = this.db.prepare(`
      SELECT *
      FROM memory_nodes
      WHERE (${scopeWhere.clause})
      ORDER BY updated_at DESC, importance DESC, confidence DESC
      LIMIT ?
    `).all(...scopeWhere.params, limit) as Array<Record<string, unknown>>;
    return rows.map(mapNode);
  }

  listFamilyMembers(scopes: MemoryScopeSet, familyUris: string[], limit: number): MemoryNodeRecord[] {
    if (!familyUris.length) return [];
    const scopeWhere = this.buildScopeWhere(scopes);
    const placeholders = familyUris.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT *
      FROM memory_nodes
      WHERE family_uri IN (${placeholders})
        AND (${scopeWhere.clause})
      ORDER BY updated_at DESC, importance DESC, confidence DESC
      LIMIT ?
    `).all(...familyUris, ...scopeWhere.params, limit) as Array<Record<string, unknown>>;
    return rows.map(mapNode);
  }

  searchByGraphNeighborhood(scopes: MemoryScopeSet, seedCanonicalUris: string[], limit: number): MemoryNodeRecord[] {
    if (!seedCanonicalUris.length) return [];
    const scopeWhere = this.buildScopeWhere(scopes);
    const placeholders = seedCanonicalUris.map(() => "?").join(", ");
    const seen = new Set<string>();
    const out: MemoryNodeRecord[] = [];

    const sharedEntityRows = this.db.prepare(`
      SELECT DISTINCT n.*
      FROM memory_entities seed
      JOIN memory_entities linked ON linked.entity_uri = seed.entity_uri
      JOIN memory_nodes n ON n.canonical_uri = linked.canonical_uri
      WHERE seed.canonical_uri IN (${placeholders})
        AND linked.canonical_uri NOT IN (${placeholders})
        AND (${scopeWhere.clause})
      ORDER BY n.updated_at DESC, n.importance DESC
      LIMIT ?
    `).all(...seedCanonicalUris, ...seedCanonicalUris, ...scopeWhere.params, limit) as Array<Record<string, unknown>>;

    for (const row of sharedEntityRows) {
      const node = mapNode(row);
      if (seen.has(node.canonicalUri)) continue;
      seen.add(node.canonicalUri);
      out.push(node);
    }

    const sharedEdgeRows = this.db.prepare(`
      SELECT DISTINCT n.*
      FROM memory_edges seed
      JOIN memory_edges linked
        ON linked.subject_uri = seed.subject_uri
        OR linked.object_uri = seed.object_uri
        OR linked.subject_uri = seed.object_uri
        OR linked.object_uri = seed.subject_uri
      JOIN memory_nodes n ON n.canonical_uri = linked.canonical_uri
      WHERE seed.canonical_uri IN (${placeholders})
        AND linked.canonical_uri NOT IN (${placeholders})
        AND (${scopeWhere.clause})
      ORDER BY n.updated_at DESC, n.importance DESC
      LIMIT ?
    `).all(...seedCanonicalUris, ...seedCanonicalUris, ...scopeWhere.params, limit) as Array<Record<string, unknown>>;

    for (const row of sharedEdgeRows) {
      const node = mapNode(row);
      if (seen.has(node.canonicalUri)) continue;
      seen.add(node.canonicalUri);
      out.push(node);
      if (out.length >= limit) break;
    }

    return out.slice(0, limit);
  }

  getEntities(canonicalUri: string): MemoryEntityRef[] {
    const rows = this.db.prepare("SELECT entity_uri, entity_type, entity_label, confidence FROM memory_entities WHERE canonical_uri = ? ORDER BY confidence DESC").all(canonicalUri) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      entityUri: String(row.entity_uri),
      entityType: String(row.entity_type),
      label: String(row.entity_label),
      confidence: Number(row.confidence || 0),
    }));
  }

  getEdges(canonicalUri: string): MemoryRelationRef[] {
    const rows = this.db.prepare("SELECT edge_uri, subject_uri, predicate, object_uri, confidence FROM memory_edges WHERE canonical_uri = ? ORDER BY confidence DESC").all(canonicalUri) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      edgeUri: String(row.edge_uri),
      subjectUri: String(row.subject_uri),
      predicate: String(row.predicate),
      objectUri: String(row.object_uri),
      confidence: Number(row.confidence || 0),
    }));
  }

  getArtifactsForNodes(canonicalUris: string[]): { entitiesByNode: Map<string, MemoryEntityRef[]>; edgesByNode: Map<string, MemoryRelationRef[]> } {
    const entitiesByNode = new Map<string, MemoryEntityRef[]>();
    const edgesByNode = new Map<string, MemoryRelationRef[]>();
    for (const canonicalUri of canonicalUris) {
      entitiesByNode.set(canonicalUri, this.getEntities(canonicalUri));
      edgesByNode.set(canonicalUri, this.getEdges(canonicalUri));
    }
    return { entitiesByNode, edgesByNode };
  }

  patchNodeMetadata(canonicalUri: string, patch: Record<string, unknown>): void {
    const existing = this.getNode(canonicalUri);
    if (!existing) return;
    const nextMetadata = {
      ...(existing.metadata ?? {}),
      ...patch,
    };
    this.db.prepare(`
      UPDATE memory_nodes
      SET metadata_json = ?, updated_at = ?
      WHERE canonical_uri = ?
    `).run(toJson(nextMetadata), Date.now(), canonicalUri);
  }

  setNodeEventType(canonicalUri: string, eventType: string | undefined): void {
    this.db.prepare(`
      UPDATE memory_nodes
      SET event_type = ?, updated_at = ?
      WHERE canonical_uri = ?
    `).run(eventType ?? null, Date.now(), canonicalUri);
  }

  forgetCanonicalUri(canonicalUri: string): number {
    this.db.prepare("DELETE FROM memory_fts WHERE canonical_uri = ?").run(canonicalUri);
    this.db.prepare("DELETE FROM memory_entities WHERE canonical_uri = ?").run(canonicalUri);
    this.db.prepare("DELETE FROM memory_edges WHERE canonical_uri = ?").run(canonicalUri);
    this.db.prepare("DELETE FROM memory_embeddings WHERE canonical_uri = ?").run(canonicalUri);
    const result = this.db.prepare("DELETE FROM memory_nodes WHERE canonical_uri = ?").run(canonicalUri) as { changes?: number };
    return Number(result?.changes || 0);
  }

  forgetFamilyUri(familyUri: string): number {
    const rows = this.db.prepare("SELECT canonical_uri FROM memory_nodes WHERE family_uri = ?").all(familyUri) as Array<Record<string, unknown>>;
    let deleted = 0;
    for (const row of rows) {
      deleted += this.forgetCanonicalUri(String(row.canonical_uri));
    }
    return deleted;
  }

  purgeScope(scopeKind: MemoryNodeRecord["scopeKind"], scopeId: string): number {
    const rows = this.db.prepare("SELECT canonical_uri FROM memory_nodes WHERE scope_kind = ? AND scope_id = ?").all(scopeKind, scopeId) as Array<Record<string, unknown>>;
    let deleted = 0;
    for (const row of rows) {
      deleted += this.forgetCanonicalUri(String(row.canonical_uri));
    }
    const rawTurnsResult = this.db.prepare("DELETE FROM raw_turns WHERE scope_kind = ? AND scope_id = ?").run(scopeKind, scopeId) as { changes?: number };
    return deleted + Number(rawTurnsResult?.changes || 0);
  }

  exportSnapshot(scope?: { scopeKind?: MemoryNodeRecord["scopeKind"]; scopeId?: string }): {
    nodes: MemoryNodeRecord[];
    entities: MemoryEntityRef[];
    edges: MemoryRelationRef[];
    rawTurns: RawTurnRecord[];
  } {
    const where = scope?.scopeKind && scope?.scopeId
      ? "WHERE scope_kind = ? AND scope_id = ?"
      : "";
    const params = scope?.scopeKind && scope?.scopeId ? [scope.scopeKind, scope.scopeId] : [];
    const nodes = (this.db.prepare(`SELECT * FROM memory_nodes ${where} ORDER BY updated_at DESC`).all(...params) as Array<Record<string, unknown>>).map(mapNode);
    const rawTurns = (this.db.prepare(`SELECT * FROM raw_turns ${where} ORDER BY timestamp DESC`).all(...params) as Array<Record<string, unknown>>).map(mapTurn);
    const nodeUris = nodes.map((node) => node.canonicalUri);
    const entities = nodeUris.flatMap((canonicalUri) => this.getEntities(canonicalUri));
    const edges = nodeUris.flatMap((canonicalUri) => this.getEdges(canonicalUri));
    return { nodes, entities, edges, rawTurns };
  }

  exportSnapshotToFile(targetPath: string, scope?: { scopeKind?: MemoryNodeRecord["scopeKind"]; scopeId?: string }): { filePath: string; nodes: number; entities: number; edges: number; rawTurns: number } {
    mkdirSync(dirname(targetPath), { recursive: true });
    const snapshot = this.exportSnapshot(scope);
    writeFileSync(targetPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
    return {
      filePath: targetPath,
      nodes: snapshot.nodes.length,
      entities: snapshot.entities.length,
      edges: snapshot.edges.length,
      rawTurns: snapshot.rawTurns.length,
    };
  }

  listNodesNeedingRepair(scopes: MemoryScopeSet, limit: number): MemoryNodeRecord[] {
    const scopeWhere = this.buildScopeWhere(scopes);
    const rows = this.db.prepare(`
      SELECT *
      FROM memory_nodes
      WHERE (${scopeWhere.clause})
        AND (
          metadata_json LIKE '%"embeddingStatus":"missing"%'
          OR metadata_json LIKE '%"graphStatus":"failed"%'
        )
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...scopeWhere.params, limit) as Array<Record<string, unknown>>;
    return rows.map(mapNode);
  }

  integrityCheck(): string[] {
    const rows = this.db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    return rows.map((row) => String(row.quick_check || row.integrity_check || row[Object.keys(row)[0]] || "unknown"));
  }

  backupTo(targetPath: string): void {
    mkdirSync(dirname(targetPath), { recursive: true });
    rmSync(targetPath, { force: true });
    const escaped = targetPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
  }

  markAccessed(canonicalUris: string[], timestampMs: number): void {
    const stmt = this.db.prepare(`
      UPDATE memory_nodes
      SET last_accessed_at = ?, access_count = access_count + 1
      WHERE canonical_uri = ?
    `);
    for (const uri of canonicalUris) stmt.run(timestampMs, uri);
  }

  getStats(): { memoryNodes: number; rawTurns: number } {
    const memoryNodes = Number((this.db.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get() as Record<string, unknown>).count || 0);
    const rawTurns = Number((this.db.prepare("SELECT COUNT(*) AS count FROM raw_turns").get() as Record<string, unknown>).count || 0);
    return { memoryNodes, rawTurns };
  }

  shutdown(): void {
    this.db.close();
  }
}
