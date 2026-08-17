/**
 * Test: Edge Sync — session events with monotonic sequence + device registry.
 * Usage: node tests/run-electron-node-test.cjs tests/edge-sync.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-edge-sync-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, getResults, closeDatabase, assert, assertEqual } = require('./helpers/test-setup');
const { openOrGetSession, closeSession } = require('../main/services/table-session');
const { registerEdgeDevice, touchEdgeDevice, listEdgeDevices, edgeSyncStatus } = require('../main/services/edge-sync');

function outboxEvents(db: any) {
  return db.prepare("SELECT event_type, entity_id, event_seq FROM cloud_sync_outbox WHERE entity_type = 'table_session' ORDER BY event_seq").all();
}

async function main() {
  console.log('Test: Edge Sync\n' + '='.repeat(50));
  const db = initTestDb();
  try {
    console.log('\n1. cloud off -> no buffering');
    db.prepare("UPDATE settings SET value='0' WHERE key='cloud_sync_enabled'").run();
    const s0 = openOrGetSession('T50', 'STAFF');
    assertEqual(outboxEvents(db).length, 0, 'nothing buffered');
    closeSession(s0.id);

    console.log('\n2. cloud on -> monotonic events');
    db.prepare("UPDATE settings SET value='1' WHERE key='cloud_sync_enabled'").run();
    const s1 = openOrGetSession('T51', 'STAFF');
    let ev = outboxEvents(db);
    assertEqual(ev.length, 1, 'one after open'); assertEqual(ev[0].event_type, 'session.opened', 'opened'); assertEqual(ev[0].entity_id, s1.id, 'names session');
    const firstSeq = ev[0].event_seq; assert(firstSeq >= 1, 'seq>=1');
    closeSession(s1.id);
    ev = outboxEvents(db);
    assertEqual(ev.length, 2, 'two after close'); assertEqual(ev[1].event_type, 'session.closed', 'closed'); assert(ev[1].event_seq > firstSeq, 'monotonic');

    console.log('\n3. idempotency key');
    const p = JSON.parse(db.prepare("SELECT payload FROM cloud_sync_outbox WHERE entity_type='table_session' ORDER BY event_seq LIMIT 1").get().payload);
    assert(typeof p.idempotency_key === 'string' && p.idempotency_key.length > 0, 'idempotency_key'); assert(p.event_seq === firstSeq, 'echoes seq');

    console.log('\n4. device registry');
    registerEdgeDevice('kds-1', 'KDS', 'Kitchen'); registerEdgeDevice('pos-1', 'POS', 'Counter');
    assertEqual(listEdgeDevices().length, 2, 'two devices');
    assertEqual(listEdgeDevices().find((d: any) => d.id === 'kds-1').kind, 'KDS', 'kind');
    registerEdgeDevice('kds-1', 'KDS', 'Kitchen v2');
    assertEqual(listEdgeDevices().length, 2, 'upsert not dup');
    assertEqual(listEdgeDevices().find((d: any) => d.id === 'kds-1').label, 'Kitchen v2', 'label updated');
    const before = listEdgeDevices().find((d: any) => d.id === 'pos-1').last_seen_at;
    touchEdgeDevice('pos-1');
    assert(listEdgeDevices().find((d: any) => d.id === 'pos-1').last_seen_at >= before, 'touch');

    console.log('\n5. sync status');
    const st = edgeSyncStatus();
    assert(st.last_seq >= ev[1].event_seq, 'last_seq'); assert(st.pending >= 2, 'pending');

    console.log('\n' + '='.repeat(50));
    const r = getResults(); console.log(`Results: ${r.passed}/${r.total} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  } catch (e: any) { console.error('crashed', e.message, e.stack); process.exit(1); }
  finally { closeDatabase(); }
}
main();
