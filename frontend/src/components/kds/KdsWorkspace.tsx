'use client';

import { useCallback, useState } from 'react';
import { KdsHeader } from '@/components/kds/KdsHeader';
import { KdsKanbanBoard } from '@/components/kds/KdsKanbanBoard';
import { KdsTabsView } from '@/components/kds/KdsTabsView';
import { useKdsView } from '@/hooks/useKdsView';
import { useKdsAnnouncer } from '@/hooks/useKdsAnnouncer';
import type { UseKdsConnectionResult } from '@/hooks/useKdsConnection';

const TTS_STORAGE_KEY = 'flocafe:kds-tts';

export function KdsWorkspace({ conn, serverDefault, ttsDefault = false }: { conn: UseKdsConnectionResult; serverDefault: 'tabs' | 'kanban' | null; ttsDefault?: boolean }) {
  const { viewMode, setViewMode } = useKdsView(serverDefault);

  // Announcements have a server-side default (Settings → Kitchen Display, all
  // screens) that each screen can override locally: an explicit '1'/'0' in
  // localStorage wins; otherwise the screen follows the server default.
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return ttsDefault;
    try {
      const stored = window.localStorage.getItem(TTS_STORAGE_KEY);
      return stored === null ? ttsDefault : stored === '1';
    } catch { return ttsDefault; }
  });

  const toggleTts = useCallback(() => {
    setTtsEnabled((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(TTS_STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useKdsAnnouncer(conn.orders, ttsEnabled);

  return (
    <div data-testid="kds-workspace" className="h-full flex flex-col">
      <KdsHeader
        userName={conn.user!.name}
        userRole={conn.user!.role}
        connected={conn.connected}
        connectionMode={conn.connectionMode}
        viewMode={viewMode}
        onChangeView={setViewMode}
        onLogout={conn.handleLogout}
        ttsEnabled={ttsEnabled}
        onToggleTts={toggleTts}
      />
      <div className="flex-1 min-h-0 flex flex-col">
        {viewMode === 'kanban' ? (
          <KdsKanbanBoard orders={conn.orders} updating={conn.updating} updateItemStatus={conn.updateItemStatus} />
        ) : (
          <KdsTabsView
            orders={conn.orders}
            updating={conn.updating}
            updateItemStatus={conn.updateItemStatus}
          />
        )}
      </div>
      {conn.ConfirmDialog}
    </div>
  );
}
