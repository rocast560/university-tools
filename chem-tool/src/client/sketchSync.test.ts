import { expect, test } from 'vitest';
import { shouldResetEditor } from './sketchSync';

test('editor is reset only for foreign changes to a different molecule', () => {
  expect(shouldResetEditor('window:me', 'me', 'idA', 'idB')).toBe(false);   // my own echo, never reset
  expect(shouldResetEditor('mcp', 'me', 'idA', 'idA')).toBe(false);         // same molecule already shown
  expect(shouldResetEditor('mcp', 'me', 'idA', 'idB')).toBe(true);          // Claude changed it
  expect(shouldResetEditor('window:other', 'me', 'idA', 'idB')).toBe(true); // another window changed it
  expect(shouldResetEditor(null, 'me', null, 'idB')).toBe(true);            // first state, empty editor
});
