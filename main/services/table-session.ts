// Table Session Engine — one active dining session per table that every ordering
// channel (cloud QR, local QR, staff-assisted, POS) joins. Billing sums by
// table_session_id; kitchen routing stays channel-blind.
import { randomUUID } from 'crypto';
import { getDatabase, getNextSequence, now, withTxn } from '../db';
import { recordSessionEvent } from './edge-sync';

export type OrderSource = 'QR_LOCAL' | 'QR_CLOUD' | 'STAFF_LOCAL' | 'POS_LOCAL' | 'POS_CLOUD';
export type ActorType = 'GUEST' | 'STAFF' | 'POS';
export type OpenedByActor = 'GUEST_QR' | 'STAFF' | 'POS';
export type SessionStatus = 'OPEN' | 'LOCKED' | 'CLOSED';

export interface TableSession {
  id: string;
  session_no: string;
  table_id: string;
  status: SessionStatus;
  opened_by_actor: OpenedByActor;
  origin_device_id: string | null;
  opened_at: string;
  closed_at: string | null;
}

export interface JoinMember {
  member_type: 'GUEST' | 'STAFF';
  guest_token?: string | null;
  staff_id?: string | null;
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Return the table's active session (OPEN or LOCKED), creating a new OPEN one
 * only if the table is free. A returned LOCKED session means billing is
 * underway — callers must check `status` before adding orders.
 */
export function openOrGetSession(
  tableId: string,
  openedBy: OpenedByActor = 'STAFF',
  originDeviceId: string | null = null,
): TableSession {
  return withTxn(() => {
    const db = getDatabase();
    const existing = db
      .prepare(`SELECT * FROM table_sessions WHERE table_id = ? AND status IN ('OPEN', 'LOCKED') LIMIT 1`)
      .get(tableId) as TableSession | undefined;
    if (existing) return existing;

    const id = randomUUID();
    const sessionNo = `S-${getNextSequence('table_sessions', dateStamp())}`;
    const ts = now();
    db.prepare(`
      INSERT INTO table_sessions
        (id, session_no, table_id, status, opened_by_actor, origin_device_id, opened_at)
      VALUES (?, ?, ?, 'OPEN', ?, ?, ?)
    `).run(id, sessionNo, tableId, openedBy, originDeviceId, ts);

    recordSessionEvent(db, id, 'session.opened', { session_no: sessionNo, table_id: tableId, opened_by: openedBy });
    return db.prepare(`SELECT * FROM table_sessions WHERE id = ?`).get(id) as TableSession;
  });
}

/** Attach a guest or staff member to a session. Idempotent per active token/staff. */
export function joinSession(sessionId: string, member: JoinMember): void {
  withTxn(() => {
    const db = getDatabase();
    const session = db.prepare(`SELECT status FROM table_sessions WHERE id = ?`).get(sessionId) as { status: SessionStatus } | undefined;
    if (!session) throw new Error(`joinSession: no session ${sessionId}`);
    if (session.status !== 'OPEN') throw new Error(`joinSession: session ${sessionId} is ${session.status}, not OPEN`);

    const already = db.prepare(`
      SELECT 1 FROM table_session_members
      WHERE table_session_id = ? AND left_at IS NULL
        AND ((guest_token IS NOT NULL AND guest_token = ?) OR (staff_id IS NOT NULL AND staff_id = ?))
      LIMIT 1
    `).get(sessionId, member.guest_token ?? null, member.staff_id ?? null);
    if (already) return;

    db.prepare(`
      INSERT INTO table_session_members (id, table_session_id, member_type, guest_token, staff_id, joined_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), sessionId, member.member_type, member.guest_token ?? null, member.staff_id ?? null, now());
  });
}

/** Mark a member as having left the session. */
export function leaveSession(sessionId: string, opts: { guest_token?: string; staff_id?: string }): void {
  getDatabase().prepare(`
    UPDATE table_session_members SET left_at = ?
    WHERE table_session_id = ? AND left_at IS NULL
      AND ((guest_token IS NOT NULL AND guest_token = ?) OR (staff_id IS NOT NULL AND staff_id = ?))
  `).run(now(), sessionId, opts.guest_token ?? null, opts.staff_id ?? null);
}

/** Stamp an existing order with its session and provenance. */
export function linkOrderToSession(
  orderId: number | string,
  sessionId: string,
  provenance: { source: OrderSource; actor_type: ActorType; created_by_staff_id?: string | null },
): void {
  getDatabase().prepare(`
    UPDATE orders SET table_session_id = ?, source = ?, actor_type = ?, created_by_staff_id = ? WHERE id = ?
  `).run(sessionId, provenance.source, provenance.actor_type, provenance.created_by_staff_id ?? null, orderId);
}

export function getSessionOrders(sessionId: string): any[] {
  return getDatabase().prepare(`SELECT * FROM orders WHERE table_session_id = ? ORDER BY created_at DESC`).all(sessionId);
}

export function getSessionTotal(sessionId: string): number {
  const row = getDatabase().prepare(`
    SELECT COALESCE(SUM(total), 0) AS total FROM orders WHERE table_session_id = ? AND status != 'cancelled'
  `).get(sessionId) as { total: number };
  return row.total;
}

/** Lock a session for billing — no channel may add orders after this. */
export function lockSession(sessionId: string): void {
  const res = getDatabase()
    .prepare(`UPDATE table_sessions SET status = 'LOCKED' WHERE id = ? AND status = 'OPEN'`)
    .run(sessionId);
  if (res.changes === 0) throw new Error(`lockSession: ${sessionId} not OPEN`);
}

/**
 * Close the session iff every order in it is settled (completed or cancelled).
 * Non-throwing and idempotent — safe to call from the payment path. Returns
 * true when this call closed it.
 */
export function closeSessionIfSettled(sessionId: string): boolean {
  return withTxn(() => {
    const db = getDatabase();
    const open = db.prepare(
      `SELECT 1 FROM orders WHERE table_session_id = ? AND status NOT IN ('completed', 'cancelled') LIMIT 1`
    ).get(sessionId);
    if (open) return false;
    const res = db
      .prepare(`UPDATE table_sessions SET status = 'CLOSED', closed_at = ? WHERE id = ? AND status != 'CLOSED'`)
      .run(now(), sessionId);
    if (res.changes > 0) recordSessionEvent(db, sessionId, 'session.closed', { reason: 'settled' });
    return res.changes > 0;
  });
}

/** Close a settled session (manual). */
export function closeSession(sessionId: string): void {
  const db = getDatabase();
  const res = db
    .prepare(`UPDATE table_sessions SET status = 'CLOSED', closed_at = ? WHERE id = ? AND status != 'CLOSED'`)
    .run(now(), sessionId);
  if (res.changes === 0) throw new Error(`closeSession: ${sessionId} already closed or missing`);
  recordSessionEvent(db, sessionId, 'session.closed', { reason: 'manual' });
}
