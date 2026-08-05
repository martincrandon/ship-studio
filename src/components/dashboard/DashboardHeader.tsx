/**
 * DashboardHeader — the presentation-only hero for the dashboard home screen.
 *
 * @module components/DashboardHeader
 */

export function DashboardHeader() {
  return (
    <header className="dashboard-hero">
      <img src="/ship_studio_icon.png" alt="Ship Studio" className="dashboard-hero-icon" />
      <h1 className="dashboard-hero-title text-style-display">What will you Ship today?</h1>
    </header>
  );
}
