import { useEffect, useMemo, useState } from 'react';
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
import './styles.css';

type Priority = 'Haute' | 'Moyenne' | 'Faible';

interface ShelfDecision {
  shelf: string;
  category: string;
  status: string;
  emptyRatio: number;
  backRatio: number;
  profitability: number;
  priority: Priority;
  priorityScore: number;
  trend: number;
  lastAudit: string;
}

interface TimelinePoint {
  label: string;
  conformity: number;
  anomalies: number;
  corrected: number;
}

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

function statusTone(status: string): string {
  if (status === 'Critique') return 'danger';
  if (status === 'Moyen') return 'warning';
  return 'success';
}

function priorityTone(priority: Priority): string {
  if (priority === 'Haute') return 'danger';
  if (priority === 'Moyenne') return 'warning';
  return 'success';
}

function dayKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function shortDay(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(value));
}

function getStatus(row: AnalysisRow): string {
  if (row.status === 'Critique' || row.weighted_profitability_percent < 65) return 'Critique';
  if (row.status === 'Moyen' || row.weighted_profitability_percent < 85) return 'Moyen';
  return 'Bon';
}

function getPriority(row: AnalysisRow, trend: number): Priority {
  if (
    getStatus(row) === 'Critique' ||
    row.empty_ratio_percent >= 15 ||
    row.back_ratio_percent >= 10 ||
    row.weighted_profitability_percent < 70 ||
    trend <= -8
  ) return 'Haute';

  if (
    getStatus(row) === 'Moyen' ||
    row.empty_ratio_percent >= 7 ||
    row.back_ratio_percent >= 5 ||
    row.weighted_profitability_percent < 85 ||
    trend <= -4
  ) return 'Moyenne';

  return 'Faible';
}

