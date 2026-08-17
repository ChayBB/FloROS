/**
 * Test: Table Session Engine
 * Usage: node tests/run-electron-node-test.cjs tests/table-session.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tsession-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, getResults, closeDatabase, assert, assertEqual } = require('./helpers/test-setup');
const {
  openOrGetSession, joinSession, leaveSession, linkOrderToSession,
  getSessionOrders, getSessionTotal, lockSession, closeSession,
} = require('../main/services/table-session');

let orderSeq = 0;
function insertOrder(db: any, total: number, status = 'pending'): number {
  const res = db.prepare(`INSERT INTO orders (order_number, table_id, status, total) VALUES (?, ?, ?, ?)`)
    .run(`ORD-T-${++orderSeq}`, 'T12', status, total);
  return Number(res.lastInsertRowid);
}

async function main() {
  console.log('Test: Table Session Engine\n' + '='.repeat(50));
  const db = initTestDb();
  try {
    console.log('\n1. tables exist');
    const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('table_sessions','table_session_members')").all().map((r: any) => r.name).sort();
    assertEqual(JSON.stringify(tbl), JSON.stringify(['table_session_members', 'table_sessions']), 'Both tables present');

    console.log('\n2. one active session per table');
    const s1 = openOrGetSession('T12', 'STAFF');
    const s2 = openOrGetSession('T12', 'GUEST_QR');
    assertEqual(s1.id, s2.id, 'Second open returns same session');
    assert(/^S-\d+$/.test(s1.session_no), 'session_no looks like S-<n>');

    console.log('\n3. guest + staff share session');
    joinSession(s1.id, { member_type: 'GUEST', guest_token: 'g-abc' });
    joinSession(s1.id, { member_type: 'STAFF', staff_id: 'ST001' });
    let members = db.prepare('SELECT COUNT(*) AS c FROM table_session_members WHERE table_session_id = ? AND left_at IS NULL').get(s1.id).c;
    assertEqual(members, 2, 'Two active members');

    console.log('\n4. join idempotent');
    joinSession(s1.id, { member_type: 'GUEST', guest_token: 'g-abc' });
    members = db.prepare('SELECT COUNT(*) AS c FROM table_session_members WHERE table_session_id = ? AND left_at IS NULL').get(s1.id).c;
    assertEqual(members, 2, 'Still two');

    console.log('\n5. billing sums by session');
    const o1 = insertOrder(db, 350), o2 = insertOrder(db, 280), o3 = insertOrder(db, 220), oc = insertOrder(db, 999, 'cancelled');
    linkOrderToSession(o1, s1.id, { source: 'QR_LOCAL', actor_type: 'GUEST' });
    linkOrderToSession(o2, s1.id, { source: 'QR_CLOUD', actor_type: 'GUEST' });
    linkOrderToSession(o3, s1.id, { source: 'STAFF_LOCAL', actor_type: 'STAFF', created_by_staff_id: 'ST001' });
    linkOrderToSession(oc, s1.id, { source: 'POS_LOCAL', actor_type: 'POS' });
    assertEqual(getSessionOrders(s1.id).length, 4, 'Four orders');
    assertEqual(getSessionTotal(s1.id), 850, 'Total 850 (non-cancelled)');
    const so = db.prepare('SELECT source, created_by_staff_id FROM orders WHERE id = ?').get(o3);
    assertEqual(so.source, 'STAFF_LOCAL', 'Staff source'); assertEqual(so.created_by_staff_id, 'ST001', 'Staff attribution');

    console.log('\n6. LOCKED keeps one session; close reopens');
    lockSession(s1.id);
    const wl = openOrGetSession('T12', 'STAFF');
    assertEqual(wl.id, s1.id, 'LOCKED returns same session');
    assertEqual(wl.status, 'LOCKED', 'reports LOCKED');
    closeSession(s1.id);
    const fresh = openOrGetSession('T12', 'STAFF');
    assert(fresh.id !== s1.id, 'new session after close');
    assertEqual(fresh.status, 'OPEN', 'new is OPEN');

    console.log('\n7. leaveSession');
    joinSession(fresh.id, { member_type: 'STAFF', staff_id: 'ST002' });
    leaveSession(fresh.id, { staff_id: 'ST002' });
    assertEqual(db.prepare('SELECT COUNT(*) AS c FROM table_session_members WHERE table_session_id = ? AND left_at IS NULL').get(fresh.id).c, 0, 'no active members');

    console.log('\n' + '='.repeat(50));
    const r = getResults(); console.log(`Results: ${r.passed}/${r.total} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  } catch (e: any) { console.error('crashed', e.message, e.stack); process.exit(1); }
  finally { closeDatabase(); }
}
main();
