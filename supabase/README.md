# Activation Supabase

1. Ouvrir le projet Supabase qui correspond à la référence configurée.
2. Exécuter les fichiers de `migrations/` dans l’ordre de leur nom dans le SQL Editor.
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
