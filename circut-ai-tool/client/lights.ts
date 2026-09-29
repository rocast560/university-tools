// Status lights: one per assistant that can drive this server over MCP,
// blinking while it is making calls, steady when it has been by recently,
// dim otherwise. Pinned to a top corner of your choosing, with a small
// settings panel for which lights to show and where.

import { api, type ClientSeen } from './api.ts';
import { esc, h } from './main.ts';

type Kind = ClientSeen['kind'];

const LABELS: Record<Kind, string> = { 'claude-code': 'Claude CLI', 'claude-desktop': 'Claude Desktop', codex: 'Codex', chatgpt: 'ChatGPT', other: 'MCP' };
const KINDS: Kind[] = ['claude-code', 'claude-desktop', 'codex', 'chatgpt', 'other'];

export interface LightSettings {
  enabled: boolean;
  corner: 'top-left' | 'top-right';
  show: Record<Kind, boolean>;
}

const KEY = 'statusLights';
const defaults = (): LightSettings => ({ enabled: true, corner: 'top-right', show: { 'claude-code': true, 'claude-desktop': true, codex: true, chatgpt: true, other: false } });

function loadSettings(): LightSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const o = JSON.parse(raw) as Partial<LightSettings>;
    const d = defaults();
    return { enabled: o.enabled ?? d.enabled, corner: o.corner === 'top-left' ? 'top-left' : 'top-right', show: { ...d.show, ...(o.show ?? {}) } };
  } catch {
    return defaults();
  }
}

function saveSettings(s: LightSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked */
  }
}

/** Blinking for this long after a call; steady for this long after that. */
const LIVE_MS = 4000;
const ON_MS = 5 * 60_000;

let settings = loadSettings();
const latest = new Map<Kind, ClientSeen>();
let root: HTMLElement | null = null;
let open = false;

/** A client was seen (from the event stream or the initial list). */
export function noteClient(c: ClientSeen) {
  const prev = latest.get(c.kind);
  if (!prev || c.lastSeen >= prev.lastSeen) latest.set(c.kind, c);
  tick();
}

function stateOf(kind: Kind): 'live' | 'on' | 'off' {
  const c = latest.get(kind);
  if (!c) return 'off';
  const age = Date.now() - c.lastSeen;
  return age < LIVE_MS ? 'live' : age < ON_MS ? 'on' : 'off';
}

function paint() {
  if (!root) return;
  root.className = `status-lights ${settings.corner} ${settings.enabled ? '' : 'is-hidden'} ${open ? 'is-open' : ''}`;
  const lights = KINDS.filter((k) => settings.show[k] || (k === 'other' && latest.has('other') && settings.show.other))
    .map((k) => {
      const c = latest.get(k);
      const state = stateOf(k);
      const when = c ? `${c.name} · last call ${c.lastMethod} · ${Math.max(0, Math.round((Date.now() - c.lastSeen) / 1000))}s ago` : 'not connected yet';
      return `<span class="light is-${state}" data-kind="${k}" title="${esc(when)}"><i></i>${esc(LABELS[k])}</span>`;
    })
    .join('');
  const panel = open
    ? `<div class="lights-settings">
        <label><input type="checkbox" data-set="enabled" ${settings.enabled ? 'checked' : ''}> Show status lights</label>
        <label>Corner <select data-set="corner"><option value="top-right" ${settings.corner === 'top-right' ? 'selected' : ''}>top right</option><option value="top-left" ${settings.corner === 'top-left' ? 'selected' : ''}>top left</option></select></label>
        ${KINDS.map((k) => `<label><input type="checkbox" data-show="${k}" ${settings.show[k] ? 'checked' : ''}> ${esc(LABELS[k])}</label>`).join('')}
        <p class="muted">A light blinks while that assistant is calling the server, stays lit for five minutes after, and dims when it has gone quiet. Set each one up on the Connect page.</p>
      </div>`
    : '';
  root.innerHTML = `<div class="lights-row">${lights}<button type="button" class="lights-gear" title="status light settings" aria-label="status light settings">⚙</button></div>${panel}`;
}

/** Refresh only the lights' states, so an open settings panel is left alone. */
function tick() {
  for (const el of document.querySelectorAll<HTMLElement>('.light[data-kind]')) {
    const k = el.dataset.kind as Kind;
    const c = latest.get(k);
    const state = stateOf(k);
    el.classList.remove('is-off', 'is-on', 'is-live');
    el.classList.add(`is-${state}`);
    el.title = c ? `${c.name} · last call ${c.lastMethod} · ${Math.max(0, Math.round((Date.now() - c.lastSeen) / 1000))}s ago` : 'not connected yet';
    const word = el.querySelector('.conn-state');
    if (word) word.textContent = state === 'live' ? 'calling now' : state === 'on' ? 'connected' : 'not connected';
  }
}

/**
 * Put the lights in the page header's chosen corner. The header is rebuilt
 * on every route change, so this is called after each render; the element
 * itself is kept, so its timers and state carry over.
 */
export function placeLights() {
  if (!root) return;
  const header = document.querySelector<HTMLElement>('header.appbar, main.home > header, main.connect > header');
  if (!header) return;
  if (settings.corner === 'top-left') {
    const after = header.querySelector('.path, h1');
    after ? after.after(root) : header.prepend(root);
  } else {
    const before = header.querySelector('.spacer ~ *, .btn, button');
    before ? before.before(root) : header.append(root);
  }
}

/** Mount once; safe to call again. */
export function mountLights() {
  if (root) return;
  root = h('<div class="status-lights"></div>');
  document.body.append(root);
  placeLights();
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.lights-gear')) {
      open = !open;
      paint();
    }
  });
  root.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.dataset.set === 'enabled') settings.enabled = (t as HTMLInputElement).checked;
    else if (t.dataset.set === 'corner') {
      settings.corner = t.value === 'top-left' ? 'top-left' : 'top-right';
      placeLights();
    }
    else if (t.dataset.show) settings.show[t.dataset.show as Kind] = (t as HTMLInputElement).checked;
    else return;
    saveSettings(settings);
    paint();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      open = false;
      paint();
    }
  });
  paint();
  void api.clients().then((list) => list.forEach(noteClient)).catch(() => {});
  // Lights age on their own; a tick a second keeps the states honest.
  setInterval(tick, 1000);
}

/** For the settings page or tests. */
export const lightSettings = () => settings;
export function setLightSettings(s: LightSettings) {
  settings = s;
  saveSettings(s);
  paint();
}
