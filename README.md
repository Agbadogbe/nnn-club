# Club No Nut November

Le mur du groupe pour tenir les 30 jours de novembre 2026 : validation quotidienne sous serment, classement, fil du groupe, contestations votées.

Site statique (HTML, CSS, JS) + Supabase pour les comptes, la base de données et le temps réel. Hébergement sur Vercel.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure des pages |
| `styles.css` | Design (thème sombre et clair automatiques) |
| `app.js` | Logique du site |
| `config.js` | Adresse et clé publique de ton projet Supabase |
| `supabase/schema.sql` | Tables, règles de sécurité, annonces automatiques |

## 1. Créer la base Supabase (5 min)

1. Crée un compte sur [supabase.com](https://supabase.com) puis **New project**. Choisis la région **Paris (eu-west-3)** ou Francfort.
2. Ouvre **SQL Editor** > **New query**, colle tout le contenu de `supabase/schema.sql`, clique **Run**. Le message attendu est *Success. No rows returned*.
3. Ouvre **Authentication** > **Sign In / Providers** > **Email** :
   - Laisse **Enable Email provider** activé.
   - Recommandé : désactive **Confirm email**. Sans ça, chaque inscription envoie un e-mail, et le service d'e-mail gratuit de Supabase est limité à quelques envois par heure. Tes potes pourraient rester bloqués.
4. Ouvre **Project Settings** > **API** et copie :
   - **Project URL**
   - la clé **anon public**
5. Colle-les dans `config.js`.

## 2. Mettre le code sur GitHub

Crée un nouveau dépôt (par exemple `nnn-club`) sans toucher à ton portfolio, puis :

```bash
cd nnn-club
git init
git add .
git commit -m "Club No Nut November"
git branch -M main
git remote add origin https://github.com/TON-PSEUDO/nnn-club.git
git push -u origin main
```

## 3. Déployer sur Vercel (2 min)

1. Sur [vercel.com](https://vercel.com), connecte-toi avec GitHub.
2. **Add New** > **Project** > importe `nnn-club`.
3. **Framework Preset** : `Other`. Ne change rien d'autre. Clique **Deploy**.
4. Tu obtiens une adresse du type `nnn-club.vercel.app`. Chaque `git push` met le site à jour.

Retourne ensuite dans Supabase > **Authentication** > **URL Configuration** et mets ton adresse Vercel dans **Site URL**. Ça sert aux liens envoyés par e-mail (confirmation, mot de passe oublié).

## 4. Te nommer organisateur

Inscris-toi sur le site, puis dans Supabase > **SQL Editor** :

```sql
insert into public.app_admins (user_id)
select id from auth.users where email = 'ton-email@exemple.com';
```

Recharge le site. Tu peux maintenant supprimer n'importe quel message, trancher les contestations et retirer (ou réintégrer) un membre.


## Les règles appliquées par le serveur

- Toute personne qui a le lien peut s'inscrire. Sans profil, on ne voit rien du groupe.
- On valide uniquement **pour soi** et uniquement **le jour en cours** (heure de Paris). Un jour oublié ne se rattrape pas.
- Un jour validé peut passer à « craqué » le jour même, jamais l'inverse.
- L'heure de validation et le badge « après 23 h » sont fixés par le serveur.
- Les annonces du fil (validation, aveu, arrivée, contestation) sont créées par le serveur : impossible d'en publier une fausse.
- On ne conteste que le jour validé de quelqu'un d'autre, et on ne vote pas sur son propre jour.
- Seul l'organisateur tranche une contestation (jamais la sienne), supprime les messages des autres ou retire un membre.
- Un membre retiré garde son historique visible, mais ne peut plus valider, écrire, réagir ni voter. L'organisateur peut le réintégrer.
- Les dates des validations, messages et contestations sont fixées par le serveur.

Le jour est annulé si plus de la moitié des autres membres votent « Je doute ». Seuls les membres déjà inscrits à l'ouverture de la contestation votent et comptent : un compte créé ensuite ne change rien. Si l'organisateur retire un faux compte, sa voix ne compte plus. On peut contester et voter pendant novembre et le 1er décembre.

## Changer d'année

Le défi est réglé sur novembre 2026. Pour une autre année, remplace `2026` dans `app.js` (`const YEAR`) et dans `supabase/schema.sql` (fonction `nnn_year`), puis relance le script SQL.
