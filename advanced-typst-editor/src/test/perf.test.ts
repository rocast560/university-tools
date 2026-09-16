import { describe, it, expect, beforeEach } from 'vitest';
import { switchTrace } from '@/lib/perf';

beforeEach(() => switchTrace.reset());

describe('switchTrace', () => {
  it('records the first mark of each stage relative to the click and closes on paint', () => {
    switchTrace.start('w1');
    switchTrace.mark('detail');
    switchTrace.mark('detail');
    switchTrace.mark('painted');
    switchTrace.mark('compiled'); // after paint: ignored
    const t = switchTrace.current()!;
    expect(t.id).toBe('w1');
    expect(t.done).toBe(true);
    expect(Object.keys(t.marks)).toEqual(['detail', 'painted']);
    expect(t.marks.detail).toBeGreaterThanOrEqual(0);
  });

  it('starts a fresh trace per switch and keeps the last twenty', () => {
    for (let i = 0; i < 25; i++) switchTrace.start(`w${i}`);
    expect(switchTrace.all()).toHaveLength(20);
    expect(switchTrace.all()[0]?.id).toBe('w5');
    expect(switchTrace.current()?.id).toBe('w24');
    expect((window as unknown as { __tfsPerf: unknown }).__tfsPerf).toBe(switchTrace.all());
  });

  it('ignores marks when no switch is in progress', () => {
    expect(() => switchTrace.mark('detail')).not.toThrow();
    expect(switchTrace.current()).toBeNull();
  });
});
