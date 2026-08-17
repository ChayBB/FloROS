'use client';

import { useCallback, useState } from 'react';
import { KdsHeader } from '@/components/kds/KdsHeader';
import { KdsKanbanBoard } from '@/components/kds/KdsKanbanBoard';
import { KdsTabsView } from '@/components/kds/KdsTabsView';
import { useKdsView } from '@/hooks/useKdsView';
import { useKdsAnnouncer } from '@/hooks/useKdsAnnouncer';
import type { UseKdsConnectionResult } from '@/hooks/useKdsConnection';

const TTS_STORAGE_KEY = 'flocafe:kds-tts';

export function KdsWorkspace({ conn, serverDefault }: { conn: UseKdsConnectionResult; serverDefault: 'tabs' | 'kanban' | null }) {
  const { viewMode, setViewMode } = useKdsView(serverDefault);

  // Spoken announcements are a per-screen preference — a busy line wants sound,
  // a prep station may not — so it lives in localStorage, not server settings.
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(
    () => typeof window !== 'undefined' && (() => { try { return window.localStorage.getItem(TTS_STORAGE_KEY) === '1'; } catch { return false; } })(),
  );

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
