# Forme Comtoise

## Lancement

Depuis ce dossier, avec Docker installé :

```powershell
docker compose up --build
```

La commande démarre MongoDB, Redis, la migration, l'API et le worker. La migration est exécutée avant l'API et le worker grâce à `service_completed_successfully`. Pour relancer une migration après modification des données, arrêter la pile puis supprimer les volumes MongoDB et Redis avec `docker compose down -v`, avant de relancer la commande. L'API est disponible sur `http://localhost:3000`.

Les fichiers `data/forme-comtoise.sqlite` et `data/passages-2024-2026.csv` doivent être présents localement. Ils sont montés en lecture seule dans les conteneurs et ne sont jamais copiés dans les images.

La collection Postman se trouve dans `postman/forme-comtoise.postman_collection.json` et peut être rejouée avec `npx newman run postman/forme-comtoise.postman_collection.json`.

## Décisions de modélisation et migration

| Table SQLite | Destination | Justification |
|---|---|---|
| `clubs` | collection `clubs` | Les horaires et la capacité évoluent avec les travaux (h). |
| `formules` | collection `formules` | Le prix courant est séparé du prix signé dans un contrat (a). |
| `adherents` | collection `adherents`, contrats imbriqués | La fiche affiche la formule actuelle et tout l'historique (b). |
| `abonnements` | imbriqué dans `adherents` | Chaque contrat conserve son prix, ses dates et son statut (a, b). |
| `coachs` | collection `coachs` | Un coach inactif reste historisé et ses spécialités sont normalisées (e, f, i). |
| `activites` | copie historisée dans `seances` | Le nom d'une activité ne change pas; une nouvelle activité est créée pour un nouveau concept (g). |
| `seances` | collection `seances` | Une séance conserve le coach affiché et sa capacité, même après changement (c, e, f). |
| `reservations` | imbriqué dans `seances` | Les réservations et les 30 places sont contrôlées atomiquement (c, d). |

La migration supprime/recrée les cinq collections, reconstruit les index et transforme les dates, booléens, prix en centimes et spécialités. Elle est donc rejouable sans doublons. Elle vide également Redis après une migration réussie afin d'éviter de conserver des réponses mises en cache pour une ancienne base.

Exemple de séance :

```json
{"legacyId": 1, "activity": {"name": "Yoga vinyasa"}, "coach": {"firstName": "Julie", "lastName": "Perrin"}, "clubLegacyId": 1, "startsAt": "2024-09-02T17:30:00.000Z", "places": 16, "cancelled": false, "reservations": []}
```

## Routes

| Méthode | Chemin | Rôle | Réponses |
|---|---|---|---|
| GET | `/health`, `/clubs`, `/formules` | santé, clubs, formules | 200 |
| GET | `/clubs/:id/planning?debut=...` | planning hebdomadaire avec places restantes | 200 |
| POST | `/seances/:id/reservations` | réserver une place | 201, 400, 403, 404, 409 |
| DELETE | `/seances/:id/reservations/:memberId` | annuler une réservation | 204, 404 |
| GET | `/adherents/:id` | formule actuelle, historique, dix dernières séances | 200, 404 |
| POST | `/adherents` | inscription avec première formule | 201, 400 |
| PATCH | `/formules/:id/prix`, `/coachs/:id`, `/seances/:id/annulation` | administration | 200, 404 |
| GET | `/statistiques/remplissage`, `/statistiques/coachs`, `/statistiques/chiffre-affaires` | direction | 200 |
| POST/GET | `/rapports`, `/rapports/:id`, `/rapports/:id/pdf` | rapport asynchrone | 202, 200, 404, 409 |

Les réservations utilisent une mise à jour MongoDB atomique : deux demandes concurrentes ne peuvent pas prendre la même place. Une formule doit autoriser les cours collectifs et l'accès interclubs est réservé aux formules Premium (`allClubs`).

## Cache et mesures

