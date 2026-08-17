// Pure, framework-free core of the KDS announcer, split out so the
// new-order-detection and phrasing logic can be unit-tested without React or a
// browser speech engine. The hook (useKdsAnnouncer) wires these into effects.

export interface AnnouncerOrder {
  id: number;
  order_number?: string;
  table?: { name: string } | null;
  items?: { quantity: number; product_name: string }[] | null;
}

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Build the spoken phrase for one order. */
export function describeOrder(order: AnnouncerOrder, t: Translate): string {
  const items = (order.items ?? []).map((item) => `${item.quantity} ${item.product_name}`).join(', ');
  const where = order.table?.name ? t('kds.ttsTableLabel', { table: order.table.name }) : (order.order_number || '');
  return t('kds.ttsNewOrder', { where, items });
}

/**
 * Return the orders not yet announced and record them as seen. Mutating `seen`
 * keeps callers simple; pass a fresh Set to replay. When `enabled` is false the
 * orders are still marked seen (so re-enabling never replays a backlog) but none
 * are returned to speak.
 */
export function pickNewOrders(orders: AnnouncerOrder[], seen: Set<number>, enabled: boolean): AnnouncerOrder[] {
  const fresh = orders.filter((o) => !seen.has(o.id));
  for (const o of fresh) seen.add(o.id);
  return enabled ? fresh : [];
}
