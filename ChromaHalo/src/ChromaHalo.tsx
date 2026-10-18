'use client';

/**
 * ChromaHalo — React wrapper around the framework-agnostic inkHalo engine.
 *
 * The component renders one <canvas> and nothing else. The canvas is absolutely
 * inset into its parent and has `pointer-events: none`; the engine listens on
 * the parent, so the halo never blocks a link, a button or a text selection.
 * Give the parent a size and `position: relative`.
 *
 * Next.js / SSR: this is a client component and the engine is created inside an
 * effect, so the server render only emits the canvas.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from 'react';

import {
  createInkHalo,
  type InkHaloApi,
  type InkHaloOptions,
  type InkHaloResolvedMode,
  type InkHaloStats,
} from './inkHalo.js';

export type ChromaHaloHandle = Pick<
  InkHaloApi,
  'getMode' | 'getOptions' | 'getStats' | 'sampleDensity' | 'rebuild' | 'setOptions'
>;

export interface ChromaHaloProps extends InkHaloOptions {
  className?: string;
  style?: CSSProperties;
  /** accessible description; the canvas itself stays aria-hidden because it is decoration */
  ariaLabel?: string;
}

export const ChromaHalo = forwardRef<ChromaHaloHandle, ChromaHaloProps>(
  function ChromaHalo(props, ref) {
    const {
      className,
      style,
      ariaLabel = 'Chroma Halo：跟随指针的墨迹场，停下后会自行漂移并消散',
      onModeChange,
      ...engineOptions
    } = props;

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const apiRef = useRef<InkHaloApi | null>(null);
    const optionsRef = useRef(engineOptions);
    const modeCallbackRef = useRef(onModeChange);

    optionsRef.current = engineOptions;

    useEffect(() => {
      modeCallbackRef.current = onModeChange;
    }, [onModeChange]);

    // create once on mount; prop changes go through setOptions
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const api = createInkHalo(canvas, {
        ...optionsRef.current,
        onModeChange: (mode: InkHaloResolvedMode) => modeCallbackRef.current?.(mode),
      });
      apiRef.current = api;
      return () => {
        api.destroy();
        apiRef.current = null;
      };
    }, []);

    useEffect(() => {
      apiRef.current?.setOptions(engineOptions);
    });

    useImperativeHandle(ref, () => ({
      getMode: () => apiRef.current?.getMode() ?? 'ink',
      getOptions: () => apiRef.current?.getOptions() ?? ({} as ReturnType<InkHaloApi['getOptions']>),
      getStats: () => apiRef.current?.getStats() ?? ({} as InkHaloStats),
      sampleDensity: (x: number, y: number) => apiRef.current?.sampleDensity(x, y) ?? 0,
      rebuild: () => apiRef.current?.rebuild(),
      setOptions: (next: InkHaloOptions) => apiRef.current?.setOptions(next),
    }), []);

    return (
      <canvas
        ref={canvasRef}
        className={className}
        style={{
          position: 'absolute',
          inset: 0,
          display: 'block',
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          ...style,
        }}
        aria-hidden="true"
        aria-label={ariaLabel}
      />
    );
  },
);

export default ChromaHalo;
