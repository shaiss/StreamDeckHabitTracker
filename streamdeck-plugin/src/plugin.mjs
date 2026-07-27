// SPIKE (Task 3): registers both actions and paints a static SVG face, to
// prove the Node runtime + SVG rasterization on real hardware. Task 4 replaces
// this with the full port.
import streamDeck, { SingletonAction, action } from '@elgato/streamdeck';
import { face } from './faces.mjs';

const VIOLET_HUE = 262;
const SILVER_HUE = 222;

// Plain-JS equivalent of the @action decorator: apply it as a function. It
// stamps manifestId so registerAction() can route events.
function defineAction(uuid, handlers) {
  const wrapped = action({ UUID: uuid })(class extends SingletonAction {});
  const inst = new (wrapped || class extends SingletonAction {})();
  if (!inst.manifestId) {
    try { inst.manifestId = uuid; } catch { Object.defineProperty(inst, 'manifestId', { value: uuid }); }
  }
  return Object.assign(inst, handlers);
}

const habit = defineAction('com.shaiss.habit-tracker.habit', {
  onWillAppear: (ev) => ev.action.setImage(face('✅', 'Node!', SILVER_HUE, '', 26)),
  onKeyDown: (ev) => ev.action.showOk()
});
const slot = defineAction('com.shaiss.habit-tracker.slot', {
  onWillAppear: (ev) => ev.action.setImage(face('🌊', 'SVG spike', VIOLET_HUE, 'AI')),
  onKeyDown: (ev) => ev.action.showOk()
});

streamDeck.actions.registerAction(habit);
streamDeck.actions.registerAction(slot);
await streamDeck.connect();
