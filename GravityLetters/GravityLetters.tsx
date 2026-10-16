'use client';

/**
 * GravityLetters — React wrapper around the framework-agnostic glyphGravity engine.
 *
 * Next.js / SSR notes
 *   - This file is a client component: the engine is created in an effect, so the
 *     server render emits only the <canvas> element (no window/document access).
 *   - The canvas is styled to fill its parent: give the wrapper a height, or pass
 *     `style`. Nothing measures the DOM during render.
 *
 * Interaction (matches the reference behaviour)
 *   - press + drag  : erase characters under the pointer, they fall with gravity
 *   - short click   : collapse everything into a pile; click again to restore
 *   - keyboard      : Space / Enter toggles, R resets (canvas is focusable)
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import {
  createGlyphGravity,
  type GlyphGravityApi,
  type GlyphGravityOptions,
  type GlyphGravityState,
} from './glyphGravity.js';

export type GravityLettersHandle = Pick<
  GlyphGravityApi,
  'collapse' | 'restore' | 'toggle' | 'reset' | 'rebuild' | 'getState' | 'getParticleCount' | 'getStats'
>;

export interface GravityLettersProps extends GlyphGravityOptions {
  className?: string;
  style?: CSSProperties;
  /** accessible description of the canvas and its gestures */
  ariaLabel?: string;
  /** fires whenever the engine changes state */
  onStateChange?: (state: GlyphGravityState) => void;
}

export const GravityLetters = forwardRef<GravityLettersHandle, GravityLettersProps>(
  function GravityLetters(props, ref) {
    const {
      className,
      style,
      ariaLabel = '字符重力画布：按住拖动像削皮一样擦除字符，点击坍塌成堆，再点复原',
      onStateChange,
      ...engineOptions
    } = props;

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const apiRef = useRef<GlyphGravityApi | null>(null);
    const optionsRef = useRef(engineOptions);
    const callbackRef = useRef(onStateChange);
    const [, forceStats] = useState(0);

    optionsRef.current = engineOptions;

    useEffect(() => {
      callbackRef.current = onStateChange;
    }, [onStateChange]);

    // create once on mount; option changes are pushed through setOptions
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const api = createGlyphGravity(canvas, {
        ...optionsRef.current,
        onStateChange: (state) => callbackRef.current?.(state),
      });
      apiRef.current = api;
      return () => {
        api.destroy();
        apiRef.current = null;
      };
    }, []);

    // push prop changes without rebuilding the whole engine
    useEffect(() => {
      apiRef.current?.setOptions(engineOptions);
    });

    useImperativeHandle(ref, () => ({
      collapse: () => apiRef.current?.collapse(),
      restore: () => apiRef.current?.restore(),
      toggle: () => apiRef.current?.toggle(),
      reset: () => apiRef.current?.reset(),
      rebuild: () => apiRef.current?.rebuild(),
      getState: () => apiRef.current?.getState() ?? 'formed',
      getParticleCount: () => apiRef.current?.getParticleCount() ?? 0,
      getStats: () => apiRef.current?.getStats() ?? null,
    }), []);

    return (
      <canvas
        ref={canvasRef}
        className={className}
        style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none', ...style }}
        tabIndex={0}
        role="img"
        aria-label={ariaLabel}
        data-glyph-gravity-state={apiRef.current?.getState() ?? 'formed'}
        onFocus={() => { forceStats((n) => n + 1); apiRef.current?.rebuild(); }}
      />
    );
  },
);

export default GravityLetters;
