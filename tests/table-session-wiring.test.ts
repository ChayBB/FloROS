/**
 * Integration: POST /api/orders wires dine-in orders into the Table Session Engine.
 * Usage: node tests/run-electron-node-test.cjs tests/table-session-wiring.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tsession-wire-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct, api, assert, assertEqual, getResults, closeDatabase } = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');

async function main() {
  console.log('Integration: Table Session wiring\n' + '='.repeat(50));
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-wire', 'Menu');
  seedProduct(db, 'prod-w', 'cat-wire', 'Burger', 200, {});
  const app = createApp({ '/api/orders': orderRoutes });
  const { baseUrl } = await startServer(app);
  const makeOrder = (type: string, tableId?: string) => api(baseUrl, '/api/orders', { method: 'POST', body: { type, table_id: tableId, items: [{ product_id: 'prod-w', quantity: 1 }] }, headers: authHeader });
  try {
    console.log('\n1. dine-in links to session');
    const r1 = await makeOrder('dine_in', 'T20');
    assertEqual(r1.status, 201, '201');
    const id1 = r1.data.order.id;
    const row1 = db.prepare('SELECT table_session_id, source, actor_type, created_by_staff_id FROM orders WHERE id = ?').get(id1);
    assert(!!row1.table_session_id, 'has session'); assertEqual(row1.source, 'POS_LOCAL', 'POS_LOCAL'); assertEqual(row1.actor_type, 'STAFF', 'STAFF'); assert(!!row1.created_by_staff_id, 'staff set');
    assertEqual(db.prepare('SELECT status FROM table_sessions WHERE id = ?').get(row1.table_session_id).status, 'OPEN', 'OPEN');

    console.log('\n2. fan-in same table');
    const r2 = await makeOrder('dine_in', 'T20');
    assertEqual(db.prepare('SELECT table_session_id FROM orders WHERE id = ?').get(r2.data.order.id).table_session_id, row1.table_session_id, 'shared session');
    assertEqual(db.prepare("SELECT COUNT(*) AS c FROM table_sessions WHERE table_id='T20' AND status='OPEN'").get().c, 1, 'one OPEN');

    console.log('\n3. different table = own session');
    const r3 = await makeOrder('dine_in', 'T21');
    assert(db.prepare('SELECT table_session_id FROM orders WHERE id = ?').get(r3.data.order.id).table_session_id !== row1.table_session_id, 'different');

    console.log('\n4. takeaway no session');
    const r4 = await makeOrder('takeaway');
    const row4 = db.prepare('SELECT table_session_id, source FROM orders WHERE id = ?').get(r4.data.order.id);
    assertEqual(row4.table_session_id, null, 'no session'); assertEqual(row4.source, null, 'no source');

    console.log('\n' + '='.repeat(50));
    const r = getResults(); console.log(`Results: ${r.passed}/${r.total} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  } catch (e: any) { console.error('crashed', e.message, e.stack); process.exit(1); }
  finally { closeDatabase(); }
}
main();
