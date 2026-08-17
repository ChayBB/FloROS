// Admin observability for the Branch Edge: which local devices are attached and
// how far behind the cloud the outbox is. Authenticated (owner/manager), unlike
// the guest QR gateway.
import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { listEdgeDevices, registerEdgeDevice, edgeSyncStatus, type EdgeDeviceKind } from '../services/edge-sync';

const router = Router();
const VALID_KINDS: EdgeDeviceKind[] = ['POS', 'KDS', 'PRINTER_AGENT', 'QR_GATEWAY'];

router.get('/status', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  res.json({ devices: listEdgeDevices(), sync: edgeSyncStatus() });
});

router.get('/devices', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  res.json({ devices: listEdgeDevices() });
});

router.post('/devices', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const { id, kind, label } = req.body || {};
  if (!id || !VALID_KINDS.includes(kind)) {
    return res.status(400).json({ error: `id and a valid kind (${VALID_KINDS.join(', ')}) are required` });
  }
  registerEdgeDevice(String(id), kind, label ? String(label) : undefined);
  res.status(201).json({ ok: true });
});

export const edgeAdminRoutes = router;
