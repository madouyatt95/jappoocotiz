# Activation Supabase

1. Ouvrir le projet Supabase qui correspond à la référence configurée.
2. Exécuter les fichiers de `migrations/` dans l’ordre de leur nom dans le SQL Editor. La migration `202607190007_dynamic_funds_and_due_refresh.sql` ajoute les caisses extensibles. La migration `202607190008_governance_import_and_meeting.sql` ajoute les imports, exceptions, dépenses à double validation, justificatifs privés, audit, mode réunion et cibles de rappels. La migration `202607190009_future_prepayment_periods.sql` est conservée dans l’historique. La migration `202607190010_paid_through_baseline.sql` ajoute la référence « à jour jusqu’à ». La migration corrective `202607190011_paid_through_cash_movement.sql` transforme le complément calculé en paiement réel : il apparaît dans Activité et augmente le solde de la caisse, sans recompter les paiements existants. La migration `202607190012_fix_paid_through_ambiguity.sql` corrige l’ambiguïté SQL signalée lors de cet encaissement.
3. Dans **Authentication > URL Configuration**, définir le Site URL sur
   `https://jappo-cotiz.vercel.app` et autoriser
   `https://jappo-cotiz.vercel.app/**` comme Redirect URL.
4. Se connecter une première fois dans l’application avec l’adresse du futur
   administrateur. Cette étape crée l’utilisateur dans `auth.users`.
5. Remplacer l’adresse ci-dessous puis exécuter cette requête dans le SQL Editor :

```sql
insert into public.family_members(
  family_id, user_id, full_name, role,
  active, approval_status, access_level, reviewed_at, reviewed_by
)
select
  fs.id,
  u.id,
  coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)),
  'admin',
  true,
  'approved',
  'write',
  now(),
  u.id
from public.family_spaces fs
join auth.users u on lower(u.email) = lower('administrateur@exemple.com')
where fs.slug = 'ma-famille'
on conflict (family_id, user_id) where user_id is not null
do update set
  role = 'admin',
  active = true,
  approval_status = 'approved',
  access_level = 'write',
  reviewed_at = now(),
  reviewed_by = excluded.user_id;
```

Les autres comptes sont automatiquement créés avec le statut `pending`. Dans
l’application, l’administrateur choisit ensuite **Lecture seule** ou **Lecture +
saisie**. La base refuse toute consultation des caisses tant que le compte n’est
pas approuvé, et refuse toute écriture financière au niveau lecture seule.

## Rappels push planifiés

1. Déployer l’Edge Function `send-due-reminders`.
2. Créer un secret aléatoire fort et l’ajouter aux secrets de la fonction sous le nom `CRON_SECRET`.
3. Vérifier que `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT` sont également configurés.
4. Copier `cron/setup_due_reminders.sql.template`, remplacer `<CRON_SECRET>` et `<PROJECT_URL>`, puis exécuter la copie dans le SQL Editor.

Le modèle utilise Supabase Vault, `pg_cron` et `pg_net`. Le secret n’est jamais enregistré dans Git. Un seul rappel est programmé le premier jour de chaque mois à 08:00 UTC ; la table `due_reminder_log` empêche tout doublon mensuel.
