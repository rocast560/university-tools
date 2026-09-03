import { expect, test } from 'vitest';
import { SnapshotBroker } from './snapshots';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

test('no windows: null at once', async () => {
  const broker = new SnapshotBroker(() => [], 50);
  expect(await broker.request('s', 100, 75)).toBeNull();
});

test('first window answer wins; unknown ids are ignored', async () => {
  const sent: { type: string; id: string }[] = [];
  const broker = new SnapshotBroker(() => [{ send: (m) => sent.push(m as { type: string; id: string }) }], 500);
  const p = broker.request('s', 100, 75);
  expect(sent[0].type).toBe('snapshot_request');
  expect(broker.resolve('nope', PNG)).toBe(false);
  expect(broker.resolve(sent[0].id, PNG)).toBe(true);
  expect(broker.resolve(sent[0].id, PNG)).toBe(false);
  expect(Array.from((await p)!)).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

test('silent window: null after the timeout', async () => {
  const broker = new SnapshotBroker(() => [{ send: () => {} }], 30);
  expect(await broker.request('s', 100, 75)).toBeNull();
});
