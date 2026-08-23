import { useRef, type ReactNode } from 'react';

/**
 * A draggable divider.
 *
 * Every part of the table is a different size on a different screen, and no
 * default is right for all of them: a wide board wants a narrow log, a long
 * combo turn wants a tall log, and a player reading their hand wants it larger
 * than a player reading the board does. Rather than adding three more settings,
 * the lines that already separate those areas became the controls for them.
 *
 * The value is read at the moment the drag starts rather than passed in, so a
 * divider can begin from wherever the layout happens to have put it — the two
 * halves of the table size themselves automatically until the first drag.
 */

export interface SplitterProps {
  /** 'x' drags left and right, 'y' drags up and down. */
  axis: 'x' | 'y';
  /** The size this divider controls, in pixels, at the moment the drag starts. */
  getBase: () => number;
  /** Called with the size the drag is asking for. Clamping is the caller's job. */
  onResize: (next: number) => void;
  /** Back to automatic. Bound to double click and to Home. */
  onReset: () => void;
  /**
   * Which way the pointer has to move to make the value larger. A panel on the
   * right grows when the pointer goes left, so it passes -1.
   */
  direction?: 1 | -1;
  /** Pixels per arrow key press. */
  step?: number;
  className?: string;
  label: string;
  children?: ReactNode;
}

export function Splitter({
  axis,
  getBase,
  onResize,
  onReset,
  direction = 1,
  step = 24,
  className = '',
  label,
  children,
}: SplitterProps) {
  const drag = useRef<{ from: number; base: number } | null>(null);

  const positionOf = (e: { clientX: number; clientY: number }) =>
    axis === 'x' ? e.clientX : e.clientY;

  return (
    <div
      className={`splitter is-${axis} ${className}`.trim()}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={`${label} — drag to resize, double click to reset`}
      tabIndex={0}
      onPointerDown={(e) => {
        // Only the primary button, and never from a click on something inside.
        if (e.button !== 0) return;
        drag.current = { from: positionOf(e), base: getBase() };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        onResize(d.base + (positionOf(e) - d.from) * direction);
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        if (e.key === back) onResize(getBase() - step * direction);
        else if (e.key === forward) onResize(getBase() + step * direction);
        else if (e.key === 'Home') onReset();
        else return;
        e.preventDefault();
      }}
    >
      {children}
      <span className="splitter-grip" aria-hidden />
    </div>
  );
}

/** Keeps a dragged size inside something sensible. */
export function clampSize(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}
