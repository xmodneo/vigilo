import Link from 'next/link';

import styles from './landing.module.css';

const REPO = 'https://github.com/xmodneo/vigilo';
const DESIGN_DOC = `${REPO}/blob/main/docs/DESIGN.md`;
const EVIDENCE_DOC = `${REPO}/blob/main/docs/evidence/historical/README.md`;

type StageStatus = 'live' | 'partial' | 'implemented';

const stageStatusLabel: Record<StageStatus, string> = {
  live: 'Demonstrated live',
  partial: 'Ran live · no accepted diagnosis',
  implemented: 'Implemented · not live-accepted',
};

const stages: ReadonlyArray<{ title: string; status: StageStatus; detail: string }> = [
  {
    title: 'Freeze',
    status: 'live',
    detail: 'Bind a run to one public commit and source manifest through the GitHub App.',
  },
  {
    title: 'Baseline',
    status: 'live',
    detail: 'Reproduce the failing test in a fresh vcpu_1 Sandbox with deny-all networking.',
  },
  {
    title: 'Investigate',
    status: 'partial',
    detail: 'Gemini inspects the failure through four read-only tools and a strict conclusion schema.',
  },
  {
    title: 'Candidate',
    status: 'implemented',
    detail: 'Freeze an exact, validated set of changed files before anything moves forward.',
  },
  {
    title: 'Verify',
    status: 'implemented',
    detail: 'Rebuild the pristine base plus the candidate in a separate Sandbox and run the checks again.',
  },
  {
    title: 'Review',
    status: 'implemented',
    detail: 'A person reviews the diagnosis, changed files, and evidence. Draft publication stays gated.',
  },
];

const ledger: ReadonlyArray<{ label: string; value: string; tone?: 'ok' | 'red' }> = [
  { label: 'dependency install', value: 'exit 0', tone: 'ok' },
  { label: 'typecheck', value: 'exit 0', tone: 'ok' },
  { label: 'build', value: 'exit 0', tone: 'ok' },
  { label: 'tests', value: 'exit 1', tone: 'red' },
  { label: 'source identity', value: 'matched', tone: 'ok' },
  { label: 'network policy', value: 'deny-all', tone: 'ok' },
  { label: 'stop / delete / absent', value: 'confirmed', tone: 'ok' },
  { label: 'duration', value: '10.450 s' },
];

const stats: ReadonlyArray<{ value: string; label: string }> = [
  { value: '2', label: 'isolated Sandbox baselines with matched source identity' },
  { value: '≈10 s', label: 'recorded duration of each baseline' },
  { value: 'deny-all', label: 'network policy read back before repository scripts run' },
  { value: '7 / 6', label: 'bounded Gemini requests / audited context operations' },
];

const controls: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: 'Enqueue is not spend',
    detail:
      'Reviewed staging writes the run, checkpoint, six execution grants, and an inert job in one transaction. Nothing starts until a separate worker is invoked.',
  },
  {
    title: 'Exact-job workers',
    detail:
      'Each worker validates and claims one named job, then exits. Leases, ownership tokens, and heartbeats fence lost or concurrent workers.',
  },
  {
    title: 'Verified network policy',
    detail:
      'The Sandbox moves to deny-all and the policy is read back in the same session before any repository script runs.',
  },
  {
    title: 'Fail closed on ambiguity',
    detail:
      'An unclear provider outcome stays consumed and fences further execution. An ambiguous Sandbox create never authorizes a replacement.',
  },
  {
    title: 'Bounded model access',
    detail:
      'Four read-only tools, fixed request budgets, serialized-size ceilings, a strict output schema, and no SDK retries.',
  },
  {
    title: 'Untrusted by default',
    detail:
      'Source files, objectives, and tool results are data. No credentials reach the model or Sandbox commands. Public repositories only.',
  },
];

const baselineRows: ReadonlyArray<[string, string, string]> = [
  ['Install / typecheck / build', 'exit 0 / 0 / 0', 'exit 0 / 0 / 0'],
  ['Tests', 'exit 1', 'exit 1'],
  ['Source identity matched', 'yes', 'yes'],
  ['Network policy', 'deny-all', 'deny-all'],
  ['Stop / delete / absence lookup', 'confirmed', 'confirmed'],
  ['Baseline duration', '10.258 s', '10.450 s'],
];

const requests: ReadonlyArray<[string, string, string]> = [
  ['1', 'Read sanitized baseline summary', '10'],
  ['2', 'List seven indexed paths', '9'],
  ['3', 'Read one test file', '22'],
  ['4', 'Read one source file', '20'],
  ['5', 'Search allowed text (zero matches)', '15'],
  ['6', 'Read package metadata', '18'],
  ['7', 'Reserved tool-free finalization: no accepted conclusion', '275'],
];

