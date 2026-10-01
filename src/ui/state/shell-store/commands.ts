/**
 * The commands slice of the shell's state: the robot's commands, the keymap their keys join,
 * the commands that wait for an answer and the notice of the last one sent.
 *
 * @module
 */

import { commandKeyTaken, resolveBindings } from '../../keyboard/keymap';
import type { CommandsSlice, SliceTools } from './types';

/** Creates the commands slice. */
export function commandsSlice({ set, get, options }: SliceTools): CommandsSlice {
  return {
    keyOverrides: options.keyOverrides ?? {},
    commands: [],
    bindings: resolveBindings(options.keyOverrides),
    waitingCommands: new Map(),
    commandNotice: null,

    trackCommand: (id, change) => {
      const waiting = new Map(get().waitingCommands);
      const count = (waiting.get(id) ?? 0) + change;

      if (count > 0) {
        waiting.set(id, count);
      } else {
        waiting.delete(id);
      }

      set({ waitingCommands: waiting });
    },

    setKeyOverrides: (keyOverrides) => {
      const { commands } = get();
      const taken = commandKeyTaken(keyOverrides, commands);

      if (taken !== null) {
        return taken;
      }

      set({ keyOverrides, bindings: resolveBindings(keyOverrides, commands) });
      return null;
    },

    setCommands: (commands) =>
      set({ commands, bindings: resolveBindings(get().keyOverrides, commands) }),

    showCommandNotice: (notice) => {
      const current = get().commandNotice;

      if (current === null || notice.id >= current.id) {
        set({ commandNotice: notice });
      }
    },

    clearCommandNotice: (id) => {
      if (get().commandNotice?.id === id) {
        set({ commandNotice: null });
      }
    },
  };
}
