import type { CSSProperties, HTMLAttributes } from 'react';

export interface PixelLoaderWavesProps extends HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}

const GRID_SIZE = 5;
const CORE_SIZE = 1;
const WAVE_SPLIT = 50;
const WAVE_CURVE = 1.3;
const WAVE_PHASE_OFFSET = 1.2;
const WAVE_SHARED_WIDTH = 4;
const split = (GRID_SIZE - 1) * (WAVE_SPLIT / 100);
const sharedStart = Math.floor((GRID_SIZE - WAVE_SHARED_WIDTH) / 2);
const sharedEnd = sharedStart + WAVE_SHARED_WIDTH - 1;
const pixels = Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => {
  const row = Math.floor(index / GRID_SIZE);
  const column = index % GRID_SIZE;
  const upperWave = column + Math.max(0, split - row) * WAVE_CURVE;
  const lowerWave = column + Math.max(0, row - split) * WAVE_CURVE + WAVE_PHASE_OFFSET;
  const isSplitRow = Math.abs(row - split) < 0.001;
  const isSharedColumn = column >= sharedStart && column <= sharedEnd;
  const waveCrest = isSplitRow && isSharedColumn;
  const splitUsesLowerWave = (column + CORE_SIZE) % 2 === 0;

  return {
    index,
    wave:
      row < split || waveCrest
        ? upperWave
        : row > split || splitUsesLowerWave
          ? lowerWave
          : upperWave,
    waveSecond: lowerWave,
    waveCrest,
  };
});

type PixelStyle = CSSProperties &
  Partial<Record<'--pixel-loader-wave-delay' | '--pixel-loader-wave-second-delay', number>>;

export function PixelLoaderWaves({
  size = 'lg',
  label = 'Loading',
  className,
  ...rest
}: PixelLoaderWavesProps) {
  return (
    <div
      className={['pixel-loader-waves', `pixel-loader-waves--${size}`, className]
        .filter(Boolean)
        .join(' ')}
      role="status"
      aria-label={label}
      {...rest}
    >
      {pixels.map((pixel) => (
        <span
          key={pixel.index}
          className={
            pixel.waveCrest
              ? 'pixel-loader-waves__pixel pixel-loader-waves__pixel--crest'
              : 'pixel-loader-waves__pixel'
          }
          aria-hidden="true"
          style={
            {
              '--pixel-loader-wave-delay': pixel.wave,
              '--pixel-loader-wave-second-delay': pixel.waveSecond,
            } as PixelStyle
          }
        />
      ))}
    </div>
  );
}
