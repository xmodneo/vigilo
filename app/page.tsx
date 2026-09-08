const safeguards = [
  {
    number: '01',
    title: 'Isolated execution',
    detail: 'Repository code runs inside a disposable sandbox with explicit boundaries.',
  },
  {
    number: '02',
    title: 'Exact candidates',
    detail: 'Every changed byte is validated and frozen before it moves forward.',
  },
  {
    number: '03',
    title: 'Fresh verification',
    detail: 'A separate sandbox reconstructs and tests the repair from pristine source.',
  },
] as const;

export default function Home() {
  return (
    <main>
      <header className="site-header" aria-label="Vigilo">
        <a className="wordmark" href="/" aria-label="Vigilo home">
          <span className="wordmark-mark" aria-hidden="true">V</span>
          <span>Vigilo</span>
        </a>
        <div className="site-actions">
          <span className="release-label">Development preview</span>
          <a className="header-action" href="/sign-in">Sign in with GitHub</a>
        </div>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">Autonomous software maintenance</p>
          <h1 id="hero-title">Repairs built inside a boundary you can trust.</h1>
          <p className="hero-summary">
            Vigilo is a sandbox-first software maintenance platform. It prepares
            focused repairs and has them independently verified before publication.
          </p>
        </div>

        <aside className="status-panel" aria-labelledby="status-title">
          <p className="status-kicker">Current status</p>
          <h2 id="status-title">Milestone 1 complete</h2>
          <p>
            The isolated repair and fresh-verification boundary is proven against
            a deterministic fixture.
          </p>
          <div className="next-step">
            <span className="status-dot" aria-hidden="true" />
            <span>Repository selection available; execution setup comes next</span>
          </div>
        </aside>
      </section>

      <section className="safeguards" aria-labelledby="safeguards-title">
        <div className="section-heading">
          <p className="eyebrow">Safety model</p>
          <h2 id="safeguards-title">Evidence at every boundary</h2>
        </div>
        <ol className="safeguard-list">
          {safeguards.map((safeguard) => (
            <li key={safeguard.number}>
              <span className="safeguard-number" aria-hidden="true">
                {safeguard.number}
              </span>
              <h3>{safeguard.title}</h3>
              <p>{safeguard.detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <footer>
        <span>Vigilo</span>
        <span>Human approval remains the final gate.</span>
      </footer>
    </main>
  );
}