function buildShelfDecisions(rows: AnalysisRow[]): ShelfDecision[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    buckets.set(row.shelf_name, [...(buckets.get(row.shelf_name) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .map(([shelf, items]) => {
      const sorted = [...items].sort((a, b) => new Date(b.audit_date).getTime() - new Date(a.audit_date).getTime());
      const latest = sorted[0];
      const previous = sorted[1];
      const trend = previous
        ? latest.weighted_profitability_percent - previous.weighted_profitability_percent
        : 0;
      const priority = getPriority(latest, trend);
      const priorityScore =
        (100 - latest.weighted_profitability_percent) +
        latest.empty_ratio_percent * 1.6 +
        latest.back_ratio_percent * 1.2 +
        (trend < 0 ? Math.abs(trend) * 2 : 0);

      return {
        shelf,
        category: latest.category,
        status: getStatus(latest),
        emptyRatio: latest.empty_ratio_percent,
        backRatio: latest.back_ratio_percent,
        profitability: latest.weighted_profitability_percent,
        priority,
        priorityScore,
        trend,
        lastAudit: latest.audit_date,
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

function buildTimeline(rows: AnalysisRow[]): TimelinePoint[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    const key = dayKey(row.audit_date);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-7)
    .map(([key, items], index, all) => {
      const anomalies = items.filter((item) => getStatus(item) !== 'Bon').length;
      const previousItems = index > 0 ? all[index - 1][1] : [];
      const previousAnomalies = previousItems.filter((item) => getStatus(item) !== 'Bon').length;

      return {
        label: shortDay(key),
        conformity: average(items.map((item) => item.weighted_profitability_percent)),
        anomalies,
        corrected: Math.max(0, previousAnomalies - anomalies),
      };
    });
}

function isToday(value: string): boolean {
  return dayKey(value) === dayKey(new Date().toISOString());
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
    } catch (err: any) {
      setError(err?.message ?? 'Erreur de chargement Supabase.');
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

  const summary = useMemo(() => summarize(rows), [rows]);
  const shelves = useMemo(() => buildShelfDecisions(rows), [rows]);
  const timeline = useMemo(() => buildTimeline(rows), [rows]);
  const priorityShelf = shelves[0];
  const criticalCount = shelves.filter((shelf) => shelf.status === 'Critique').length;
  const mediumCount = shelves.filter((shelf) => shelf.status === 'Moyen').length;
  const goodCount = shelves.filter((shelf) => shelf.status === 'Bon').length;
  const visibleBreaks = shelves.filter((shelf) => shelf.emptyRatio >= 10).slice(0, 4);
  const badOrientation = shelves.filter((shelf) => shelf.backRatio >= 7).slice(0, 4);
  const degrading = shelves.filter((shelf) => shelf.trend <= -4).slice(0, 4);
  const notAnalysedToday = shelves.filter((shelf) => !isToday(shelf.lastAudit)).slice(0, 4);
  const recurringIssues = shelves.filter((shelf) => shelf.priority !== 'Faible').slice(0, 5);
  const maxAnomalies = Math.max(...timeline.map((point) => point.anomalies), 1);
  const latestTimeline = timeline[timeline.length - 1];

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">{dashboardConfig.eyebrow}</p>
          <h1>Dashboard Manager Magasin</h1>
          <p className="subtitle">Pilotage live des rayons, alertes terrain et priorites commerciales.</p>
        </div>
        <div className="actions">
          <div className={`live-status ${error ? 'offline' : 'online'}`}>
            <span />
            <strong>{error ? 'Connexion a verifier' : refreshing ? 'Synchronisation...' : 'Live Supabase'}</strong>
            <small>{lastUpdated ? `Mis a jour ${formatDate(lastUpdated.toISOString())}` : 'En attente'}</small>
          </div>
          <button className="refresh" onClick={() => void refresh()} disabled={loading || !isSupabaseConfigured}>
            Actualiser
          </button>
        </div>
      </header>

      {error ? <div className="notice">{error}</div> : null}
      {loading ? <div className="notice">Chargement des resultats...</div> : null}

      {!loading && rows.length === 0 && !error ? (
        <div className="empty">Aucune analyse disponible pour ce perimetre.</div>
      ) : null}

      {rows.length > 0 ? (
        <>
          <section className="decision-strip">
            <article className="score-card">
              <span>Score global conformite</span>
              <strong>{pct(summary.avgProfitability)}</strong>
              <div className="score-track">
                <i style={{ width: `${Math.min(100, Math.max(0, summary.avgProfitability))}%` }} />
              </div>
              <small>{summary.avgProfitability >= 85 ? 'Magasin propre' : 'Plan de correction requis'}</small>
            </article>
            <article className="priority-card">
              <span>Rayon prioritaire</span>
              <strong>{priorityShelf?.shelf ?? 'N/A'}</strong>
              <small>
                {priorityShelf
                  ? `${pct(priorityShelf.profitability)} profitabilite - ${pct(priorityShelf.emptyRatio)} vide`
                  : 'Aucun rayon analyse'}
              </small>
            </article>
            <article className="scope-card">
              <span>Perimetre</span>
              <strong>{dashboardConfig.storeName || 'Tous magasins'}</strong>
              <small>Source Supabase / shelfguide_analyses</small>
            </article>
          </section>

          <section className="kpis">
            <Kpi label="Rayons analyses" value={String(shelves.length)} />
            <Kpi label="Rayons critiques" value={String(criticalCount)} tone="danger" />
            <Kpi label="Rayons moyens" value={String(mediumCount)} tone="warning" />
            <Kpi label="Rayons bons" value={String(goodCount)} tone="success" />
            <Kpi label="Vide moyen" value={pct(summary.avgEmptyRatio)} tone="warning" />
            <Kpi label="Back-side moyen" value={pct(summary.avgBackRatio)} />
            <Kpi label="Profitabilite ponderee" value={pct(summary.avgProfitability)} tone="success" />
          </section>

          <section className="manager-grid">
            <Panel title="Classement des rayons" wide>
              <ShelfTable shelves={shelves.slice(0, 10)} />
            </Panel>

            <Panel title="Decision attendue">
              <DecisionList
                items={[
                  ['Priorite immediate', priorityShelf?.shelf ?? 'Aucun rayon'],
                  ['Etat magasin', summary.avgProfitability >= 85 ? 'Globalement propre' : 'A surveiller'],
                  ['Correction equipe', latestTimeline?.corrected ? `${latestTimeline.corrected} anomalies corrigees` : 'A confirmer'],
                  ['Perte commerciale', priorityShelf ? `${priorityShelf.shelf} impacte la performance` : 'N/A'],
                ]}
              />
            </Panel>

            <Panel title="Alertes magasin" wide>
              <Alerts
                visibleBreaks={visibleBreaks}
                badOrientation={badOrientation}
                degrading={degrading}
                notAnalysedToday={notAnalysedToday}
              />
            </Panel>

            <Panel title="Evolution temporelle" wide>
              <Timeline points={timeline} maxAnomalies={maxAnomalies} />
            </Panel>

            <Panel title="Rayons recurrents en probleme">
              <RecurringList shelves={recurringIssues} />
            </Panel>
          </section>
        </>
      ) : null}
    </main>
  );
}

function Kpi({ label, value, tone = 'primary' }: { label: string; value: string; tone?: string }) {
  return (
    <article className={`kpi ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function Panel({ title, children, wide = false }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`panel ${wide ? 'wide' : ''}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ShelfTable({ shelves }: { shelves: ShelfDecision[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Rayon</th>
            <th>Statut</th>
            <th>Empty ratio</th>
            <th>Back/side ratio</th>
            <th>Profitabilite</th>
            <th>Priorite</th>
          </tr>
        </thead>
        <tbody>
          {shelves.map((shelf) => (
            <tr key={shelf.shelf}>
              <td>
                <strong>{shelf.shelf}</strong>
                <small>{shelf.category}</small>
              </td>
              <td><span className={`pill ${statusTone(shelf.status)}`}>{shelf.status}</span></td>
              <td>{pct(shelf.emptyRatio)}</td>
              <td>{pct(shelf.backRatio)}</td>
              <td>{pct(shelf.profitability)}</td>
              <td><span className={`pill ${priorityTone(shelf.priority)}`}>{shelf.priority}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DecisionList({ items }: { items: [string, string][] }) {
  return (
    <div className="decision-list">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function Alerts({
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
  return (
    <div className="alerts-grid">
      <AlertColumn title="Rupture visible" shelves={visibleBreaks} metric={(shelf) => pct(shelf.emptyRatio)} />
      <AlertColumn title="Produits mal orientes" shelves={badOrientation} metric={(shelf) => pct(shelf.backRatio)} />
      <AlertColumn title="Rayons en degradation" shelves={degrading} metric={(shelf) => `${Math.round(shelf.trend)} pts`} />
      <AlertColumn title="Non analyses aujourd'hui" shelves={notAnalysedToday} metric={(shelf) => formatDate(shelf.lastAudit)} />
    </div>
  );
}

function AlertColumn({
  title,
  shelves,
  metric,
}: {
  title: string;
  shelves: ShelfDecision[];
  metric: (shelf: ShelfDecision) => string;
}) {
  return (
    <div className="alert-column">
      <h3>{title}</h3>
      {shelves.length === 0 ? <p>Aucune alerte</p> : null}
      {shelves.map((shelf) => (
        <div className="alert-row" key={`${title}-${shelf.shelf}`}>
          <strong>{shelf.shelf}</strong>
          <span>{metric(shelf)}</span>
        </div>
      ))}
    </div>
  );
}

function Timeline({ points, maxAnomalies }: { points: TimelinePoint[]; maxAnomalies: number }) {
  return (
    <div className="timeline">
      {points.map((point) => (
        <div className="timeline-day" key={point.label}>
          <div className="timeline-bars">
            <span style={{ height: `${Math.max(10, point.conformity)}%` }} />
            <i style={{ height: `${Math.max(8, (point.anomalies / maxAnomalies) * 100)}%` }} />
          </div>
          <strong>{point.label}</strong>
          <small>{pct(point.conformity)} / {point.corrected} corr.</small>
        </div>
      ))}
    </div>
  );
}

function RecurringList({ shelves }: { shelves: ShelfDecision[] }) {
  return (
    <div className="recurring-list">
      {shelves.map((shelf) => (
        <div key={shelf.shelf}>
          <strong>{shelf.shelf}</strong>
          <span>{shelf.priority} - {pct(shelf.profitability)}</span>
        </div>
      ))}
    </div>
  );
}
