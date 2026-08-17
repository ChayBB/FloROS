/**
 * Test: whole-menu bundle import/export (single multi-section CSV).
 * Usage: node tests/run-electron-node-test.cjs tests/menu-bundle.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-menu-bundle-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, createApp, startServer, seedOwnerUser, api, assert, assertEqual, getResults, closeDatabase } = require('./helpers/test-setup');
const { menuCsvRoutes } = require('../main/routes/menu-csv');

async function main() {
  console.log('Test: Menu bundle\n' + '='.repeat(50));
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const app = createApp({ '/api/menu/csv': menuCsvRoutes });
  const { baseUrl } = await startServer(app);
  const getCsv = async (urlPath: string) => { const r = await (globalThis as any).fetch(baseUrl + urlPath, { headers: authHeader }); return { status: r.status, text: await r.text() }; };
  try {
    console.log('\n1. combined template');
    const tpl = await getCsv('/api/menu/csv/template/menu');
    assertEqual(tpl.status, 200, '200');
    for (const s of ['#SECTION,categories', '#SECTION,products', '#SECTION,addons']) assert(tpl.text.includes(s), `has ${s}`);

    console.log('\n2. one bundle populates all');
    const bundle = [
      '#SECTION,categories', 'name,description,color,icon,sort_order', 'Drinks,Cold and hot,blue,,1', '',
      '#SECTION,products', 'id,sku,name,category,price,description,cost,tax_category,tax_behavior,cashback_percent,tags,is_active',
      ',,Latte,Drinks,120,,40,,,,,yes', ',,Mocha,Drinks,140,,50,,,,,yes', '',
      '#SECTION,addons', 'group_name,addon_name,price,group_required,group_min_select,group_max_select', 'Size,Small,0,no,1,1', 'Size,Large,30,no,1,1',
    ].join('\n');
    const imp = await api(baseUrl, '/api/menu/csv/import/menu', { method: 'POST', body: { csv: bundle }, headers: authHeader });
    assertEqual(imp.status, 200, '200');
    assertEqual(imp.data.sections.categories.created, 1, '1 category');
    assertEqual(imp.data.sections.products.created, 2, '2 products');
    assertEqual(imp.data.sections.addons.addons_created, 2, '2 addons');
    assertEqual(imp.data.totals.failed, 0, 'no failures');

    console.log('\n3. dependency order');
    assertEqual(db.prepare(`SELECT c.name FROM products p JOIN categories c ON p.category_id = c.id WHERE p.name = 'Latte'`).get().name, 'Drinks', 'Latte under Drinks');

    console.log('\n4. export round-trips');
    const exp = await getCsv('/api/menu/csv/export/menu');
    assert(exp.text.includes('#SECTION,products') && exp.text.includes('Latte'), 'export ok');
    const re = await api(baseUrl, '/api/menu/csv/import/menu', { method: 'POST', body: { csv: exp.text }, headers: authHeader });
    assertEqual(re.status, 200, 're-import 200');
    assertEqual(re.data.sections.categories.skipped, 1, 'category skipped');
    assertEqual(re.data.totals.failed, 0, 'no failures');
    assertEqual(db.prepare("SELECT COUNT(*) c FROM products WHERE deleted_at IS NULL").get().c, 2, 'no dup products');

    console.log('\n5. malformed rejected');
    assertEqual((await api(baseUrl, '/api/menu/csv/import/menu', { method: 'POST', body: { csv: 'just,rows\n1,2' }, headers: authHeader })).status, 400, '400');

    console.log('\n' + '='.repeat(50));
    const r = getResults(); console.log(`Results: ${r.passed}/${r.total} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  } catch (e: any) { console.error('crashed', e.message, e.stack); process.exit(1); }
  finally { closeDatabase(); }
}
main();
