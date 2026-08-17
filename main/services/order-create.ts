// Shared order-creation core. Extracted from POST /api/orders so every channel
// — staff POS, staff-assisted, and Local QR guest ordering — builds orders
// through one code path (tax, inventory, add-ons, totals). Callers own their own
// concerns before/after: input validation, idempotency, session linking,
// notifications.
import Database from 'better-sqlite3';
import {
  generateOrderNumber, now, parseRowJson, parseItemJson,
  insertOrderItemAddons, attachEffectiveAddons,
} from '../db';
import {
  calculateConfiguredChargeTaxes,
  calculateItemTax,
  combineItemAndChargeTaxes,
  getConfiguredChargeTaxCategories,
} from './tax';

export interface OrderItemInput {
  product_id: string;
  quantity: number;
  addons?: any[];
  variant_selection?: unknown;
  modifier_selection?: unknown;
  special_instructions?: string | null;
}

export interface BuildOrderInput {
  type: string;
  table_id?: string | null;
  customer_id?: string | null;
  user_id?: string | null;
  guest_count?: number | null;
  special_instructions?: string | null;
  packaging_charge?: number;
  delivery_charge?: number;
  items: OrderItemInput[];
}

export interface BuiltOrder {
  orderId: number;
  order: any;
  orderItems: any[];
}

/**
 * Insert an order and its items, price it (item + charge taxes), decrement
 * inventory, and return the persisted order. Must be called inside a
 * transaction by the caller. Throws on missing product or insufficient stock.
 */
export function buildOrder(db: Database.Database, input: BuildOrderInput): BuiltOrder {
  const {
    type, table_id, customer_id, user_id, guest_count,
    special_instructions, packaging_charge, delivery_charge, items,
  } = input;

  const orderNumber = generateOrderNumber();

  const settings: Record<string, string> = {};
  db.prepare('SELECT key, value FROM settings').all().forEach((row: any) => {
    settings[row.key] = row.value;
  });

  const tenantInfo = {
    country: settings.country || 'IN',
    business_type: settings.business_type || 'restaurant',
    state_code: settings.state_code || '',
    taxes_enabled: settings.taxes_enabled === 'true',
  };
  const chargeCategories = getConfiguredChargeTaxCategories(tenantInfo.country);
  const chargeContext = {
    packaging_charge: packaging_charge || 0,
    delivery_charge: delivery_charge || 0,
    service_charge: 0,
    packaging_tax_category_id: chargeCategories.packaging?.categoryId || null,
    delivery_tax_category_id: chargeCategories.delivery?.categoryId || null,
    service_charge_tax_category_id: chargeCategories.service_charge?.categoryId || null,
  };

  const orderResult = db.prepare(`
    INSERT INTO orders (order_number, table_id, customer_id, user_id, type, guest_count, special_instructions,
      packaging_charge, delivery_charge, packaging_tax_category_id, delivery_tax_category_id,
      service_charge_tax_category_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(orderNumber, table_id || null, customer_id || null, user_id || null, type, guest_count || null,
    special_instructions || null, packaging_charge || 0, delivery_charge || 0,
    chargeContext.packaging_tax_category_id, chargeContext.delivery_tax_category_id,
    chargeContext.service_charge_tax_category_id, now(), now());

  const orderId = Number(orderResult.lastInsertRowid);

  let subtotal = 0;
  let totalTax = 0;
  let exclusiveTax = 0;
  const allTaxBreakdowns: any[] = [];
  const allTaxSnapshots: (string | null)[] = [];
  const customer = customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id) as any : null;

  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, product_sku, unit_price, quantity, inventory_deducted_quantity,
      subtotal, tax_amount, tax_breakdown, tax_snapshot, tax_type, discount_amount, total, variant_selection,
      modifier_selection, special_instructions, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) as any;
    if (!product) throw new Error(`Product ${item.product_id} not found`);
    if (product.track_inventory && product.stock_quantity < item.quantity) {
      throw new Error(`Insufficient stock for ${product.name}`);
    }

    const unitPrice = parseFloat(product.price);
    const quantity = item.quantity;
    const itemDiscount = 0;

    if (!quantity || quantity <= 0 || !Number.isFinite(quantity)) {
      throw new Error(`Invalid quantity for ${product.name}: must be a positive number`);
    }
    if (unitPrice < 0 || !Number.isFinite(unitPrice)) {
      throw new Error(`Invalid price for ${product.name}: must be a non-negative number`);
    }

    let itemSubtotal = unitPrice * quantity;
    if (item.addons && Array.isArray(item.addons)) {
      for (const addon of item.addons) {
        if (!addon) continue;
        if (addon.quantity !== undefined) {
          if (typeof addon.quantity !== 'number' || !Number.isInteger(addon.quantity) || addon.quantity <= 0) {
            throw new Error(`Invalid add-on quantity for ${addon.name || 'addon'}: must be a positive integer`);
          }
        }
        const addonQty = addon.quantity || 1;
        itemSubtotal += (addon.price || 0) * addonQty * quantity;
      }
    }
    itemSubtotal = Math.max(0, itemSubtotal - itemDiscount);

    const taxResult = calculateItemTax(tenantInfo, product, itemSubtotal, customer);

    totalTax += taxResult.tax_amount;
    if (taxResult.tax_type !== 'inclusive') exclusiveTax += taxResult.tax_amount;
    if (taxResult.tax_breakdown) allTaxBreakdowns.push(taxResult.tax_breakdown);
    const itemTaxSnapshotJson = taxResult.tax_snapshot ? JSON.stringify(taxResult.tax_snapshot) : null;
    allTaxSnapshots.push(itemTaxSnapshotJson);

    const itemTotal = itemSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount);
    subtotal += itemSubtotal;

    const itemCreatedAt = now();
    const insertItemResult = insertItem.run(
      orderId, product.id, product.name, product.sku, unitPrice, quantity, product.track_inventory ? quantity : 0,
      itemSubtotal, taxResult.tax_amount, JSON.stringify(taxResult.tax_breakdown), itemTaxSnapshotJson,
      taxResult.tax_type, itemDiscount, itemTotal,
      JSON.stringify(item.variant_selection || null),
      JSON.stringify(item.modifier_selection || null),
      item.special_instructions || null, itemCreatedAt, itemCreatedAt
    );
    insertOrderItemAddons(db, insertItemResult.lastInsertRowid, item.addons, itemCreatedAt);

    if (product.track_inventory) {
      db.prepare('UPDATE products SET stock_quantity = stock_quantity - ?, updated_at = ? WHERE id = ?')
        .run(quantity, now(), product.id);
    }
  }

  const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, chargeContext, customer);
  const taxRollup = combineItemAndChargeTaxes({
    itemTaxAmount: totalTax,
    itemExclusiveTaxAmount: exclusiveTax,
    itemBreakdowns: allTaxBreakdowns,
    itemSnapshots: allTaxSnapshots,
    itemTaxRatio: 1,
    chargeTaxes,
  });
  const preRoundTotal = subtotal + taxRollup.exclusiveTaxAmount + (delivery_charge || 0) + (packaging_charge || 0);
  const total = Number(preRoundTotal.toFixed(2));
  const roundOff = 0;

  db.prepare(`
    UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, total = ?,
      round_off = ?, updated_at = ? WHERE id = ?
  `).run(subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, total, roundOff, now(), orderId);

  if (table_id && type === 'dine_in') {
    db.prepare("UPDATE tables SET status = 'occupied', updated_at = ? WHERE id = ?").run(now(), table_id);
  }

  const order = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)) as any;
  const orderItems = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[]);
  return { orderId, order, orderItems };
}
