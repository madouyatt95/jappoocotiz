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

## Parcours de vérification

1. Sur **Accueil**, vérifier que le solde et l’historique sont vides.
2. Toucher **Ma situation** : l’assistant lit uniquement les cotisations.
3. Ouvrir **Gestion** : l’écran rappelle que l’accès est réservé.
4. Enregistrer un paiement en espèces dans l’une des deux caisses.
5. Vérifier la mise à jour des caisses, du reçu et de l’activité.

Les données sont actuellement conservées localement dans le navigateur. Avant une utilisation réelle, l’authentification, les habilitations, la base de données et le registre financier devront être reliés à un serveur sécurisé.
