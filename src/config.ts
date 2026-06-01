import type { GroupKey } from './dashboard';

export const dashboardConfig = {
  title: 'Dashboard manager magasin',
  subtitle: 'Vue magasin, priorites operationnelles et performance par rayon.',
  eyebrow: 'ShelfGuide magasin',
  scopeLabel: 'Perimetre manager magasin',
  storeName: import.meta.env.VITE_STORE_NAME?.trim() || '',
  category: '',
  primaryGroup: 'shelf_name' as GroupKey,
  primaryTitle: 'Classement des rayons',
  secondaryGroup: 'category' as GroupKey,
  secondaryTitle: 'Performance par categorie',
  riskTitle: 'Escalades magasin',
  recentTitle: 'Activite recente',
  limit: 500,
  refreshMs: 15000,
  // Hypotheses ajustables pour la valorisation business (demo Franprix Maroc)
  costPerFacing: 65, // MAD de CA potentiel/jour par facing vide
  minPerManualAudit: 12, // minutes economisees par audit automatise vs manuel
  demoLocation: 'Reseau Franprix · Maroc',
};
