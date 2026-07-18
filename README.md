# Jàppoo Cotiz

PWA mobile-first pour consulter les cotisations de la **Caisse famille** et de la **Caisse décès**.

## Règles actuellement appliquées

- les membres consultent uniquement leur situation ;
- le micro lit uniquement l’état des cotisations ;
- seuls les responsables habilités accèdent à l’enregistrement ;
- les paiements sont enregistrés uniquement en espèces ;
- tout nouveau compte reste en attente de validation ;
- l’administrateur attribue soit la lecture seule, soit la lecture avec saisie des paiements ;
- l’onglet **Activité** présente les mouvements généraux sans exposer les identités aux comptes en lecture seule ;
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

Les migrations Supabase se trouvent dans `supabase/migrations/` et doivent être
appliquées dans l’ordre de leur nom.

## Parcours de vérification

1. Sur **Accueil**, vérifier que le solde et l’historique sont vides.
2. Toucher **Ma situation** : l’assistant lit uniquement les cotisations.
3. Sans connexion, ouvrir **Gestion** : la connexion Supabase est demandée et le formulaire de paiement reste inaccessible.
4. Créer un nouveau compte et vérifier qu’il reste en attente sans accès aux caisses.
5. Avec un compte administrateur, valider ce compte en **Lecture seule** ou **Lecture + saisie**.
6. Avec un droit de saisie, toucher le bouton `+`, choisir la caisse puis enregistrer un paiement en espèces.
7. Vérifier que le mouvement apparaît dans l’activité générale uniquement après la réponse positive de Supabase.

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
