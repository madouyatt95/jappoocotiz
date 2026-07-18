# Jàppoo Cotiz

PWA mobile-first pour consulter les cotisations de la **Caisse famille** et de la **Caisse décès**.

## Règles actuellement appliquées

- les membres consultent uniquement leur situation ;
- le micro lit uniquement l’état des cotisations ;
- seuls les responsables habilités accèdent à l’enregistrement ;
- les paiements sont enregistrés uniquement en espèces ;
- aucune donnée de démonstration n’est préchargée ;
- seules les deux caisses demandées sont présentes.

## Lancer l’application

```bash
npm start
```

Puis ouvrir `http://127.0.0.1:4173`.

Pour tester la connexion Supabase, créer un fichier `.env.local` non versionné :

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://votre-projet.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=votre-cle-publique
```

Puis générer et servir `dist/` :

```bash
npm run build
```

Le schéma à appliquer dans le SQL Editor Supabase se trouve dans
`supabase/migrations/202607180001_initial_schema.sql`.

## Parcours de vérification

1. Sur **Accueil**, vérifier que le solde et l’historique sont vides.
2. Toucher **Ma situation** : l’assistant lit uniquement les cotisations.
3. Sans connexion, ouvrir **Gestion** : la connexion Supabase est demandée et le formulaire de paiement reste inaccessible.
4. Avec un rôle `admin`, `treasurer` ou `cash_collector`, toucher le bouton `+`, choisir la caisse puis enregistrer un paiement en espèces.
5. Vérifier que la mise à jour, le reçu et l’activité n’apparaissent qu’après la réponse positive de Supabase.

Le navigateur ne valide aucune écriture financière. Il conserve seulement un cache de lecture hors ligne ; Supabase reste la source de vérité. Les règles RLS limitent la consultation au membre concerné et l’enregistrement aux rôles habilités, avec `cash` comme unique moyen de paiement accepté par la base.

## Caisses et arriérés

- **Caisse famille** : 5 € par mois depuis janvier 2021 ;
- **Caisse décès** : 5 € par mois depuis janvier 2021 ;
- chaque caisse dispose de son propre affichage et peut être configurée par un administrateur ;
- un versement est réparti automatiquement sur les plus anciennes mensualités impayées ;
- les boutons `1 mois`, `3 mois`, `6 mois` et `Tout` accélèrent la saisie en espèces.

Les membres et leurs dates d'adhésion doivent être rattachés explicitement à l'espace familial. L'administrateur initial doit aussi être choisi explicitement : aucun des comptes Supabase existants ne reçoit automatiquement des droits de gestion.

## Production

La PWA est déployée sur [jappo-cotiz.vercel.app](https://jappo-cotiz.vercel.app/). Le build Vercel génère la configuration publique à partir des variables d’environnement sans versionner `.env.local`.
