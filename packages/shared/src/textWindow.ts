import type { TextWindow } from './types.js';

export function textWindow(text: string, offset = 0, max = 12000): TextWindow {
  const characters = Array.from(text);
  const truncated = offset + max < characters.length;
  return {
    content: characters.slice(offset, offset + max).join(''),
    truncated,
    next_offset_chars: truncated ? offset + max : null,
  };
}
