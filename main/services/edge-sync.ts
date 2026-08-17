// Edge Sync — the Branch Edge side of the store-and-forward protocol. Buffers
// domain events (orders, table sessions) into the local outbox with a monotonic
// per-edge sequence, so the cloud can apply them in order, gap-free, exactly
// once. The cloud-side receiver, command queue, and cursor live in the external
// cloud app; this file covers only what the edge owns.
import Database from 'better-sqlite3';
import { getDatabase, getNextSequence, getSettingValue, now } from '../db';
import { randomUUID } from 'crypto';

function edgeSyncEnabled(): boolean {
  return getSettingValue('cloud_sync_enabled') === '1';
}

/** Next value of this edge's monotonic event sequence (the sync cursor). */
export function nextEdgeEventSeq(): number {
  return getNextSequence('edge_event', 'ALL');
}

export interface EdgeEventInput {
  entityType: string;
  entityId: string;
  eventType: string;
  payload: unknown;
}

/**
 * Buffer one event into the outbox for forwarding. Assigns the next sequence
 * number and an idempotency key so redelivery to the cloud is a no-op. No-ops
 * (returns null) when cloud integration is off. Safe inside a transaction.
 */
export function enqueueEdgeEvent(db: Database.Database, input: EdgeEventInput): number | null {
  if (!edgeSyncEnabled()) return null;
  const seq = nextEdgeEventSeq();
  const idempotencyKey = `${input.entityType}:${input.entityId}:${input.eventType}:${seq}`;
  db.prepare(`
    INSERT INTO cloud_sync_outbox
      (id, event_type, entity_type, entity_id, payload, status, attempt_count, event_seq, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(
    randomUUID(), input.eventType, input.entityType, input.entityId,
    JSON.stringify({ ...(input.payload as object), idempotency_key: idempotencyKey, event_seq: seq }),
    seq, now(), now(),
  );
  return seq;
}

/** Emit a table-session lifecycle event (opened/closed) to the outbox. */
export function recordSessionEvent(
  db: Database.Database,
  sessionId: string,
  eventType: 'session.opened' | 'session.closed',
  payload: Record<string, unknown> = {},
): void {
  try {
    enqueueEdgeEvent(db, { entityType: 'table_session', entityId: sessionId, eventType, payload });
  } catch (err) {
    console.error('[EdgeSync] session event enqueue failed:', (err as Error).message);
  }
}

export type EdgeDeviceKind = 'POS' | 'KDS' | 'PRINTER_AGENT' | 'QR_GATEWAY';

export function registerEdgeDevice(id: string, kind: EdgeDeviceKind, label?: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO edge_devices (id, kind, label, status, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, label = excluded.label, updated_at = excluded.updated_at
  `).run(id, kind, label ?? null, now(), now(), now());
}

export function touchEdgeDevice(id: string): void {
  getDatabase().prepare('UPDATE edge_devices SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
}

export function listEdgeDevices(): any[] {
  return getDatabase().prepare('SELECT * FROM edge_devices ORDER BY kind, label, id').all();
}

/** Outbox observability: how far behind the cloud this edge is. */
export function edgeSyncStatus(): { last_seq: number; pending: number; synced: number; failed: number } {
  const db = getDatabase();
  const seq = db.prepare("SELECT COALESCE(MAX(event_seq), 0) AS s FROM cloud_sync_outbox").get() as { s: number };
  const count = (status: string) =>
    (db.prepare('SELECT COUNT(*) AS c FROM cloud_sync_outbox WHERE status = ?').get(status) as { c: number }).c;
  return { last_seq: seq.s, pending: count('pending'), synced: count('synced'), failed: count('failed') };
}
