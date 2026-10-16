/** Types for the framework-agnostic glyphGravity engine. */

export type GlyphGravityState = 'formed' | 'collapsing' | 'piled' | 'restoring';

export interface GlyphGravityOptions {
  /** text to form; "\n" starts a new line */
  text?: string;
  /** glyph pool used for the particles */
  characters?: string;
  /** sampling step in CSS px — smaller means denser and more particles */
  density?: number;
  /** glyph draw size in px; 0 derives it from density */
  glyphSize?: number;
  /** hard cap on particle count; density is coarsened automatically to respect it */
  maxParticles?: number;
  color?: string;
  /** colour for glyphs knocked out of the text; equal to color disables the tint */
  fallColor?: string;
  fontFamily?: string;
  fontWeight?: string;
  lineHeight?: number;
  /** padding around the text block, CSS px */
  padding?: number;
  /** fall acceleration, px/s² */
  gravity?: number;
  /** erase radius under the pointer, CSS px */
  eraseRadius?: number;
  /** 'drag' erases while pressed, 'hover' erases on move, 'both' does either */
  eraseMode?: 'drag' | 'hover' | 'both';
  /** movement in px above which a press counts as a drag instead of a click */
  dragThreshold?: number;
  /** max press duration (ms) that still counts as a click */
  clickMaxMs?: number;
  /** allowed height difference between neighbouring pile columns, px (slope) */
  repose?: number;
  /** idle glyph shuffling per particle per second */
  shuffle?: number;
  /** 'auto' follows prefers-reduced-motion, 'instant' skips animation, 'full' forces it */
  reducedMotion?: 'auto' | 'instant' | 'full';
  onStateChange?: ((state: GlyphGravityState) => void) | null;
}

export interface GlyphGravityStats {
  particleCount: number;
  frameMs: number;
  state: GlyphGravityState;
  dpr: number;
  reduceMotion: boolean;
  glyphSize: number;
}

export interface GlyphGravityApi {
  collapse(): void;
  restore(): void;
  toggle(): void;
  reset(): void;
  rebuild(): void;
  getState(): GlyphGravityState;
  getParticleCount(): number;
  getStats(): GlyphGravityStats;
  setOptions(next: GlyphGravityOptions): void;
  destroy(): void;
}

export declare const GLYPH_GRAVITY_DEFAULTS: Required<
  Omit<GlyphGravityOptions, 'onStateChange'>
> & { onStateChange: null };

export declare function createGlyphGravity(
  canvas: HTMLCanvasElement,
  options?: GlyphGravityOptions,
): GlyphGravityApi;