Le planning est caché 30 secondes par club et semaine; les clubs et formules sont cachés 5 minutes. Les statistiques de remplissage et de coachs sont cachées 180 secondes; le chiffre d'affaires est caché 300 secondes. `CACHE_ENABLED=false` désactive le cache sans modifier le code. Toute réservation, annulation ou modification impactant une statistique invalide les clés concernées.

Lancer une campagne de 20 clients × 20 requêtes avec le cache activé :

```powershell
node bench/charge.mjs "http://localhost:3000/clubs/1/planning?debut=2025-10-20" bench/resultats/planning-avec-cache.csv
node bench/charge.mjs "http://localhost:3000/statistiques/remplissage?debut=2025-09-01&fin=2026-08-31" bench/resultats/statistique-avec-cache.csv
```

Pour la campagne sans cache, arrêter l'API et la relancer avec `CACHE_ENABLED=false`, puis vider Redis avant les mesures. Le script enregistre les 400 mesures et affiche la moyenne, l'écart-type échantillon, le p95, les échecs et le débit. Les temps incluent la lecture complète du corps.

```powershell
docker compose stop api
docker compose run -d --name forme-comtoise-api-bench --service-ports -e CACHE_ENABLED=false api
docker compose exec redis redis-cli FLUSHALL
node bench/charge.mjs "http://localhost:3000/clubs/1/planning?debut=2025-10-20" bench/resultats/planning-sans-cache.csv
node bench/charge.mjs "http://localhost:3000/statistiques/remplissage?debut=2025-09-01&fin=2026-08-31" bench/resultats/statistique-sans-cache.csv
docker rm -f forme-comtoise-api-bench
docker compose up -d api
```

Les quatre fichiers attendus sont :

```text
bench/resultats/planning-sans-cache.csv
bench/resultats/planning-avec-cache.csv
bench/resultats/statistique-sans-cache.csv
bench/resultats/statistique-avec-cache.csv
```

Le tableau à reporter dans ce README après les campagnes est :

| Route | Cache | Moyenne | Écart-type | p95 | Échecs | Débit |
|---|---|---:|---:|---:|---:|---:|
| planning | sans | 23,60 ms | 13,73 ms | 44,63 ms | 0 / 400 | 795,53 req/s |
| planning | avec | 10,81 ms | 6,98 ms | 27,06 ms | 0 / 400 | 1730,25 req/s |
| statistique | sans | 1152,43 ms | 161,12 ms | 1392,50 ms | 0 / 400 | 17,14 req/s |
| statistique | avec | 7,71 ms | 4,26 ms | 18,22 ms | 0 / 400 | 2431,88 req/s |

Les mesures ont été réalisées localement avec 20 clients simultanés et 20 requêtes par client, après l'échauffement prévu. Les quatre campagnes ont produit 400 réponses HTTP 200 et aucune erreur. Le cache réduit la moyenne du planning d'environ 54 % et celle de la statistique d'environ 99 % sur cette machine.

## Rapport de fréquentation

`POST /rapports` répond immédiatement 202; le worker Python/Celery consomme la file Redis, calcule le rapport et expose `en_attente`, `en_cours`, `termine` ou `echec`. Le statut terminé contient aussi `durationSeconds`; une génération mesurée a duré 11,25 secondes sur la machine de test. Le PDF contient la synthèse par club, les durées médianes, les pics et jours de pic, les journées à risque à partir de 90 % de capacité, les cartes prêtées en moins de 40 minutes, les adhérents inactifs et une comparaison mensuelle avec la période précédente. Les entrées sans sortie ne forment pas une visite mesurable, les doublons rapprochés (moins de 10 secondes) sont dédupliqués et `B000000` est exclu.

## Limites connues

Les compteurs d'occupation par jour et heure sont calculés pendant le traitement du CSV; le PDF restitue les pics quotidiens et les comparaisons mensuelles, mais ne fournit pas encore un tableau détaillé séparé pour chaque couple jour de la semaine/heure. Les conversions de dates de la migration dépendent du fuseau du conteneur; pour une exploitation stricte, configurer `TZ=Europe/Paris` dans les services concernés. Les règles d'authentification ne sont pas incluses dans le sujet pédagogique.
