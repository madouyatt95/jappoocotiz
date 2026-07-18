# Jàppoo Cotiz

PWA mobile-first pour consulter et gérer les caisses de cotisation familiales.

## Règles actuellement appliquées

- les membres consultent uniquement leur situation ;
- le micro lit uniquement l’état des cotisations ;
- seuls les responsables habilités accèdent à l’enregistrement ;
- les paiements sont enregistrés uniquement en espèces ;
- tout nouveau compte reste en attente de validation ;
- un membre demande son adhésion avec un nom ou pseudo uniquement, sans e-mail ;
- après validation, l’administrateur lui remet un code personnel à 6 chiffres pour ouvrir sa fiche ;
- l’administrateur a toujours l’écriture sur toutes les caisses ;
- pour chaque autre responsable, l’administrateur attribue la lecture seule ou l’écriture sur une caisse précise ou sur toutes les caisses ;
- l’onglet **Activité** présente les mouvements généraux sans exposer les identités aux comptes en lecture seule ;
- aucune donnée de démonstration n’est préchargée ;
- la Caisse famille et la Caisse décès sont présentes au départ ; l’administrateur peut en ajouter.

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
4. Dans l’onglet **Membre**, utiliser **Première connexion** avec seulement un nom ou pseudo et vérifier que la demande apparaît chez l’administrateur.
5. L’administrateur choisit **Lecture seule**, une caisse précise ou **Toutes les caisses**, puis communique le code à 6 chiffres affiché.
6. Le membre utilise **Connexion avec code** avec le même pseudo et ce code pour ouvrir sa propre fiche.
7. Dans l’onglet **Administrateur**, se connecter par e-mail et mot de passe. Après une connexion initiale par lien, le mot de passe se crée dans **Profil**.
8. Avec un droit de saisie, vérifier que **+ Ajouter un paiement** est immédiatement visible et que seules les caisses autorisées sont proposées.
9. Choisir un membre et une caisse : les mensualités sont prolongées automatiquement jusqu’au mois courant. La section **Période personnalisée** reste disponible pour une correction historique.
10. Vérifier que le mouvement apparaît dans l’activité générale uniquement après la réponse positive de Supabase.

Le navigateur ne valide aucune écriture financière. Il conserve seulement un cache de lecture hors ligne ; Supabase reste la source de vérité. Les règles RLS limitent la consultation au membre concerné et l’enregistrement aux rôles habilités, avec `cash` comme unique moyen de paiement accepté par la base.

Le code membre n’est jamais stocké en clair : seule son empreinte est conservée. Après cinq erreurs, la connexion est bloquée pendant 15 minutes. Une session Supabase anonyme n’est rattachée à la fiche qu’après vérification du pseudo et du code.

## Caisses et arriérés

- **Caisse famille** : 5 € par mois depuis janvier 2021 ;
- **Caisse décès** : 5 € par mois depuis janvier 2021 ;
- chaque caisse dispose de son propre affichage et peut être créée ou configurée par un administrateur ;
- les périodes dues sont créées automatiquement depuis le début applicable jusqu’au mois courant ;
- l’administrateur peut encore définir, membre par membre et caisse par caisse, une plage historique personnalisée ;
- modifier cette plage conserve tous les paiements existants et annule uniquement les échéances impayées sorties de la plage ;
- le bouton de paramétrage apparaît directement dans **Caisses** pour l’administrateur ;
- un versement est réparti automatiquement sur les plus anciennes mensualités impayées ;
- le bouton **À jour** renseigne en un geste le montant total des arriérés de la caisse sélectionnée.

Les membres et leurs dates d'adhésion doivent être rattachés explicitement à l'espace familial. L'administrateur initial doit aussi être choisi explicitement : aucun des comptes Supabase existants ne reçoit automatiquement des droits de gestion.

## Production

La PWA est déployée sur [jappo-cotiz.vercel.app](https://jappo-cotiz.vercel.app/). Le build Vercel génère la configuration publique à partir des variables d’environnement sans versionner `.env.local`.
