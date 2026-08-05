/**
 * DashboardHeader — the presentation-only hero for the dashboard home screen.
 *
 * @module components/DashboardHeader
 */

import { useState } from 'react';

export function DashboardHeader() {
  const [clickPulseCount, setClickPulseCount] = useState(0);
  const [isHoverSuppressed, setIsHoverSuppressed] = useState(false);

  return (
    <header className="dashboard-hero">
      <button
        type="button"
        className={`dashboard-hero-icon-button${isHoverSuppressed ? ' dashboard-hero-icon-button--hover-suppressed' : ''}`}
        aria-label="Pulse Ship Studio logo"
        onClick={() => {
          setIsHoverSuppressed(true);
          setClickPulseCount((count) => count + 1);
        }}
        onMouseLeave={() => setIsHoverSuppressed(false)}
      >
        <img
          key={clickPulseCount}
          src="/ship_studio_icon.png"
          alt="Ship Studio"
          className={`dashboard-hero-icon${clickPulseCount > 0 ? ' dashboard-hero-icon--click-pulsing' : ''}`}
          onAnimationEnd={() => {
            if (clickPulseCount > 0) setClickPulseCount(0);
          }}
        />
      </button>
      <h1 className="dashboard-hero-title text-style-display">What will you Ship today?</h1>
    </header>
  );
}
