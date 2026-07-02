import { useEffect } from 'react';

export const VOICE_COMMAND_EVENT = 'calib:voice-command';

export function dispatchVoiceCommand(detail) {
  window.dispatchEvent(new CustomEvent(VOICE_COMMAND_EVENT, { detail }));
}

export function useVoiceCommands(enabled, handlers) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onCommand = (event) => {
      const command = event.detail?.command;
      if (!command) return;
      handlers?.[command]?.(event.detail);
    };
    window.addEventListener(VOICE_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(VOICE_COMMAND_EVENT, onCommand);
  }, [enabled, handlers]);
}
