import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  AnalysisRow,
  average,
  formatDate,
  isSupabaseConfigured,
  loadAnalyses,
  summarize,
  supabaseClient,
} from './dashboard';
import { dashboardConfig } from './config';
import { generateManagerReport } from './report';
import './styles.css';

type Priority = 'Haute' | 'Moyenne' | 'Faible';
type Tone = 'danger' | 'warning' | 'success' | 'primary';

interface ShelfDecision {
  key: string;
  store: string;
  shelf: string;
  category: string;
  status: string;
  emptyRatio: number;
  backRatio: number;
  profitability: number;
  emptySpaces: number;
  backProducts: number;
  priority: Priority;
  priorityScore: number;
  trend: number;
  lastAudit: string;
  audits: number;
}

interface TimelinePoint {
  label: string;
  conformity: number;
  anomalies: number;
  corrected: number;
}

interface RecurringIssue {
  key: string;
  shelf: string;
  category: string;
  count: number;
  profitability: number;
}

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function dayKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function shortDay(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(value));
}

function statusFrom(row: AnalysisRow): string {
  if (row.status === 'Critique' || row.severity === 'high' || row.weighted_profitability_percent < 65) return 'Critique';
  if (row.status === 'Moyen' || row.weighted_profitability_percent < 85) return 'Moyen';
  return 'Bon';
}

function toneFromStatus(status: string): Tone {
  if (status === 'Critique') return 'danger';
  if (status === 'Moyen') return 'warning';
  return 'success';
}

function toneFromPriority(priority: Priority): Tone {
  if (priority === 'Haute') return 'danger';
  if (priority === 'Moyenne') return 'warning';
  return 'success';
}

function priorityFrom(row: AnalysisRow, trend: number): Priority {
  if (
    statusFrom(row) === 'Critique' ||
    row.empty_ratio_percent >= 15 ||
    row.back_ratio_percent >= 10 ||
    row.weighted_profitability_percent < 70 ||
    trend <= -8
  ) return 'Haute';

  if (
    statusFrom(row) === 'Moyen' ||
    row.empty_ratio_percent >= 7 ||
    row.back_ratio_percent >= 5 ||
    row.weighted_profitability_percent < 85 ||
    trend <= -4
  ) return 'Moyenne';

  return 'Faible';
}

function trendLabel(value: number): string {
  if (Math.abs(value) < 1) return 'Stable';
  return `${value > 0 ? '+' : ''}${Math.round(value)} pts`;
}

function issueCount(rows: AnalysisRow[]): number {
  return rows.reduce((sum, row) => sum + row.empty_spaces + row.back_products, 0);
}

