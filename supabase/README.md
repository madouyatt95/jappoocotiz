# Activation Supabase

1. Ouvrir le projet Supabase qui correspond à la référence configurée.
2. Exécuter `migrations/202607180001_initial_schema.sql` dans le SQL Editor.
3. Dans **Authentication > URL Configuration**, définir le Site URL sur
   `https://jappo-cotiz.vercel.app` et autoriser
   `https://jappo-cotiz.vercel.app/**` comme Redirect URL.
4. Se connecter une première fois dans l’application avec l’adresse du futur
   administrateur. Cette étape crée l’utilisateur dans `auth.users`.
5. Remplacer l’adresse ci-dessous puis exécuter cette requête dans le SQL Editor :

```sql
insert into public.family_members(family_id, user_id, full_name, role)
select
  fs.id,
  u.id,
  coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)),
  'admin'
from public.family_spaces fs
join auth.users u on lower(u.email) = lower('administrateur@exemple.com')
where fs.slug = 'ma-famille'
on conflict (family_id, user_id) where user_id is not null
do update set role = 'admin', active = true;
```

Les autres comptes peuvent ensuite être rattachés avec un rôle parmi
`admin`, `treasurer`, `cash_collector` ou `member`. Un compte `member` peut
consulter ses lignes, mais la base lui refuse tout enregistrement de paiement.

