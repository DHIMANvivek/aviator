"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ViewerImage = { url: string; name?: string };

const MIN = 0.1;
const MAX = 8;
const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z));

/**
 * Full-screen screenshot viewer. Opens fitted to the window; zoom with the buttons, the
 * scroll wheel, + / - / 0 keys or a click, and drag to pan. Arrow keys switch images.
 */
export function ImageViewer({ images, start = 0, onClose }: { images: ViewerImage[]; start?: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean; onImage: boolean } | null>(null);
  const image = images[index];

  /** Change zoom, keeping the point under (cx, cy) in the stage where it is. */
  const zoomTo = (next: number, cx?: number, cy?: number) => {
    const el = stage.current;
    const z = clamp(next);
    if (!el) return setZoom(z);
    const rect = el.getBoundingClientRect();
    const px = (cx ?? rect.left + rect.width / 2) - rect.left;
    const py = (cy ?? rect.top + rect.height / 2) - rect.top;
    const ratio = z / zoom;
    const left = (el.scrollLeft + px) * ratio - px;
    const top = (el.scrollTop + py) * ratio - py;
    setZoom(z);
    requestAnimationFrame(() => el.scrollTo(left, top));
  };

  const fitToWindow = (size = natural) => {
    const el = stage.current;
    if (!el || !size) return;
    const f = Math.min(1, (el.clientWidth - 32) / size.w, (el.clientHeight - 32) / size.h);
    setFit(f);
    setZoom(f);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoomTo(zoom * 1.25);
      else if (e.key === "-") zoomTo(zoom / 1.25);
      else if (e.key === "0") fitToWindow();
      else if (e.key === "1") zoomTo(1);
      else if (e.key === "ArrowRight" && images.length > 1) setIndex((i) => (i + 1) % images.length);
      else if (e.key === "ArrowLeft" && images.length > 1) setIndex((i) => (i - 1 + images.length) % images.length);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Wheel zoom needs a non-passive listener so the page doesn't scroll instead.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      zoomTo(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  useEffect(() => setNatural(null), [index]);

  const width = natural ? Math.round(natural.w * zoom) : undefined;
  const height = natural ? Math.round(natural.h * zoom) : undefined;

  return createPortal(
    <div className="viewer" role="dialog" aria-modal="true" aria-label="Screenshot viewer">
      <div className="viewer-bar">
        <span className="viewer-name">
          {image.name ?? "Screenshot"}
          {images.length > 1 && <span className="faint"> · {index + 1} of {images.length}</span>}
        </span>
        {images.length > 1 && (
          <>
            <button className="btn icon" onClick={() => setIndex((index - 1 + images.length) % images.length)} title="Previous (←)" aria-label="Previous image">
              ‹
            </button>
            <button className="btn icon" onClick={() => setIndex((index + 1) % images.length)} title="Next (→)" aria-label="Next image">
              ›
            </button>
          </>
        )}
        <button className="btn icon" onClick={() => zoomTo(zoom / 1.25)} title="Zoom out (-)" aria-label="Zoom out">
          −
        </button>
        <span className="viewer-zoom">{Math.round(zoom * 100)}%</span>
        <button className="btn icon" onClick={() => zoomTo(zoom * 1.25)} title="Zoom in (+)" aria-label="Zoom in">
          +
        </button>
        <button className="btn" onClick={() => fitToWindow()} title="Fit to window (0)">
          Fit
        </button>
        <button className="btn" onClick={() => zoomTo(1)} title="Actual size (1)">
          100%
        </button>
        <a className="btn" href={image.url} target="_blank" rel="noreferrer" title="Open in a new tab">
          Open
        </a>
        <button className="btn icon" onClick={onClose} title="Close (Esc)" aria-label="Close">
          ×
        </button>
      </div>
      <div
        className={`viewer-stage ${zoom > fit + 0.001 ? "pannable" : ""}`}
        ref={stage}
        onPointerDown={(e) => {
          const el = stage.current!;
          const onImage = (e.target as HTMLElement).tagName === "IMG";
          drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false, onImage };
          el.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !stage.current) return;
          if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true;
          stage.current.scrollTo(d.left - (e.clientX - d.x), d.top - (e.clientY - d.y));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d?.moved) return;
          // A click on the backdrop closes; a click on the image toggles fit / zoomed in.
          if (!d?.onImage) onClose();
          else if (zoom > fit + 0.001) fitToWindow();
          else zoomTo(Math.max(1, fit * 2), e.clientX, e.clientY);
        }}
        onPointerCancel={() => (drag.current = null)}
      >
        <div className="viewer-canvas">
          <img
            src={image.url}
            alt={image.name ?? "Screenshot"}
            draggable={false}
            style={{ width, height, visibility: natural ? "visible" : "hidden" }}
            onLoad={(e) => {
              const size = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight };
              setNatural(size);
              fitToWindow(size);
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
