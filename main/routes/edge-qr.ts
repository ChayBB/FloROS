// Local QR Gateway — unauthenticated, LAN-only guest ordering. A guest scans a
// table QR, gets a token bound to that table's active dining session, reads the
// menu, and places orders that fan into the same session as staff/POS orders.
// Mounted at /api/edge (allowlisted past requireAuth). Prices are always set
// server-side by buildOrder; the guest never sets prices or discounts.
import { Router, Request, Response } from 'express';
import { getDatabase, now, withTxn } from '../db';
import { randomUUID } from 'crypto';
import { buildOrder } from '../services/order-create';
import { openOrGetSession, joinSession, linkOrderToSession, getSessionTotal, type TableSession } from '../services/table-session';
import { notifyKdsUpdate } from '../services/kds';
import { cloudSync } from '../services/cloud-sync';

const router = Router();
const MAX_GUEST_ITEMS = 50;

function activeGuest(token: string) {
  const guest = getDatabase().prepare(
    `SELECT g.*, s.status AS session_status
     FROM qr_guest_sessions g JOIN table_sessions s ON s.id = g.table_session_id
     WHERE g.token = ? AND g.revoked_at IS NULL`
  ).get(token) as any;
  return guest || null;
}

function menuPayload() {
  const db = getDatabase();
  const categories = db.prepare(
    `SELECT id, name, sort_order FROM categories WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order, name`
  ).all();
  const products = db.prepare(
    `SELECT id, name, price, category_id, description, sku FROM products WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order, name`
  ).all();
  const groups = db.prepare(
    `SELECT id, name, is_required, min_selection, max_selection FROM addon_groups WHERE is_active = 1 ORDER BY sort_order, name`
  ).all() as any[];
  const addonsByGroup: Record<string, any[]> = {};
  for (const g of groups) {
    addonsByGroup[g.id] = db.prepare(
      `SELECT id, name, price FROM addons WHERE addon_group_id = ? AND is_active = 1 ORDER BY sort_order, name`
    ).all(g.id);
  }
  return { categories, products, addon_groups: groups.map((g) => ({ ...g, addons: addonsByGroup[g.id] })) };
}

function sessionBrief(session: TableSession) {
  return { id: session.id, session_no: session.session_no, table_id: session.table_id, status: session.status, total: getSessionTotal(session.id) };
}

router.post('/qr/start', (req: Request, res: Response) => {
  try {
    const tableId = req.body?.table_id;
    if (!tableId) return res.status(400).json({ error: 'table_id is required' });

    const result = withTxn(() => {
      const session = openOrGetSession(String(tableId), 'GUEST_QR');
      if (session.status !== 'OPEN') return { locked: true as const, session };
      const token = randomUUID();
      joinSession(session.id, { member_type: 'GUEST', guest_token: token });
      getDatabase().prepare(
        `INSERT INTO qr_guest_sessions (token, table_id, table_session_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`
      ).run(token, String(tableId), session.id, now(), now());
      return { locked: false as const, token, session };
    });

    if (result.locked) return res.status(409).json({ error: 'This table is being billed. Please ask staff.' });
    res.status(201).json({ token: result.token, session: sessionBrief(result.session) });
  } catch (err: any) {
    console.error('[EdgeQR] start failed:', err);
    res.status(500).json({ error: 'Could not start a QR session' });
  }
});

router.get('/qr/:token', (req: Request, res: Response) => {
  const guest = activeGuest(req.params.token as string);
  if (!guest) return res.status(404).json({ error: 'QR session not found' });
  getDatabase().prepare('UPDATE qr_guest_sessions SET last_seen_at = ? WHERE token = ?').run(now(), guest.token);
  const session = getDatabase().prepare('SELECT * FROM table_sessions WHERE id = ?').get(guest.table_session_id) as TableSession;
  res.json({ menu: menuPayload(), session: sessionBrief(session) });
});

router.post('/qr/:token/orders', (req: Request, res: Response) => {
  try {
    const guest = activeGuest(req.params.token as string);
    if (!guest) return res.status(404).json({ error: 'QR session not found' });
    if (guest.session_status !== 'OPEN') return res.status(409).json({ error: 'This table is no longer accepting orders' });

    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });
    if (items.length > MAX_GUEST_ITEMS) return res.status(400).json({ error: `A single order cannot exceed ${MAX_GUEST_ITEMS} items` });

    const db = getDatabase();
    const result = withTxn(() => {
      const built = buildOrder(db, {
        type: 'dine_in',
        table_id: guest.table_id,
        items: items.map((it: any) => ({
          product_id: it.product_id, quantity: it.quantity, addons: it.addons, special_instructions: it.special_instructions ?? null,
        })),
      });
      linkOrderToSession(built.orderId, guest.table_session_id, { source: 'QR_LOCAL', actor_type: 'GUEST' });
      db.prepare('UPDATE qr_guest_sessions SET last_seen_at = ? WHERE token = ?').run(now(), guest.token);
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(built.orderId);
      return { order, orderItems: built.orderItems };
    });

    notifyKdsUpdate();
    cloudSync.recordOrderChanged((result.order as any).id, 'order.created');
    res.status(201).json({ order: Object.assign({}, result.order, { items: result.orderItems }) });
  } catch (error: any) {
    console.error('[EdgeQR] guest order failed:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not place the order' });
  }
});

export const edgeQrRoutes = router;
