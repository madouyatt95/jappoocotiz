# Jàppoo Cotiz

PWA mobile-first pour consulter les cotisations de la **Caisse famille** et de la **Caisse décès**.

## Règles actuellement appliquées

- les membres consultent uniquement leur situation ;
- le micro lit uniquement l’état des cotisations ;
- seuls les responsables habilités accèdent à l’enregistrement ;
- les paiements sont enregistrés uniquement en espèces ;
- tout nouveau compte reste en attente de validation ;
- l’administrateur a toujours l’écriture sur les deux caisses ;
- pour chaque autre responsable, l’administrateur attribue la lecture seule ou l’écriture sur **Famille**, **Décès** ou **les deux** ;
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
4. Après une première connexion par lien, ouvrir **Profil → Créer mon mot de passe**. Les connexions suivantes utilisent directement l’e-mail et ce mot de passe ; le lien reste un secours.
5. Créer un nouveau compte et vérifier qu’il reste en attente sans accès aux caisses.
6. Avec un compte administrateur, choisir **Lecture seule**, **Famille**, **Décès** ou **Les deux**.
7. Avec un droit de saisie, vérifier que **+ Ajouter un paiement** est immédiatement visible et que seules les caisses autorisées sont proposées.
8. Dans **Gestion → Définir les mensualités dues**, choisir un membre, une caisse, le premier et le dernier mois, puis vérifier le recalcul des arriérés.
9. Vérifier que le mouvement apparaît dans l’activité générale uniquement après la réponse positive de Supabase.

Le navigateur ne valide aucune écriture financière. Il conserve seulement un cache de lecture hors ligne ; Supabase reste la source de vérité. Les règles RLS limitent la consultation au membre concerné et l’enregistrement aux rôles habilités, avec `cash` comme unique moyen de paiement accepté par la base.

## Caisses et arriérés

- **Caisse famille** : 5 € par mois depuis janvier 2021 ;
- **Caisse décès** : 5 € par mois depuis janvier 2021 ;
- chaque caisse dispose de son propre affichage et peut être configurée par un administrateur ;
- un responsable habilité peut définir, membre par membre et caisse par caisse, une plage de mensualités allant de janvier 2021 au mois courant ;
- modifier cette plage conserve tous les paiements existants et annule uniquement les échéances impayées sorties de la plage ;
- le bouton de paramétrage apparaît directement dans **Caisses** pour l’administrateur ;
- un versement est réparti automatiquement sur les plus anciennes mensualités impayées ;
- les boutons `1 mois`, `3 mois`, `6 mois` et `Tout` accélèrent la saisie en espèces.

Les membres et leurs dates d'adhésion doivent être rattachés explicitement à l'espace familial. L'administrateur initial doit aussi être choisi explicitement : aucun des comptes Supabase existants ne reçoit automatiquement des droits de gestion.

## Production

La PWA est déployée sur [jappo-cotiz.vercel.app](https://jappo-cotiz.vercel.app/). Le build Vercel génère la configuration publique à partir des variables d’environnement sans versionner `.env.local`.
