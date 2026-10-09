# Forme Comtoise

## Lancement

Depuis ce dossier, avec Docker installé :

```powershell
docker compose up -d mongo redis
docker compose --profile migration run --rm migration
docker compose up -d api worker
```

L'API est disponible sur `http://localhost:3000`. La collection Postman se trouve dans `postman/forme-comtoise.postman_collection.json` et peut être rejouée avec `npx newman run postman/forme-comtoise.postman_collection.json`.

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

La migration supprime/recrée les cinq collections, reconstruit les index et transforme les dates, booléens, prix en centimes et spécialités. Elle est donc rejouable sans doublons.

Exemple de séance :

```json
{"legacyId": 1, "activity": {"name": "Yoga vinyasa"}, "coach": {"firstName": "Julie", "lastName": "Perrin"}, "clubLegacyId": 1, "startsAt": "2024-09-02T17:30:00.000Z", "places": 16, "cancelled": false, "reservations": []}
```

## Routes

| Méthode | Chemin | Rôle | Réponses |
|---|---|---|---|
| GET | `/health`, `/clubs`, `/formules` | santé, clubs, formules | 200 |
| GET | `/clubs/:id/planning?debut=...` | planning hebdomadaire avec places restantes | 200 |
| POST/DELETE | `/seances/:id/reservations[/\:memberId]` | réserver/annuler | 201, 204, 400, 403, 404, 409 |
| GET | `/adherents/:id` | formule actuelle, historique, dix dernières séances | 200, 404 |
| POST | `/adherents` | inscription avec première formule | 201, 400 |
| PATCH | `/formules/:id/prix`, `/coachs/:id`, `/seances/:id/annulation` | administration | 200, 404 |
| GET | `/statistiques/remplissage`, `/statistiques/coachs`, `/statistiques/chiffre-affaires` | direction | 200 |
| POST/GET | `/rapports`, `/rapports/:id`, `/rapports/:id/pdf` | rapport asynchrone | 202, 200, 404, 409 |

Les réservations utilisent une mise à jour MongoDB atomique : deux demandes concurrentes ne peuvent pas prendre la même place. Une formule doit autoriser les cours collectifs et l'accès interclubs est réservé aux formules Premium (`allClubs`).

## Cache et mesures

Le planning est caché 30 secondes par club et semaine; clubs/formules sont cachés 5 minutes. `CACHE_ENABLED=false` désactive le cache sans modifier le code. Les statistiques peuvent être recalculées par MongoDB et Redis protège les lectures fréquentes.

Lancer une campagne de 20 clients × 20 requêtes :

```powershell
node bench/charge.mjs http://localhost:3000/clubs/1/planning?debut=2025-09-01 bench/resultats/planning-sans-cache.csv
```

Répéter avec `CACHE_ENABLED=true` et une statistique, après `docker compose exec redis redis-cli FLUSHALL`. Le script enregistre les 400 mesures et affiche moyenne, écart-type échantillon, p95, échecs et débit. Les temps incluent la lecture complète du corps.

## Rapport de fréquentation

`POST /rapports` répond immédiatement 202; le worker Python/Celery consomme la file Redis, calcule le rapport et expose `en_attente`, `en_cours`, `termine` ou `echec`. Le PDF contient la synthèse par club, la période et les règles de traitement. Les entrées sans sortie ne forment pas une visite mesurable, les doublons rapprochés sont dédupliqués et `B000000` est exclu.

## Limites connues

Les agrégations détaillées d'occupation heure/jour, cartes prêtées et durées nécessitent un traitement supplémentaire des 1,1 million de passages; le worker fournit la synthèse opérationnelle et son architecture asynchrone. Les heures sont stockées en UTC par MongoDB après interprétation des dates locales de Paris. Les règles d'authentification ne sont pas incluses dans le sujet pédagogique.
