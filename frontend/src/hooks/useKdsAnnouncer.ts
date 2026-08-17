'use client';

import { useEffect, useRef } from 'react';
import { useI18n } from '@/hooks/useI18n';
import type { Language } from '@/lib/i18n';
import type { KdsOrder } from '@/hooks/useKdsConnection';

const SPEECH_LANG: Record<Language, string> = {
  en: 'en-US', es: 'es-ES', pt: 'pt-BR', fa: 'fa-IR', th: 'th-TH',
};

function speak(text: string, language: Language): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = SPEECH_LANG[language] ?? 'en-US';
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  } catch {
    // A speech failure must never disrupt the kitchen display.
  }
}

/**
 * Speaks each newly-arrived KDS order aloud so kitchen staff hear tickets
 * without watching the screen. Browser speech synthesis — no backend. Only
 * genuinely new orders are announced: the first on-screen batch is seeded
 * silently, and while muted, incoming orders are marked seen so re-enabling
 * never dumps a backlog.
 */
export function useKdsAnnouncer(orders: KdsOrder[], enabled: boolean): void {
  const { t, language } = useI18n();
  const announced = useRef<Set<number>>(new Set());
  const primed = useRef(false);

  useEffect(() => {
    if (!enabled && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, [enabled]);

  useEffect(() => {
    if (!primed.current) {
      for (const order of orders) announced.current.add(order.id);
      primed.current = true;
      return;
    }
    if (!enabled) {
      for (const order of orders) announced.current.add(order.id);
      return;
    }
    for (const order of orders) {
      if (announced.current.has(order.id)) continue;
      announced.current.add(order.id);
      speak(describeOrder(order, t), language);
    }
  }, [orders, enabled, language, t]);
}

function describeOrder(order: KdsOrder, t: (key: string, params?: Record<string, string | number>) => string): string {
  const items = (order.items ?? []).map((item) => `${item.quantity} ${item.product_name}`).join(', ');
  const where = order.table?.name ? t('kds.ttsTableLabel', { table: order.table.name }) : (order.order_number || '');
  return t('kds.ttsNewOrder', { where, items });
}
