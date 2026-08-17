/**
 * Integration: session billing, staff selector, close-on-settle (slices 1-3).
 * Usage: node tests/run-electron-node-test.cjs tests/table-session-billing.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tsession-bill-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct, api, assert, assertEqual, getResults, closeDatabase } = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { tableSessionRoutes } = require('../main/routes/table-sessions');

async function main() {
  console.log('Integration: Session Billing\n' + '='.repeat(50));
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-b', 'Menu');
  seedProduct(db, 'prod-b1', 'cat-b', 'Burger', 200, {});
  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes, '/api/table-sessions': tableSessionRoutes });
  const { baseUrl } = await startServer(app);
  const order = (tableId: string, extra: any = {}) => api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', table_id: tableId, items: [{ product_id: 'prod-b1', quantity: 1 }], ...extra }, headers: authHeader });
  const payOrder = async (orderId: number) => {
    const bill = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: orderId }, headers: authHeader });
    return api(baseUrl, `/api/bills/${bill.data.bill.id}/payment`, { method: 'POST', body: { method: 'cash', amount: bill.data.bill.total }, headers: authHeader });
  };
  try {
    console.log('\n1. two orders, selector, provenance');
    const o1 = (await order('T30')).data.order.id;
    const o2 = (await order('T30', { on_behalf_of_guest: true })).data.order.id;
    const sel = await api(baseUrl, '/api/table-sessions/select', { method: 'POST', body: { table_id: 'T30' }, headers: authHeader });
    assertEqual(sel.status, 200, 'selector 200');
    const sessionId = sel.data.session.id;
    assertEqual(sel.data.orders.length, 2, 'two orders');
    const sources = db.prepare('SELECT source FROM orders WHERE id IN (?, ?) ORDER BY id').all(o1, o2).map((r: any) => r.source);
    assertEqual(JSON.stringify(sources), JSON.stringify(['POS_LOCAL', 'STAFF_LOCAL']), 'POS_LOCAL + STAFF_LOCAL');

    console.log('\n2. merged bill');
    const t = (await api(baseUrl, `/api/table-sessions/${sessionId}`, { headers: authHeader })).data.totals;
    assert(t.total > 0, 'total>0'); assertEqual(t.paid, 0, 'paid 0'); assertEqual(t.balance, t.total, 'balance=total');

    console.log('\n3. close only when all paid');
    await payOrder(o1);
    assertEqual(db.prepare('SELECT status FROM table_sessions WHERE id = ?').get(sessionId).status, 'OPEN', 'still OPEN');
    await payOrder(o2);
    assertEqual(db.prepare('SELECT status FROM table_sessions WHERE id = ?').get(sessionId).status, 'CLOSED', 'CLOSED');
    assert(!!db.prepare('SELECT closed_at FROM table_sessions WHERE id = ?').get(sessionId).closed_at, 'closed_at set');
    assertEqual((await api(baseUrl, `/api/table-sessions/${sessionId}`, { headers: authHeader })).data.totals.balance, 0, 'balance 0');

    console.log('\n4. reopen fresh');
    const o3 = (await order('T30')).data.order.id;
    assert(db.prepare('SELECT table_session_id FROM orders WHERE id = ?').get(o3).table_session_id !== sessionId, 'new session');

    console.log('\n' + '='.repeat(50));
    const r = getResults(); console.log(`Results: ${r.passed}/${r.total} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  } catch (e: any) { console.error('crashed', e.message, e.stack); process.exit(1); }
  finally { closeDatabase(); }
}
main();
