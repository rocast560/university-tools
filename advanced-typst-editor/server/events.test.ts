import { describe, it, expect } from 'vitest';
import { createEventBus } from './events';

describe('event bus', () => {
  it('delivers to every subscriber and drops throwing ones', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    bus.subscribe(() => { throw new Error('boom'); });
    bus.emit({ type: 'workspaces.changed' });
    bus.emit({ type: 'workspaces.changed' });
    expect(seen).toEqual(['workspaces.changed', 'workspaces.changed']);
    expect(bus.size).toBe(1);
  });
});
