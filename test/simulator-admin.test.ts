import { describe, expect, it } from 'vitest';
import { SettlementSimulator } from '../src/infrastructure/simulator/settlement-simulator.js';
import { startSimulatorAdminServer } from '../src/infrastructure/simulator/admin-server.js';

describe('separate simulator administration surface', () => {
  it('lists scenarios and changes the snapshot through strict JSON', async () => {
    const simulator = new SettlementSimulator(() => 1_000_000);
    const admin = await startSimulatorAdminServer(simulator, { port: 0 });
    const root = `http://127.0.0.1:${admin.port}`;
    try {
      expect(await (await fetch(`${root}/scenarios`)).json()).toEqual({
        active: 'normal', scenarios: ['normal', 'settlement_failure', 'low_sample'],
      });
      const changed = await fetch(`${root}/scenario`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"scenario":"settlement_failure"}' });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({ active: 'settlement_failure' });
      expect(simulator.exposition()).toContain('outcome="failure"} 15');
      const configuredFault = await fetch(`${root}/source-fault`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"failures":9}',
      });
      expect(configuredFault.status).toBe(200);
      expect(await configuredFault.json()).toEqual({ remainingFailures: 9 });
      expect(simulator.consumeSourceFailure()).toBe(true);
      expect(simulator.remainingSourceFailures()).toBe(8);
    } finally { await admin.close(); }
  });
  it('rejects invalid scenarios, methods and browser origins without mutating state', async () => {
    const simulator = new SettlementSimulator(() => 1_000_000);
    const admin = await startSimulatorAdminServer(simulator, { port: 0 });
    const root = `http://127.0.0.1:${admin.port}`;
    try {
      expect((await fetch(`${root}/scenario`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"scenario":"unknown"}' })).status).toBe(400);
      expect((await fetch(`${root}/scenario`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${root}/scenarios`, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
      expect(simulator.exposition()).toContain('outcome="failure"} 0');
      expect((await fetch(`${root}/source-fault`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"failures":-1}',
      })).status).toBe(400);
      expect(simulator.remainingSourceFailures()).toBe(0);
    } finally { await admin.close(); }
  });
});
