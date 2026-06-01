# ShelfGuide - Dashboard manager magasin

Dashboard web autonome pour Vercel.

## Variables Vercel

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_STORE_NAME` optionnel, pour limiter au magasin du manager

Les variables Next.js sont aussi acceptees par la config Vite:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

## Supabase Realtime

Pour que le dashboard se mette a jour instantanement quand une analyse mobile est inseree, active la table dans Realtime:

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.shelfguide_analyses;
```

## Deploy Vercel

Dans Vercel, choisis ce dossier comme Root Directory: `dashboard-manager-magasin`.

Build command: `npm run build`

Output directory: `dist`
