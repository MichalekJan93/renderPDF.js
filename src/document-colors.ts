import { rgb } from 'pdf-lib';
import type { RGB } from 'pdf-lib';
import { RenderPDFError } from './diagnostics.js';

/** Color components and alpha stay separate so native PDF paint retains transparency. */
export interface DocumentColor {
  color: RGB;
  opacity: number;
}

/** Parse portable CSS hex/rgb colors without relying on a browser document. */
export function parseDocumentColor(value: string): DocumentColor {
  if (typeof value !== 'string')
    throw new RenderPDFError('INVALID_OPTIONS', 'A drawing color must be a CSS color string.');
  const names: Readonly<Record<string, string>> = {
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    green: '#008000',
    blue: '#0000ff',
    yellow: '#ffff00',
    cyan: '#00ffff',
    aqua: '#00ffff',
    magenta: '#ff00ff',
    fuchsia: '#ff00ff',
    gray: '#808080',
    grey: '#808080',
    silver: '#c0c0c0',
    maroon: '#800000',
    olive: '#808000',
    lime: '#00ff00',
    teal: '#008080',
    navy: '#000080',
    purple: '#800080',
    orange: '#ffa500',
    transparent: '#00000000',
  };
  const normalized = value.trim().toLowerCase();
  const color = names[normalized] ?? normalized;
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.exec(color)?.[1];
  if (hex) {
    const expanded =
      hex.length <= 4
        ? hex
            .split('')
            .map((part) => part + part)
            .join('')
        : hex;
    const component = (offset: number) =>
      Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255;
    return {
      color: rgb(component(0), component(2), component(4)),
      opacity: expanded.length === 8 ? component(6) : 1,
    };
  }
  const contents = /^rgba?\(([^()]*)\)$/.exec(color)?.[1];
  const parts = contents
    ?.trim()
    .replace(/\s*\/\s*/, ',')
    .split(/\s*[,\s]\s*/);
  if (
    parts &&
    (parts.length === 3 || parts.length === 4) &&
    parts.every((part) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(part))
  ) {
    const components = parts.map(
      (part, index) => Number.parseFloat(part) / (part.endsWith('%') ? 100 : index === 3 ? 1 : 255),
    );
    if (components.every((part) => Number.isFinite(part) && part >= 0 && part <= 1))
      return {
        color: rgb(components[0]!, components[1]!, components[2]!),
        opacity: components[3] ?? 1,
      };
  }
  throw new RenderPDFError(
    'INVALID_OPTIONS',
    'Use a CSS hex color, rgb()/rgba(), or a supported basic color name.',
  );
}
