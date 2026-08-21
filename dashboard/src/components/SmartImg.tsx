import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fileUrl } from '../lib/types';

/**
 * A redesign is a 6 MB PNG and a page render is close to a megabyte. Paint the
 * small WebP/thumb first — the grid has usually cached it already — and swap in
 * the full image once it has arrived, so nothing ever shows an empty hole.
 *
 * The spinner is absolutely positioned: the parent has to be `relative`.
 */
export default function SmartImg({ src, thumb, alt, className = '', onRatio, onClick }: {
  src: string;
  thumb?: string | null;
  alt: string;
  className?: string;
  onRatio?: (src: string, ratio: number) => void;
  onClick?: () => void;
}) {
  const [shown, setShown] = useState(thumb || src);
  const [loading, setLoading] = useState(Boolean(thumb) && thumb !== src);

  useEffect(() => {
    setShown(thumb || src);
    if (!thumb || thumb === src) { setLoading(false); return; }
    setLoading(true);
    let alive = true;
    const img = new Image();
    const done = () => { if (alive) { setShown(src); setLoading(false); } };
    img.onload = done;
    img.onerror = done;
    img.src = fileUrl(src);
    return () => { alive = false; };
  }, [src, thumb]);

  return (
    <>
      <img
        src={fileUrl(shown)}
        alt={alt}
        onClick={onClick}
        onLoad={(e) => {
          const el = e.currentTarget;
          if (onRatio && el.naturalWidth && el.naturalHeight) onRatio(src, el.naturalWidth / el.naturalHeight);
        }}
        className={className}
      />
      {loading && (
        <span className="absolute bottom-1 right-1 rounded bg-black/60 p-1 text-zinc-300 pointer-events-none">
          <Loader2 size={10} className="animate-spin" />
        </span>
      )}
    </>
  );
}
