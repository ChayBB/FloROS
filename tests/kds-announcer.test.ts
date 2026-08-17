/**
 * Test: KDS announcer core (new-order detection + phrasing).
 * Framework-free logic behind the spoken KDS announcements.
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/kds-announcer.test.ts
 */
import assert from 'node:assert/strict';
import { describeOrder, pickNewOrders, type AnnouncerOrder } from '../frontend/src/hooks/kds-announcer-core';

// Minimal t() that interpolates {name} placeholders, like the real translator.
const t = (key: string, params?: Record<string, string | number>) => {
  const templates: Record<string, string> = {
    'kds.ttsNewOrder': 'New order, {where}. {items}',
    'kds.ttsTableLabel': 'table {table}',
  };
  let s = templates[key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  return s;
};

let passed = 0;
const check = (cond: boolean, msg: string) => { assert.ok(cond, msg); console.log('  ✓ ' + msg); passed++; };

console.log('Test: KDS announcer core\n' + '='.repeat(50));

// 1. phrasing with a table
console.log('\n1. describeOrder');
const o1: AnnouncerOrder = { id: 1, table: { name: '5' }, items: [{ quantity: 2, product_name: 'Burger' }, { quantity: 1, product_name: 'Coke' }] };
check(describeOrder(o1, t) === 'New order, table 5. 2 Burger, 1 Coke', 'table + items phrase');
const o2: AnnouncerOrder = { id: 2, order_number: 'ORD-9', items: [{ quantity: 1, product_name: 'Tea' }] };
check(describeOrder(o2, t) === 'New order, ORD-9. 1 Tea', 'falls back to order number');

// 2. new-order detection
console.log('\n2. pickNewOrders (enabled)');
const seen = new Set<number>();
let fresh = pickNewOrders([o1, o2], seen, true);
check(fresh.length === 2, 'both new the first time');
fresh = pickNewOrders([o1, o2], seen, true);
check(fresh.length === 0, 'nothing new the second time');
const o3: AnnouncerOrder = { id: 3, items: [] };
fresh = pickNewOrders([o1, o2, o3], seen, true);
check(fresh.length === 1 && fresh[0].id === 3, 'only the genuinely new order');

// 3. muted marks-seen so re-enabling never replays a backlog
console.log('\n3. pickNewOrders (muted)');
const seen2 = new Set<number>();
pickNewOrders([o1], seen2, false); // primed elsewhere; here first pass
let mutedFresh = pickNewOrders([o1, o2], seen2, false);
check(mutedFresh.length === 0, 'muted returns nothing to speak');
const afterUnmute = pickNewOrders([o1, o2], seen2, true);
check(afterUnmute.length === 0, 're-enabling does not replay orders seen while muted');
const o4: AnnouncerOrder = { id: 4, items: [] };
const speakO4 = pickNewOrders([o1, o2, o4], seen2, true);
check(speakO4.length === 1 && speakO4[0].id === 4, 'a new order after unmute is announced');

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed}/${passed} passed, 0 failed`);
process.exit(0);