function buildShelfDecisions(rows: AnalysisRow[]): ShelfDecision[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    const key = `${row.store_name}__${row.shelf_name}`;
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .map(([key, items]) => {
      const sorted = [...items].sort((a, b) => new Date(b.audit_date).getTime() - new Date(a.audit_date).getTime());
      const latest = sorted[0];
      const previous = sorted[1];
      const trend = previous
        ? latest.weighted_profitability_percent - previous.weighted_profitability_percent
        : 0;
      const priority = priorityFrom(latest, trend);
      const priorityScore =
        (100 - latest.weighted_profitability_percent) +
        latest.empty_ratio_percent * 1.5 +
        latest.back_ratio_percent * 1.2 +
        (trend < 0 ? Math.abs(trend) * 2 : 0);

      return {
        key,
        store: latest.store_name,
        shelf: latest.shelf_name,
        category: latest.category,
        status: statusFrom(latest),
        emptyRatio: latest.empty_ratio_percent,
        backRatio: latest.back_ratio_percent,
        profitability: latest.weighted_profitability_percent,
        emptySpaces: latest.empty_spaces,
        backProducts: latest.back_products,
        priority,
        priorityScore,
        trend,
        lastAudit: latest.audit_date,
        audits: sorted.length,
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

function buildTimeline(rows: AnalysisRow[], maxPoints = 7): TimelinePoint[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    const key = dayKey(row.audit_date);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-maxPoints)
    .map(([key, items], index, all) => {
      const anomalies = issueCount(items);
      const previous = index > 0 ? issueCount(all[index - 1][1]) : anomalies;

      return {
        label: shortDay(key),
        conformity: average(items.map((item) => item.weighted_profitability_percent)),
        anomalies,
        corrected: Math.max(0, previous - anomalies),
      };
    });
}

function buildRecurringIssues(rows: AnalysisRow[]): RecurringIssue[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    const key = `${row.store_name}__${row.shelf_name}`;
    if (statusFrom(row) === 'Bon' && row.empty_ratio_percent < 7 && row.back_ratio_percent < 5) continue;
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .map(([key, items]) => {
      const sorted = [...items].sort((a, b) => new Date(b.audit_date).getTime() - new Date(a.audit_date).getTime());
      return {
        key,
        shelf: sorted[0].shelf_name,
        category: sorted[0].category,
        count: items.length,
        profitability: average(items.map((item) => item.weighted_profitability_percent)),
      };
    })
    .sort((a, b) => b.count - a.count || a.profitability - b.profitability)
    .slice(0, 5);
}

function isToday(value: string): boolean {
  return dayKey(value) === dayKey(new Date().toISOString());
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const escape = (value: string | number) => {
    const text = String(value ?? '');
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [headers, ...rows].map((row) => row.map(escape).join(';')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.();
}

type Range = '7d' | '30d' | 'all';
const RANGE_DAYS: Record<Range, number> = { '7d': 7, '30d': 30, all: 36500 };
const RANGE_LABELS: Record<Range, string> = { '7d': '7 jours', '30d': '30 jours', all: 'Tout' };
const DEFAULT_EMPTY = 10;
const DEFAULT_BACK = 7;

function scopeByRange(rows: AnalysisRow[], range: Range): AnalysisRow[] {
  if (range === 'all') return rows;
  const cutoff = Date.now() - RANGE_DAYS[range] * 86400000;
  return rows.filter((row) => new Date(row.audit_date).getTime() >= cutoff);
}

function readParams() {
  const p = new URLSearchParams(window.location.search);
  const r = p.get('range');
  return {
    range: (r === '7d' || r === '30d' || r === 'all' ? r : 'all') as Range,
    query: p.get('q') ?? '',
    emptyTh: Number(p.get('empty')) || DEFAULT_EMPTY,
    backTh: Number(p.get('back')) || DEFAULT_BACK,
  };
}

function buildQuery(range: Range, query: string, emptyTh: number, backTh: number): string {
  const p = new URLSearchParams();
  if (range !== 'all') p.set('range', range);
  if (query) p.set('q', query);
  if (emptyTh !== DEFAULT_EMPTY) p.set('empty', String(emptyTh));
  if (backTh !== DEFAULT_BACK) p.set('back', String(backTh));
  return p.toString();
}

export default function App() {
  const [rows, setRows] = useState<AnalysisRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function refresh(showLoading = false) {
    try {
      if (showLoading) setLoading(true);
      else setRefreshing(true);
      setError(null);
      const data = await loadAnalyses({
        storeName: dashboardConfig.storeName,
        category: dashboardConfig.category,
        limit: dashboardConfig.limit,
      });
      setRows(data);
      setLastUpdated(new Date());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement Supabase.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      setError('Variables Supabase manquantes.');
      return;
    }

    void refresh(true);

    const intervalId = window.setInterval(() => {
      void refresh();
    }, dashboardConfig.refreshMs);

    const channel = supabaseClient
      ?.channel('shelfguide-dashboard-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shelfguide_analyses' },
        () => void refresh(),
      )
      .subscribe();

    return () => {
      window.clearInterval(intervalId);
      if (channel) void supabaseClient?.removeChannel(channel);
    };
  }, []);

  const initial = useRef(readParams()).current;
  const [range, setRange] = useState<Range>(initial.range);
  const [query, setQuery] = useState(initial.query);
  const [emptyTh, setEmptyTh] = useState(initial.emptyTh);
  const [backTh, setBackTh] = useState(initial.backTh);
  const [panel, setPanel] = useState<null | 'settings' | 'share'>(null);
  const [copied, setCopied] = useState(false);

  const scopedRows = useMemo(() => scopeByRange(rows, range), [rows, range]);
  const summary = useMemo(() => summarize(scopedRows), [scopedRows]);
  const shelves = useMemo(() => buildShelfDecisions(scopedRows), [scopedRows]);
  const timeline = useMemo(() => buildTimeline(scopedRows, range === '7d' ? 7 : 14), [scopedRows, range]);
  const recurringIssues = useMemo(() => buildRecurringIssues(scopedRows), [scopedRows]);
  const filteredShelves = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return shelves;
    return shelves.filter((s) => `${s.shelf} ${s.category} ${s.store}`.toLowerCase().includes(q));
  }, [shelves, query]);

  const qs = buildQuery(range, query, emptyTh, backTh);
  const snapshotUrl = `${window.location.origin}${window.location.pathname}${qs ? '?' + qs : ''}`;

  useEffect(() => {
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [qs]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(id);
  }, [copied]);

  function exportCsv() {
    downloadCsv(
      `shelfguide-rayons-${dayKey(new Date().toISOString())}.csv`,
      ['Rayon', 'Categorie', 'Magasin', 'Statut', 'Vide %', 'Back-side %', 'Profitabilite %', 'Tendance pts', 'Priorite', 'Dernier audit', 'Audits'],
      shelves.map((s) => [
        s.shelf, s.category, s.store, s.status,
        Math.round(s.emptyRatio), Math.round(s.backRatio), Math.round(s.profitability),
        Math.round(s.trend), s.priority, formatDate(s.lastAudit), s.audits,
      ]),
    );
  }

  function copySnapshot() {
    void navigator.clipboard?.writeText(snapshotUrl).then(() => setCopied(true));
  }

  const priorityShelf = shelves[0];

  function exportPdf() {
    generateManagerReport({
      perimetre: dashboardConfig.storeName || 'Tous magasins',
      periode: RANGE_LABELS[range],
      summary: {
        avgProfitability: summary.avgProfitability,
        avgEmptyRatio: summary.avgEmptyRatio,
        avgBackRatio: summary.avgBackRatio,
        audits: summary.audits,
      },
      counts: { shelves: shelves.length, critical: criticalCount, medium: mediumCount, good: goodCount },
      priorityShelf: priorityShelf
        ? { shelf: priorityShelf.shelf, profitability: priorityShelf.profitability, emptyRatio: priorityShelf.emptyRatio, backRatio: priorityShelf.backRatio }
        : undefined,
      shelves: shelves.slice(0, 12).map((s) => ({
        shelf: s.shelf, category: s.category, store: s.store, status: s.status,
        emptyRatio: s.emptyRatio, backRatio: s.backRatio, profitability: s.profitability, trend: s.trend, priority: s.priority,
      })),
      recurring: recurringIssues.map((r) => ({ shelf: r.shelf, category: r.category, count: r.count })),
      timeline: timeline.map((t) => ({ label: t.label, conformity: t.conformity })),
      thresholds: { empty: emptyTh, back: backTh },
    });
  }
  const criticalCount = shelves.filter((shelf) => shelf.status === 'Critique').length;
  const mediumCount = shelves.filter((shelf) => shelf.status === 'Moyen').length;
  const goodCount = shelves.filter((shelf) => shelf.status === 'Bon').length;
  const analysedToday = shelves.filter((shelf) => isToday(shelf.lastAudit)).length;
  const coverageToday = shelves.length > 0 ? (analysedToday / shelves.length) * 100 : 0;
  const openIssues = criticalCount + mediumCount;
  const latestTimeline = timeline[timeline.length - 1];
  const maxAnomalies = Math.max(1, ...timeline.map((point) => point.anomalies));
  const visibleBreaks = shelves.filter((shelf) => shelf.emptyRatio >= emptyTh).slice(0, 4);
  const badOrientation = shelves.filter((shelf) => shelf.backRatio >= backTh).slice(0, 4);
  const degrading = shelves.filter((shelf) => shelf.trend <= -4).slice(0, 4);
  const notAnalysedToday = shelves.filter((shelf) => !isToday(shelf.lastAudit)).slice(0, 4);
  const storeClean = summary.avgProfitability >= 85 && criticalCount === 0;

  return (
    <main className="app-frame">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">SG</div>
          <div>
            <strong>ShelfGuide</strong>
            <span>Manager cockpit</span>
          </div>
        </div>

        <nav className="side-nav" aria-label="Navigation dashboard">
          <a className="active" href="#overview">Vue magasin</a>
          <a href="#ranking">Priorites rayons</a>
          <a href="#alerts">Alertes</a>
          <a href="#timeline">Evolution</a>
        </nav>

        <div className={`sync-card ${error ? 'offline' : 'online'}`}>
          <span className="sync-dot" />
          <strong>{error ? 'Connexion a verifier' : refreshing ? 'Synchronisation' : 'Supabase live'}</strong>
          <small>{lastUpdated ? formatDate(lastUpdated.toISOString()) : 'En attente'}</small>
        </div>
      </aside>

      <section className="workspace">
        <header className="page-header" id="overview">
          <div>
            <p className="eyebrow">Dashboard directeur magasin</p>
            <h1>Etat operationnel des rayons</h1>
            <p className="subtitle">Priorites terrain, performance commerciale et suivi des corrections.</p>
          </div>
          <div className="header-actions">
            <div className="seg" role="group" aria-label="Periode d'analyse">
              {(['7d', '30d', 'all'] as Range[]).map((r) => (
                <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>{RANGE_LABELS[r]}</button>
              ))}
            </div>
            <div className="tool-group">
              <button className="tool-btn" onClick={() => setPanel(panel === 'settings' ? null : 'settings')} title="Reglages des seuils d'alerte">⚙</button>
              <button className="tool-btn" onClick={exportCsv} disabled={rows.length === 0} title="Exporter les rayons en CSV">CSV</button>
              <button className="tool-btn" onClick={exportPdf} disabled={rows.length === 0} title="Generer un rapport PDF professionnel">PDF</button>
              <button className="tool-btn" onClick={toggleFullscreen} title="Mode presentation plein ecran">⛶</button>
              <button className="tool-btn" onClick={() => setPanel(panel === 'share' ? null : 'share')} title="Partager / QR code">⤴</button>
            </div>
            <button className="refresh" onClick={() => void refresh()} disabled={loading || !isSupabaseConfigured}>
              Actualiser
            </button>

            {panel ? <div className="popover-backdrop" onClick={() => setPanel(null)} /> : null}
            {panel === 'settings' ? (
              <div className="popover">
                <h3>Seuils d'alerte</h3>
                <label className="field">
                  <span>Vide critique <b>{emptyTh}%</b></span>
                  <input type="range" min={3} max={30} value={emptyTh} onChange={(e) => setEmptyTh(Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Back-side critique <b>{backTh}%</b></span>
                  <input type="range" min={2} max={20} value={backTh} onChange={(e) => setBackTh(Number(e.target.value))} />
                </label>
                <button className="ghost-btn" onClick={() => { setEmptyTh(DEFAULT_EMPTY); setBackTh(DEFAULT_BACK); }}>Reinitialiser</button>
              </div>
            ) : null}
            {panel === 'share' ? (
              <div className="popover share">
                <h3>Partager cette vue</h3>
                <p>Scannez pour ouvrir sur mobile (filtres inclus)</p>
                <div className="qr"><QRCodeSVG value={snapshotUrl} size={148} bgColor="#ffffff" fgColor="#111111" level="M" /></div>
                <div className="share-url">
                  <input readOnly value={snapshotUrl} onFocus={(e) => e.currentTarget.select()} />
                  <button onClick={copySnapshot}>{copied ? 'Copie !' : 'Copier'}</button>
                </div>
              </div>
            ) : null}
          </div>
        </header>

        {error ? <div className="notice danger">{error}</div> : null}
        {loading ? <div className="notice">Chargement des analyses Supabase...</div> : null}

        {!loading && rows.length === 0 && !error ? (
          <div className="empty">Aucune analyse disponible pour ce perimetre.</div>
        ) : null}

        {rows.length > 0 ? (
          <>
            <section className="command-grid">
              <article className="command-card score-card">
                <div className="section-heading">
                  <span>Score global conformite</span>
                  <StatusBadge tone={storeClean ? 'success' : 'warning'} label={storeClean ? 'Magasin propre' : 'Plan action'} />
                </div>
                <div className="score-layout">
                  <div>
                    <strong className="score-value"><CountUp value={pct(summary.avgProfitability)} /></strong>
                    <p>
                      {storeClean
                        ? 'La surface est globalement maitrisee.'
                        : `${openIssues} rayons demandent une verification terrain.`}
                    </p>
                  </div>
                  <div
                    className="score-ring"
                    style={{ '--score': `${clamp(summary.avgProfitability)}%` } as CSSProperties}
                  >
                    <span><CountUp value={pct(summary.avgProfitability)} /></span>
                  </div>
                </div>
              </article>

              <article className="command-card priority-card">
                <div className="section-heading">
                  <span>Rayon prioritaire</span>
                  <StatusBadge tone={priorityShelf ? toneFromPriority(priorityShelf.priority) : 'primary'} label={priorityShelf?.priority ?? 'N/A'} />
                </div>
                <strong className="priority-title">{priorityShelf?.shelf ?? 'Aucun rayon'}</strong>
                <p>
                  {priorityShelf
                    ? `${pct(priorityShelf.emptyRatio)} vide, ${pct(priorityShelf.backRatio)} back-side, ${pct(priorityShelf.profitability)} profitabilite.`
                    : 'Aucune priorite detectee.'}
                </p>
                {priorityShelf ? (
                  <div className="mini-metrics">
                    <span>Impact commercial</span>
                    <strong>{pct(100 - priorityShelf.profitability)} de perte potentielle</strong>
                  </div>
                ) : null}
              </article>

              <article className="command-card execution-card">
                <div className="section-heading">
                  <span>Execution equipe</span>
                  <StatusBadge tone={coverageToday >= 80 ? 'success' : 'warning'} label={`${pct(coverageToday)} aujourd'hui`} />
                </div>
                <strong className="priority-title">{latestTimeline?.corrected ?? 0} anomalies corrigees</strong>
                <p>Couverture du jour: {analysedToday}/{shelves.length} rayons analyses.</p>
                <div className="progress-line">
                  <i style={{ width: `${clamp(coverageToday)}%` }} />
                </div>
              </article>
            </section>

            <section className="metric-grid">
              <MetricCard label="Rayons analyses" value={String(shelves.length)} detail={`${summary.audits} audits`} />
              <MetricCard label="Critiques" value={String(criticalCount)} detail="Action immediate" tone="danger" />
              <MetricCard label="Moyens" value={String(mediumCount)} detail="A corriger" tone="warning" />
              <MetricCard label="Bons" value={String(goodCount)} detail="Conformes" tone="success" />
              <MetricCard label="Vide moyen" value={pct(summary.avgEmptyRatio)} detail={`${summary.emptySpaces} facings vides`} tone="warning" />
              <MetricCard label="Back-side moyen" value={pct(summary.avgBackRatio)} detail={`${summary.backProducts} produits`} />
              <MetricCard label="Profitabilite" value={pct(summary.avgProfitability)} detail="Ponderee magasin" tone="success" />
            </section>

            <section className="content-grid">
              <section className="panel table-panel" id="ranking">
                <div className="panel-head">
                  <PanelTitle eyebrow="Priorisation" title="Classement des rayons a corriger" />
                  <input
                    className="search"
                    type="search"
                    placeholder="Rechercher un rayon, categorie..."
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <ShelfTable shelves={filteredShelves.slice(0, 12)} emptyTh={emptyTh} backTh={backTh} />
                {filteredShelves.length === 0 ? <p className="muted">Aucun rayon ne correspond a la recherche.</p> : null}
              </section>

              <section className="panel decisions-panel">
                <PanelTitle eyebrow="Decision" title="Ce que le manager doit faire" />
                <DecisionStack
                  items={[
                    ['Rayon prioritaire', priorityShelf?.shelf ?? 'Aucun rayon'],
                    ['Etat du magasin', storeClean ? 'Globalement propre' : 'Correction requise'],
                    ['Equipe terrain', coverageToday >= 80 ? 'Tour du jour avance' : 'Tour incomplet'],
                    ['Performance perdue', priorityShelf ? `${priorityShelf.shelf} a traiter` : 'Non detectee'],
                  ]}
                />
              </section>

              <section className="panel alerts-panel" id="alerts">
                <PanelTitle eyebrow="Alertes" title="Risques ouverts" />
                <AlertStack
                  visibleBreaks={visibleBreaks}
                  badOrientation={badOrientation}
                  degrading={degrading}
                  notAnalysedToday={notAnalysedToday}
                />
              </section>

              <section className="panel timeline-panel" id="timeline">
                <PanelTitle eyebrow="Evolution" title="Conformite et anomalies corrigees" />
                <Timeline points={timeline} maxAnomalies={maxAnomalies} />
              </section>

              <section className="panel recurring-panel">
                <PanelTitle eyebrow="Recurrence" title="Rayons qui reviennent en probleme" />
                <RecurringList issues={recurringIssues} />
              </section>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}

function CountUp({ value }: { value: string }) {
  const match = value.match(/^(\D*)(-?\d+(?:[.,]\d+)?)(.*)$/);
  const target = match ? parseFloat(match[2].replace(',', '.')) : 0;
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(0);

  useEffect(() => {
    if (!match) {
      setDisplay(value);
      return;
    }
    const prefix = match[1];
    const suffix = match[3];
    const decimals = /[.,]/.test(match[2]) ? match[2].split(/[.,]/)[1]?.length ?? 0 : 0;
    const from = fromRef.current;
    fromRef.current = target;
    const duration = 900;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (target - from) * eased;
      setDisplay(`${prefix}${current.toFixed(decimals)}${suffix}`);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{display}</>;
}

function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}

function MetricCard({
  label,
  value,
  detail,
  tone = 'primary',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: Tone;
}) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong><CountUp value={value} /></strong>
      <small>{detail}</small>
    </article>
  );
}

function PanelTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="panel-title">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
    </div>
  );
}

function ShelfTable({ shelves, emptyTh, backTh }: { shelves: ShelfDecision[]; emptyTh: number; backTh: number }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Rayon</th>
            <th>Statut</th>
            <th>Empty ratio</th>
            <th>Back-side</th>
            <th>Profitabilite</th>
            <th>Tendance</th>
            <th>Priorite</th>
          </tr>
        </thead>
        <tbody>
          {shelves.map((shelf) => (
            <tr key={shelf.key}>
              <td>
                <strong>{shelf.shelf}</strong>
                <small>{shelf.category} - {shelf.store}</small>
              </td>
              <td><StatusBadge tone={toneFromStatus(shelf.status)} label={shelf.status} /></td>
              <td>
                <RatioCell value={shelf.emptyRatio} tone={shelf.emptyRatio >= emptyTh ? 'danger' : shelf.emptyRatio >= emptyTh * 0.7 ? 'warning' : 'success'} />
              </td>
              <td>
                <RatioCell value={shelf.backRatio} tone={shelf.backRatio >= backTh ? 'warning' : 'success'} />
              </td>
              <td>
                <RatioCell value={shelf.profitability} tone={toneFromStatus(shelf.status)} reverse />
              </td>
              <td className={shelf.trend < -1 ? 'trend-down' : shelf.trend > 1 ? 'trend-up' : ''}>{trendLabel(shelf.trend)}</td>
              <td><StatusBadge tone={toneFromPriority(shelf.priority)} label={shelf.priority} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RatioCell({ value, tone, reverse = false }: { value: number; tone: Tone; reverse?: boolean }) {
  const width = reverse ? clamp(value) : clamp(value * 4);

  return (
    <div className="ratio-cell">
      <span>{pct(value)}</span>
      <div className={`ratio-track ${tone}`}>
        <i style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function DecisionStack({ items }: { items: [string, string][] }) {
  return (
    <div className="decision-stack">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function AlertStack({
  visibleBreaks,
  badOrientation,
  degrading,
  notAnalysedToday,
}: {
  visibleBreaks: ShelfDecision[];
  badOrientation: ShelfDecision[];
  degrading: ShelfDecision[];
  notAnalysedToday: ShelfDecision[];
}) {
  const sections = [
    { title: 'Rupture visible', rows: visibleBreaks, metric: (shelf: ShelfDecision) => `${pct(shelf.emptyRatio)} vide` },
    { title: 'Mal orientes', rows: badOrientation, metric: (shelf: ShelfDecision) => `${pct(shelf.backRatio)} back-side` },
    { title: 'En degradation', rows: degrading, metric: (shelf: ShelfDecision) => trendLabel(shelf.trend) },
    { title: 'Non analyses', rows: notAnalysedToday, metric: (shelf: ShelfDecision) => formatDate(shelf.lastAudit) },
  ];

  return (
    <div className="alert-stack">
      {sections.map((section) => (
        <div className="alert-section" key={section.title}>
          <div className="alert-section-title">
            <strong>{section.title}</strong>
            <span>{section.rows.length}</span>
          </div>
          {section.rows.length === 0 ? <p>Aucune alerte active</p> : null}
          {section.rows.map((shelf) => (
            <div className="alert-row" key={`${section.title}-${shelf.key}`}>
              <span>{shelf.shelf}</span>
              <strong>{section.metric(shelf)}</strong>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Timeline({ points, maxAnomalies }: { points: TimelinePoint[]; maxAnomalies: number }) {
  const [active, setActive] = useState<number | null>(null);
  if (points.length === 0) return <p className="muted">Pas encore assez de donnees temporelles.</p>;

  const W = 720;
  const H = 240;
  const padL = 34;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const baseY = padT + innerH;

  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const x = (i: number) => padL + stepX * i;
  const yConf = (v: number) => padT + innerH * (1 - clamp(v, 0, 100) / 100);
  const ySec = (v: number) => padT + innerH * (1 - clamp(v / maxAnomalies, 0, 1));

  const confPoints = points.map((p, i) => [x(i), yConf(p.conformity)] as const);
  const secPoints = points.map((p, i) => [x(i), ySec(p.anomalies)] as const);

  const toPath = (pts: readonly (readonly [number, number])[]) =>
    pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(' ');

  const confLine = toPath(confPoints);
  const areaPath = `${confLine} L${x(points.length - 1).toFixed(1)} ${baseY} L${padL} ${baseY} Z`;
  const secLine = toPath(secPoints);
  const gridValues = [0, 25, 50, 75, 100];
  const hovered = active !== null ? points[active] : null;

  return (
    <div className="timeline">
      <div className="timeline-legend">
        <span><i className="legend-compliance" /> Conformite</span>
        <span><i className="legend-anomaly" /> Anomalies</span>
      </div>

      <div className="chart">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Evolution de la conformite et des anomalies"
          onMouseLeave={() => setActive(null)}
        >
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(214, 73, 47, .22)" />
              <stop offset="100%" stopColor="rgba(214, 73, 47, 0)" />
            </linearGradient>
            <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#d6492f" />
              <stop offset="100%" stopColor="#b5371f" />
            </linearGradient>
          </defs>

          {gridValues.map((g) => {
            const gy = yConf(g);
            return (
              <g key={g}>
                <line className="grid-line" x1={padL} y1={gy} x2={W - padR} y2={gy} />
                <text className="y-label" x={padL - 8} y={gy + 3}>{g}</text>
              </g>
            );
          })}

          <path className="area" d={areaPath} fill="url(#areaFill)" />
          <path className="line anomaly" d={secLine} />
          <path className="line compliance" d={confLine} />

          {confPoints.map((pt, i) => (
            <circle
              key={i}
              className="dot"
              cx={pt[0]}
              cy={pt[1]}
              r={active === i ? 0 : 4}
              style={{ animationDelay: `${0.9 + i * 0.08}s` }}
            />
          ))}

          {hovered ? (
            <g>
              <line className="cursor-line" x1={x(active!)} y1={padT} x2={x(active!)} y2={baseY} />
              <circle className="cursor-dot" cx={x(active!)} cy={yConf(hovered.conformity)} r={5.5} />
            </g>
          ) : null}

          {points.map((p, i) =>
            i % Math.ceil(points.length / 7) === 0 || i === points.length - 1 ? (
              <text key={p.label} className="x-label" x={x(i)} y={H - 8}>{p.label}</text>
            ) : null,
          )}

          {points.map((_, i) => (
            <rect
              key={`hit-${i}`}
              className="hit"
              x={x(i) - (stepX || innerW) / 2}
              y={padT}
              width={stepX || innerW}
              height={innerH}
              onMouseEnter={() => setActive(i)}
            />
          ))}
        </svg>

        {hovered ? (
          <div
            className="chart-tooltip"
            style={{ left: `${(x(active!) / W) * 100}%`, top: `${(yConf(hovered.conformity) / H) * 100}%` }}
          >
            <b>{hovered.label}</b>
            <div className="tt-row">
              <span><i style={{ background: '#d6492f' }} />Conformite</span>
              <strong>{pct(hovered.conformity)}</strong>
            </div>
            <div className="tt-row">
              <span><i style={{ background: '#1c1a17' }} />Anomalies</span>
              <strong>{hovered.anomalies}</strong>
            </div>
            <div className="tt-row">
              <span>Corrigees</span>
              <strong>{hovered.corrected}</strong>
            </div>
          </div>
        ) : null}
      </div>

      {points.length <= 8 ? (
        <div className="chart-foot" style={{ gridTemplateColumns: `repeat(${points.length}, 1fr)` }}>
          {points.map((p) => (
            <small key={p.label}>{pct(p.conformity)} · {p.corrected} corr.</small>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RecurringList({ issues }: { issues: RecurringIssue[] }) {
  if (issues.length === 0) return <p className="muted">Aucun rayon recurrent en probleme.</p>;

  return (
    <div className="recurring-list">
      {issues.map((issue, index) => (
        <div key={issue.key}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>{issue.shelf}</strong>
            <small>{issue.category}</small>
          </div>
          <em>{issue.count} fois</em>
        </div>
      ))}
    </div>
  );
}
