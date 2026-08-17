import { Router, Request, Response } from 'express';
import { getDatabase, parseRowJson } from '../db';
import { requireRole } from '../middleware/security';
import {
  openOrGetSession, joinSession, getSessionOrders, getSessionTotal, closeSession,
  type TableSession,
} from '../services/table-session';

const router = Router();

/** Merged billing view for a whole table: orders, summed total, paid, members. */
function sessionSummary(sessionId: string) {
  const db = getDatabase();
  const session = db.prepare('SELECT * FROM table_sessions WHERE id = ?').get(sessionId) as TableSession | undefined;
  if (!session) return null;

  const orders = getSessionOrders(sessionId).map((o) => parseRowJson(o));
  const total = getSessionTotal(sessionId);

  const paidRow = db.prepare(`
    SELECT COALESCE(SUM(b.paid_amount), 0) AS paid
    FROM bills b JOIN orders o ON o.id = b.order_id
    WHERE o.table_session_id = ? AND o.status != 'cancelled'
  `).get(sessionId) as { paid: number };
  const paid = paidRow.paid;

  const members = db.prepare(`
    SELECT id, member_type, guest_token, staff_id, joined_at, left_at
    FROM table_session_members WHERE table_session_id = ? ORDER BY joined_at
  `).all(sessionId);

  const bySource = db.prepare(`
    SELECT COALESCE(source, 'UNKNOWN') AS source, COUNT(*) AS count
    FROM orders WHERE table_session_id = ? AND status != 'cancelled' GROUP BY source
  `).all(sessionId);

  return { session, orders, members, totals: { total, paid, balance: Math.max(0, total - paid) }, by_source: bySource };
}

router.get('/:id', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  const summary = sessionSummary(req.params.id as string);
  if (!summary) return res.status(404).json({ error: 'Session not found' });
  res.json(summary);
});

router.get('/by-table/:tableId', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  const session = getDatabase().prepare(
    `SELECT * FROM table_sessions WHERE table_id = ? AND status IN ('OPEN', 'LOCKED') LIMIT 1`
  ).get(req.params.tableId as string) as TableSession | undefined;
  if (!session) return res.json({ session: null });
  res.json(sessionSummary(session.id));
});

// Staff table selector: open the table's session, or join the existing one.
router.post('/select', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  const tableId = req.body?.table_id;
  if (!tableId) return res.status(400).json({ error: 'table_id is required' });
  const staffId = String((req as any).user.userId);
  const session = openOrGetSession(String(tableId), 'STAFF');
  if (session.status === 'OPEN') joinSession(session.id, { member_type: 'STAFF', staff_id: staffId });
  res.json(sessionSummary(session.id));
});

router.post('/:id/close', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    closeSession(req.params.id as string);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

export const tableSessionRoutes = router;
