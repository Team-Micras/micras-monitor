import { describe, expect, test } from 'vitest';

import styles from '@/app/styles.css?raw';

type Rgb = readonly [number, number, number];

function block(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  const end = styles.indexOf('\n}', start);
  return styles.slice(start, end);
}

function tokens(selector: string): Map<string, string> {
  return new Map(
    [...block(selector).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2],
    ])
  );
}

function clip(channel: number): number {
  return Math.min(1, Math.max(0, channel));
}

function oklchToRgb(text: string): Rgb {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(text);

  if (match === null) {
    throw new Error(`"${text}" is not an opaque oklch colour`);
  }

  const [lightness, chroma, hue] = match.slice(1).map(Number);
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(foreground: string, background: string): number {
  const [light, dark] = [foreground, background]
    .map((color) => luminance(oklchToRgb(color)))
    .toSorted((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const SURFACES = ['background', 'desktop', 'card', 'popover', 'muted', 'secondary', 'accent'];

const TEXT_ON: readonly (readonly [string, readonly string[]])[] = [
  ['foreground', SURFACES],
  ['muted-foreground', SURFACES],
  ['card-foreground', ['card']],
  ['popover-foreground', ['popover']],
  ['primary-foreground', ['primary']],
  ['secondary-foreground', ['secondary']],
  ['accent-foreground', ['accent']],
  ['destructive', ['background', 'desktop', 'card', 'popover', 'muted']],
  ['stop-foreground', ['stop']],
];

describe.each([
  ['light', ':root'],
  ['dark', '.dark'],
])('the %s theme', (_name, selector) => {
  const theme = new Map([...tokens(':root'), ...tokens(selector)]);
  const pairs = TEXT_ON.flatMap(([foreground, backgrounds]) =>
    backgrounds.map((background) => [foreground, background] as const)
  );

  test.each(pairs)('%s text on %s meets WCAG AA (4.5:1)', (foreground, background) => {
    const front = theme.get(foreground);
    const back = theme.get(background);

    expect(front).toBeDefined();
    expect(back).toBeDefined();
    expect(ratio(front ?? '', back ?? '')).toBeGreaterThanOrEqual(4.5);
  });
});
