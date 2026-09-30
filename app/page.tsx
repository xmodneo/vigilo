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
          <span className="release-label">Controlled beta</span>
          <a className="header-action" href="/sign-in">Sign in with GitHub</a>
        </div>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">Evidence-backed repair workflow</p>
          <h1 id="hero-title">A repair garage for AI builders.</h1>
          <p className="hero-summary">
            Vigilo diagnoses a reproducible problem, prepares an exact repair candidate,
            checks it in a fresh verification environment, and presents the evidence for human review.
          </p>
          <p><strong>Controlled beta limitations apply.</strong></p>
        </div>

        <aside className="status-panel" aria-labelledby="status-title">
          <p className="status-kicker">Release scope</p>
          <h2 id="status-title">Public Node.js repositories</h2>
          <p>
            The controlled beta supports eligible public, single-package Node.js 24/npm repositories.
            Repairs may be inconclusive, fail verification, or require reconciliation.
          </p>
          <div className="next-step">
            <span className="status-dot" aria-hidden="true" />
            <span>No automatic merge or deployment; draft publication remains unavailable pending independent live acceptance</span>
          </div>
        </aside>
      </section>

      <section className="safeguards" aria-labelledby="first-run-title">
        <div className="section-heading">
          <p className="eyebrow">How it works</p>
          <h2 id="first-run-title">From reproducible problem to reviewed evidence</h2>
        </div>
        <ol className="first-run-list">
          <li>Connect GitHub.</li><li>Choose an eligible public repository.</li>
          <li>Describe the problem and start an authorized repair.</li><li>Vigilo measures the frozen baseline and diagnoses the problem.</li>
          <li>Vigilo prepares an exact candidate.</li><li>A fresh verifier checks that candidate.</li>
          <li>Review the diagnosis, changed files, and measured evidence.</li><li>Separately publish a draft PR only when publication authority is available.</li>
        </ol>
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
        <span>Human approval is required and never merges or deploys code.</span>
      </footer>
    </main>
  );
}
