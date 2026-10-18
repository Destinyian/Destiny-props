/** Types for the framework-agnostic inkHalo engine. */

export type InkHaloMode = 'auto' | 'ink' | 'smoke';
export type InkHaloResolvedMode = 'ink' | 'smoke';
export type InkHaloQuality = 'low' | 'medium' | 'high';
export type InkHaloMotion = 'auto' | 'instant' | 'full';

export interface InkHaloOptions {
  /** hue of the ink / smoke; any hex or rgb() colour */
  color?: string;
  /** 'auto' reads the first opaque ancestor background, or force 'ink' / 'smoke' */
  mode?: InkHaloMode;
  /** brush radius at half strength, CSS px (2..600) */
  size?: number;
  /** velocity impulse multiplier (0..10) */
  force?: number;
  /** dye injection multiplier (0..10) */
  intensity?: number;
  /** dye lifetime in seconds (0.05..30) */
  trail?: number;
  /** velocity lifetime in seconds (0.05..30) */
  drift?: number;
  /** CSS blur on the upscaled simulation, px (0..64) */
  blur?: number;
  /** overall strength (0..1) */
  opacity?: number;
  /** simulation scale: low 0.15 / medium 0.25 / high 0.4 */
  quality?: InkHaloQuality;
  /** let the invisible wanderer paint while the pointer is away */
  autoplay?: boolean;
  /** wanderer speed (0..10) */
  autoplaySpeed?: number;
  /** seconds of pointer silence before the wanderer starts */
  idleDelay?: number;
  /** follow the pointer at all */
  interactive?: boolean;
  /** freeze the simulation */
  paused?: boolean;
  /** 'auto' follows prefers-reduced-motion */
  reducedMotion?: InkHaloMotion;
  /** Jacobi pressure iterations (3..6; 4 is the reference) */
  iterations?: number;
  /** drop to low quality + blur 0 when hardware or frame time demands it */
  autoDegrade?: boolean;
  /** fires when the resolved mode changes */
  onModeChange?: ((mode: InkHaloResolvedMode) => void) | null;
}

export interface InkHaloStats {
  fallback: boolean;
  /** resolved mode */
  mode: InkHaloResolvedMode;
  /** the raw option: 'auto' | 'ink' | 'smoke' */
  modeOption: InkHaloMode;
  quality: InkHaloQuality;
  grid: { width: number; height: number; scale: number } | null;
  scale: number;
  frames: number;
  lastFrameMs: number;
  p95FrameMs: number;
  running: boolean;
  autoplayActive: boolean;
  autoStrength: number;
  idleMs: number;
  splats: number;
  passes: number;
  dyeMax: number;
  reduceMotion: boolean;
  degraded: string | null;
  color: string;
  paused: boolean;
  interactive: boolean;
  stopped: number;
  seen?: boolean;
}

export interface InkHaloResolvedOptions extends Required<Omit<InkHaloOptions, 'onModeChange'>> {
  onModeChange: ((mode: InkHaloResolvedMode) => void) | null;
}

export interface InkHaloApi {
  getMode(): InkHaloResolvedMode;
  getOptions(): InkHaloResolvedOptions;
  getStats(): InkHaloStats;
  sampleDensity(x: number, y: number): number;
  rebuild(): void;
  setOptions(next: InkHaloOptions): void;
  destroy(): void;
}

export declare const INK_HALO_DEFAULTS: InkHaloResolvedOptions;

export declare function createInkHalo(
  canvas: HTMLCanvasElement,
  options?: InkHaloOptions,
): InkHaloApi;
