import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

/* ============================================================
   ShelfGuide — generateur de rapport PDF (magasin)
   Document professionnel, branche, 2 a 3 pages max.
   ============================================================ */

type RGB = [number, number, number];

const ACCENT: RGB = [214, 73, 47];      // vermilion
const INK: RGB = [28, 26, 23];
const MUTED: RGB = [120, 118, 110];
const RULE: RGB = [222, 216, 202];
const ZEBRA: RGB = [248, 246, 240];
const OK: RGB = [63, 125, 92];
const WARN: RGB = [176, 125, 42];
const BAD: RGB = [192, 57, 43];

export interface ReportShelf {
  shelf: string;
  category: string;
  store: string;
  status: string;
  emptyRatio: number;
  backRatio: number;
  profitability: number;
  trend: number;
  priority: string;
}

export interface ManagerReport {
  perimetre: string;
  periode: string;
  summary: { avgProfitability: number; avgEmptyRatio: number; avgBackRatio: number; audits: number };
  counts: { shelves: number; critical: number; medium: number; good: number };
  priorityShelf?: { shelf: string; profitability: number; emptyRatio: number; backRatio: number };
  shelves: ReportShelf[];
  recurring: { shelf: string; category: string; count: number }[];
  timeline: { label: string; conformity: number }[];
  thresholds: { empty: number; back: number };
}

const pct = (v: number) => `${Math.round(v)}%`;

function nowLabel(): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
}

function header(doc: jsPDF, M: number, W: number, title: string, meta: string) {
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, W, 6, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text('ShelfGuide', M, 32);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...MUTED);
  doc.text('RAPPORT DIRECTEUR MAGASIN', W - M, 32, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(21);
  doc.setTextColor(...INK);
  doc.text(title, M, 66);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(meta, M, 84);

  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.8);
  doc.line(M, 94, W - M, 94);
}

function sectionTitle(doc: jsPDF, M: number, y: number, label: string) {
  doc.setFillColor(...ACCENT);
  doc.rect(M, y - 9, 3, 12, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...INK);
  doc.text(label, M + 9, y);
}

function kpiRow(doc: jsPDF, M: number, y: number, W: number, items: { label: string; value: string; tone?: RGB }[]) {
  const gap = 12;
  const h = 60;
  const n = items.length;
  const w = (W - M * 2 - gap * (n - 1)) / n;
  items.forEach((it, i) => {
    const x = M + i * (w + gap);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.8);
    doc.setFillColor(252, 251, 248);
    doc.roundedRect(x, y, w, h, 4, 4, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(it.label.toUpperCase(), x + 12, y + 18);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(...(it.tone ?? INK));
    doc.text(it.value, x + 12, y + 44);
  });
  return y + h;
}

function sparkline(doc: jsPDF, M: number, y: number, W: number, points: { label: string; conformity: number }[]) {
  const h = 96;
  const x = M;
  const w = W - M * 2;
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.8);
  doc.setFillColor(252, 251, 248);
  doc.roundedRect(x, y, w, h, 4, 4, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text('EVOLUTION DE LA CONFORMITE', x + 12, y + 16);

  const padL = x + 34;
  const padR = x + w - 14;
  const top = y + 26;
  const bottom = y + h - 20;
  const innerH = bottom - top;

  // gridlines 0 / 50 / 100
  [0, 50, 100].forEach((g) => {
    const gy = bottom - (g / 100) * innerH;
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.4);
    doc.line(padL, gy, padR, gy);
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text(String(g), padL - 6, gy + 2, { align: 'right' });
  });

  if (points.length === 0) return y + h;

  const span = padR - padL;
  const step = points.length > 1 ? span / (points.length - 1) : 0;
  const px = (i: number) => padL + step * i;
  const py = (v: number) => bottom - (Math.max(0, Math.min(100, v)) / 100) * innerH;

  doc.setDrawColor(...ACCENT);
  doc.setLineWidth(1.6);
  for (let i = 1; i < points.length; i++) {
    doc.line(px(i - 1), py(points[i - 1].conformity), px(i), py(points[i].conformity));
  }
  doc.setFillColor(...ACCENT);
  points.forEach((p, i) => {
    doc.circle(px(i), py(p.conformity), 1.8, 'F');
    if (i % Math.ceil(points.length / 7) === 0 || i === points.length - 1) {
      doc.setFontSize(6.5);
      doc.setTextColor(...MUTED);
      doc.text(p.label, px(i), bottom + 12, { align: 'center' });
    }
  });
  return y + h;
}

function bullets(doc: jsPDF, M: number, y: number, W: number, lines: string[]) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  let cy = y;
  lines.forEach((line) => {
    doc.setFillColor(...ACCENT);
    doc.circle(M + 3, cy - 3, 1.6, 'F');
    doc.setTextColor(...INK);
    const wrapped = doc.splitTextToSize(line, W - M * 2 - 14);
    doc.text(wrapped, M + 12, cy);
    cy += wrapped.length * 13 + 6;
  });
  return cy;
}

function footer(doc: jsPDF, M: number, W: number, H: number) {
  const total = doc.getNumberOfPages();
  const stamp = nowLabel();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.6);
    doc.line(M, H - 30, W - M, H - 30);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text('ShelfGuide — Rapport confidentiel', M, H - 18);
    doc.text(`Genere le ${stamp}`, W / 2, H - 18, { align: 'center' });
    doc.text(`Page ${i} / ${total}`, W - M, H - 18, { align: 'right' });
  }
}

