/**
 * Test: Local QR Gateway — unauthenticated guest ordering.
 * Usage: node tests/run-electron-node-test.cjs tests/edge-qr.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-edge-qr-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct, api, assert, assertEqual, getResults, closeDatabase } = require('./helpers/test-setup');
const { edgeQrRoutes } = require('../main/routes/edge-qr');

async function main() {
  console.log('Test: Local QR Gateway\n' + '='.repeat(50));
  const db = initTestDb();
  seedOwnerUser(db);
  seedCategory(db, 'cat-qr', 'Drinks');
  seedProduct(db, 'prod-qr', 'cat-qr', 'Iced Tea', 90, {});
  // Guest routes are unauthenticated — mount off /api so the harness auth skips them.
  const app = createApp({ '/edge': edgeQrRoutes });
  const { baseUrl } = await startServer(app);
  try {
    console.log('\n1. scan starts session');
    const start = await api(baseUrl, '/edge/qr/start', { method: 'POST', body: { table_id: 'T40' } });
    assertEqual(start.status, 201, '201'); const token = start.data.token; assert(!!token, 'token'); assertEqual(start.data.session.status, 'OPEN', 'OPEN');
    const sessionId = start.data.session.id;

    console.log('\n2. menu readable');
    const menu = await api(baseUrl, `/edge/qr/${token}`, {});
    assertEqual(menu.status, 200, '200'); assert(menu.data.menu.products.some((p: any) => p.id === 'prod-qr'), 'lists product'); assertEqual(menu.data.session.id, sessionId, 'session');

    console.log('\n3. guest order QR_LOCAL/GUEST');
    const order = await api(baseUrl, `/edge/qr/${token}/orders`, { method: 'POST', body: { items: [{ product_id: 'prod-qr', quantity: 2 }] } });
    assertEqual(order.status, 201, '201');
    const row = db.prepare('SELECT table_session_id, source, actor_type, total FROM orders WHERE id = ?').get(order.data.order.id);
    assertEqual(row.table_session_id, sessionId, 'linked'); assertEqual(row.source, 'QR_LOCAL', 'QR_LOCAL'); assertEqual(row.actor_type, 'GUEST', 'GUEST'); assert(row.total > 0, 'priced');

    console.log('\n4. price server-set');
    const cheat = await api(baseUrl, `/edge/qr/${token}/orders`, { method: 'POST', body: { items: [{ product_id: 'prod-qr', quantity: 1, price: 1, unit_price: 1 }] } });
    assert(db.prepare('SELECT total FROM orders WHERE id = ?').get(cheat.data.order.id).total >= 90, 'server price');

    console.log('\n5. unknown token 404');
    assertEqual((await api(baseUrl, '/edge/qr/nope', {})).status, 404, '404');

    console.log('\n6. empty order 400');
    assertEqual((await api(baseUrl, `/edge/qr/${token}/orders`, { method: 'POST', body: { items: [] } })).status, 400, '400');

    console.log('\n' + '='.repeat(50));
    const r = getResults(); console.log(`Results: ${r.passed}/${r.total} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  } catch (e: any) { console.error('crashed', e.message, e.stack); process.exit(1); }
  finally { closeDatabase(); }
}
main();