const demonstrated = [
  'Frozen-source baselines in isolated Vercel Sandboxes, twice',
  'Source-integrity enforcement and confirmed cleanup',
  'Durable job orchestration with scoped, expiring execution grants',
  'A bounded Gemini investigation with durable request accounting',
];

const notDemonstrated = [
  'An AI-generated candidate patch',
  'An independent green verification in a separate Sandbox',
  'A human-approved repair or a draft pull request',
  'Production hosting, backups, monitoring, or private-repository support',
];

const stack = [
  'TypeScript',
  'Node.js 24',
  'Next.js 16',
  'React 19',
  'Better Auth',
  'PostgreSQL 17',
  'Drizzle',
  'PgBoss',
  'Vercel Sandbox',
  'Gemini 3.1 Flash Lite',
];

export default function Home() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <Link className={styles.wordmark} href="/" aria-label="Vigilo home">
            <span className={styles.mark} aria-hidden="true">
              <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
                <path d="M2 2h2.5L8 11.7 11.5 2H14L9.2 14H6.8L2 2Z" fill="currentColor" />
              </svg>
            </span>
            <span>Vigilo</span>
          </Link>
          <nav className={styles.nav} aria-label="Page sections">
            <a href="#pipeline">Pipeline</a>
            <a href="#architecture">Architecture</a>
            <a href="#evidence">Evidence</a>
            <a href="#controls">Controls</a>
            <a href="#limits">Limits</a>
          </nav>
          <div className={styles.headerActions}>
            <a className={styles.ghostButton} href={REPO} rel="noopener">GitHub</a>
            <Link className={styles.ghostButton} href="/sign-in">Owner sign-in</Link>
          </div>
        </header>

        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>
              <span className={styles.pulse} aria-hidden="true" />
              Engineering preview · v0.9
            </p>
            <h1 id="hero-title" className={styles.title}>AI repair that has to show its work.</h1>
            <p className={styles.lede}>
              Vigilo freezes a public Node.js commit, measures the failing baseline in an isolated
              Sandbox, lets a bounded model investigate, and is built to verify any fix in a
              separate Sandbox before a person ever sees it.
            </p>
            <div className={styles.actions}>
              <a className={styles.primary} href={REPO} rel="noopener">View on GitHub</a>
              <a className={styles.secondary} href={EVIDENCE_DOC} rel="noopener">Read the evidence</a>
            </div>
            <p className={styles.honesty}>
              <strong>Honest status:</strong> the autonomous repair path has not passed live
              acceptance. <a href="#limits">See exactly what is and is not demonstrated.</a>
            </p>
          </div>

          <figure className={styles.ledger}>
            <figcaption className={styles.ledgerHead}>
              <span>Recorded baseline · attempt 2</span>
              <span className={styles.ledgerTag}>frozen fixture</span>
            </figcaption>
            <dl className={styles.ledgerBody}>
              {ledger.map((row) => (
                <div key={row.label} className={styles.ledgerRow}>
                  <dt>{row.label}</dt>
                  <dd className={row.tone === 'red' ? styles.red : row.tone === 'ok' ? styles.ok : undefined}>
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className={styles.ledgerNote}>
              A red test baseline is a measurement, not a repair. It is the starting line.
            </p>
          </figure>
        </section>

        <section className={styles.stats} aria-label="Measured results">
          {stats.map((stat) => (
            <div key={stat.value} className={styles.stat}>
              <span className={styles.statValue}>{stat.value}</span>
              <span className={styles.statLabel}>{stat.label}</span>
            </div>
          ))}
        </section>

        <section id="pipeline" className={styles.section} aria-labelledby="pipeline-title">
          <div className={styles.sectionHead}>
            <p className={styles.kicker}>Pipeline</p>
            <h2 id="pipeline-title">Six stages, each bound to evidence.</h2>
            <p>
              Each stage consumes an exact input and leaves a durable record before the next may
              begin. The status of every stage is stated plainly.
            </p>
          </div>
          <ol className={styles.stages}>
            {stages.map((stage, index) => (
              <li key={stage.title} className={styles.stage} data-status={stage.status}>
                <span className={styles.stageIndex} aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <h3>{stage.title}</h3>
                <p>{stage.detail}</p>
                <span className={styles.chip} data-status={stage.status}>{stageStatusLabel[stage.status]}</span>
              </li>
            ))}
          </ol>
        </section>

        <section id="architecture" className={styles.section} aria-labelledby="architecture-title">
          <div className={styles.sectionHead}>
            <p className={styles.kicker}>Architecture</p>
            <h2 id="architecture-title">A modular monolith with hard edges.</h2>
            <p>
              One Next.js control plane and one PostgreSQL store coordinate explicit one-shot
              workers. Anything that touches a provider crosses a reviewed, expiring grant.{' '}
              <a href={DESIGN_DOC} rel="noopener">Read the system design.</a>
            </p>
          </div>
          <p className={styles.scrollHint}>Swipe or scroll to view the full diagram.</p>
          <div
            className={styles.diagram}
            role="region"
            aria-label="Scrollable system architecture diagram"
            tabIndex={0}
          >
            <img
              src="/architecture.svg"
              width={1200}
              height={660}
              alt="Architecture diagram. A Next.js control plane and PostgreSQL store feed exact-job workers, which drive an isolated Vercel Sandbox baseline and a bounded Gemini investigation. Candidate generation, independent verification, and human review are implemented but not live-accepted."
            />
          </div>
        </section>

        <section id="evidence" className={styles.section} aria-labelledby="evidence-title">
          <div className={styles.sectionHead}>
            <p className={styles.kicker}>Measured evidence</p>
            <h2 id="evidence-title">What the live runs actually recorded.</h2>
            <p>
              Two separately approved attempts against a frozen public fixture. Figures come from a
              sanitized, read-only summary of the development database.{' '}
              <a href={EVIDENCE_DOC} rel="noopener">Full evidence package.</a>
            </p>
          </div>
          <p className={styles.scrollHint}>Swipe or scroll each table to view every column.</p>
          <div className={styles.tables}>
            <div
              className={styles.tableCard}
              role="region"
              aria-label="Scrollable baseline results table"
              tabIndex={0}
            >
              <table>
                <caption>Baseline results</caption>
                <thead>
                  <tr><th scope="col">Check</th><th scope="col">Attempt 1</th><th scope="col">Attempt 2</th></tr>
                </thead>
                <tbody>
                  {baselineRows.map(([check, one, two]) => (
                    <tr key={check}><th scope="row">{check}</th><td>{one}</td><td>{two}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              className={styles.tableCard}
              role="region"
              aria-label="Scrollable Gemini investigation table"
              tabIndex={0}
            >
              <table className={styles.numeric}>
                <caption>Attempt 2 · Gemini investigation</caption>
                <thead>
                  <tr><th scope="col">#</th><th scope="col">Operation after response</th><th scope="col">Out tokens</th></tr>
                </thead>
                <tbody>
                  {requests.map(([n, operation, tokens]) => (
                    <tr key={n}><td>{n}</td><td>{operation}</td><td>{tokens}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className={styles.footnote}>
            All seven provider responses succeeded, but the investigation ended{' '}
            <code>model_limit_exceeded</code>. The final response was not retained, so the exact
            cause is unknown. Vigilo stopped there rather than spend on an unexplained failure.
          </p>
        </section>

        <section id="controls" className={styles.section} aria-labelledby="controls-title">
          <div className={styles.sectionHead}>
            <p className={styles.kicker}>Security controls</p>
            <h2 id="controls-title">Designed to fail closed.</h2>
            <p>The interesting engineering is in what the system refuses to do.</p>
          </div>
          <ul className={styles.controls}>
            {controls.map((control) => (
              <li key={control.title}>
                <h3>{control.title}</h3>
                <p>{control.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="limits" className={styles.section} aria-labelledby="limits-title">
          <div className={styles.sectionHead}>
            <p className={styles.kicker}>Limits</p>
            <h2 id="limits-title">Demonstrated, and not yet.</h2>
            <p>
              Vigilo is an engineering preview, not a production service. Credibility depends on
              keeping these two lists honest.
            </p>
          </div>
          <div className={styles.limits}>
            <div className={styles.limitCard} data-kind="yes">
              <h3>Demonstrated</h3>
              <ul>{demonstrated.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
            <div className={styles.limitCard} data-kind="no">
              <h3>Not demonstrated</h3>
              <ul>{notDemonstrated.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          </div>
        </section>

        <section className={styles.stackRow} aria-labelledby="stack-title">
          <h2 id="stack-title" className={styles.kicker}>Built with</h2>
          <ul>{stack.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>

        <footer className={styles.footer}>
          <div>
            <strong>Vigilo</strong>
            <span>Human approval is required. Vigilo never merges or deploys code.</span>
          </div>
          <nav aria-label="Project links">
            <a href={REPO} rel="noopener">Repository</a>
            <a href={DESIGN_DOC} rel="noopener">System design</a>
            <a href={EVIDENCE_DOC} rel="noopener">Evidence</a>
            <Link href="/sign-in">Owner sign-in</Link>
          </nav>
        </footer>
      </div>
    </main>
  );
}