function recommendations(data: ManagerReport): string[] {
  const out: string[] = [];
  const { counts, summary, priorityShelf, thresholds } = data;
  if (counts.critical > 0 && priorityShelf) {
    out.push(`Traiter en priorite les ${counts.critical} rayon(s) critique(s), a commencer par "${priorityShelf.shelf}" (${pct(priorityShelf.profitability)} de profitabilite, ${pct(priorityShelf.emptyRatio)} de vide).`);
  } else {
    out.push('Aucun rayon critique : la surface est globalement maitrisee, maintenir la cadence de controle.');
  }
  if (summary.avgEmptyRatio >= thresholds.empty * 0.7) {
    out.push(`Vide moyen eleve (${pct(summary.avgEmptyRatio)}, seuil ${thresholds.empty}%) : renforcer le reapprovisionnement et le facing sur les rayons signales.`);
  }
  if (summary.avgBackRatio >= thresholds.back * 0.7) {
    out.push(`Produits mal orientes (${pct(summary.avgBackRatio)} en back-side) : remettre les references en front lors du prochain passage.`);
  }
  if (counts.medium > 0) {
    out.push(`${counts.medium} rayon(s) a surveiller (statut moyen) : planifier un controle de suivi sous 48h.`);
  }
  out.push(`Couverture analysee : ${counts.shelves} rayons sur la periode "${data.periode}" (${summary.audits} audits).`);
  return out;
}

export function generateManagerReport(data: ManagerReport): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;

  header(doc, M, W, 'Etat operationnel des rayons', `Perimetre : ${data.perimetre}   •   Periode : ${data.periode}   •   Edite le ${nowLabel()}`);

  let y = 122;
  sectionTitle(doc, M, y, 'Synthese');
  y += 14;
  y = kpiRow(doc, M, y, W, [
    { label: 'Conformite', value: pct(data.summary.avgProfitability), tone: data.summary.avgProfitability >= 85 ? OK : data.summary.avgProfitability >= 65 ? WARN : BAD },
    { label: 'Rayons critiques', value: String(data.counts.critical), tone: data.counts.critical > 0 ? BAD : OK },
    { label: 'Vide moyen', value: pct(data.summary.avgEmptyRatio), tone: WARN },
    { label: 'Back-side', value: pct(data.summary.avgBackRatio) },
  ]);

  y += 22;
  y = sparkline(doc, M, y, W, data.timeline);

  y += 30;
  sectionTitle(doc, M, y, 'Rayons prioritaires');
  y += 8;
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [['Rayon', 'Categorie', 'Statut', 'Vide', 'Back', 'Profit.', 'Priorite']],
    body: data.shelves.map((s) => [s.shelf, s.category, s.status, pct(s.emptyRatio), pct(s.backRatio), pct(s.profitability), s.priority]),
    theme: 'plain',
    headStyles: { fillColor: ACCENT, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
    styles: { fontSize: 8.5, cellPadding: 5, textColor: INK, lineColor: RULE, lineWidth: 0.4 },
    alternateRowStyles: { fillColor: ZEBRA },
    columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    didParseCell: (h) => {
      if (h.section === 'body' && h.column.index === 2) {
        const v = String(h.cell.raw);
        h.cell.styles.textColor = v === 'Critique' ? BAD : v === 'Moyen' ? WARN : OK;
        h.cell.styles.fontStyle = 'bold';
      }
      if (h.section === 'body' && h.column.index === 6) {
        const v = String(h.cell.raw);
        h.cell.styles.textColor = v === 'Haute' ? BAD : v === 'Moyenne' ? WARN : OK;
        h.cell.styles.fontStyle = 'bold';
      }
    },
  });

  // @ts-expect-error lastAutoTable is augmented by jspdf-autotable at runtime
  y = (doc.lastAutoTable?.finalY ?? y) + 30;

  if (y > H - 220) { doc.addPage(); y = 60; }

  sectionTitle(doc, M, y, 'Recommandations');
  y += 18;
  y = bullets(doc, M, y, W, recommendations(data));

  if (data.recurring.length > 0) {
    y += 14;
    if (y > H - 160) { doc.addPage(); y = 60; }
    sectionTitle(doc, M, y, 'Rayons recurrents en probleme');
    y += 8;
    autoTable(doc, {
      startY: y,
      margin: { left: M, right: M },
      head: [['#', 'Rayon', 'Categorie', 'Occurrences']],
      body: data.recurring.map((r, i) => [String(i + 1), r.shelf, r.category, `${r.count} fois`]),
      theme: 'plain',
      headStyles: { fillColor: INK, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
      styles: { fontSize: 8.5, cellPadding: 5, textColor: INK, lineColor: RULE, lineWidth: 0.4 },
      alternateRowStyles: { fillColor: ZEBRA },
      columnStyles: { 0: { cellWidth: 28 }, 3: { halign: 'right' } },
    });
  }

  footer(doc, M, W, H);
  doc.save(`rapport-rayons-${new Date().toISOString().slice(0, 10)}.pdf`);
}
