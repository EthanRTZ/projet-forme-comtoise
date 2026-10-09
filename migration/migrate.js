import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { MongoClient } from "mongodb";
import { createClient } from "redis";

const source = process.env.SQLITE_PATH || "/data/forme-comtoise.sqlite";
const mongo = new MongoClient(process.env.MONGO_URI || "mongodb://localhost:27017");
const redis = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
const dbName = process.env.MONGO_DB || "forme_comtoise";

const rows = (db, table) => db.all(`SELECT * FROM ${table}`);
const bool = value => Boolean(Number(value));
const date = value => value ? new Date(value.replace(" ", "T") + (value.length === 10 ? "T00:00:00" : "")) : null;
const specialties = value => [...new Set(String(value || "").split(/[;,]/).map(s => s.trim().toLowerCase()).filter(Boolean))];

const db = await open({ filename: source, driver: sqlite3.Database });
await mongo.connect();
await redis.connect();
const target = mongo.db(dbName);
await target.dropDatabase();

const [clubs, plans, members, subscriptions, coaches, activities, sessions, bookings] =
  await Promise.all(["clubs", "formules", "adherents", "abonnements", "coachs", "activites", "seances", "reservations"].map(t => rows(db, t)));

await target.collection("clubs").insertMany(clubs.map(c => ({
  legacyId: c.id, code: c.code, name: c.nom, city: c.ville, address: c.adresse,
  capacity: c.capacite, hours: JSON.parse(c.horaires), openedAt: date(c.ouvert_le)
})));
await target.collection("formules").insertMany(plans.map(f => ({
  legacyId: f.id, code: f.code, label: f.libelle, monthlyPriceCents: f.prix_mensuel_centimes,
  commitmentMonths: f.engagement_mois, groupClasses: bool(f.cours_collectifs), allClubs: bool(f.tous_les_clubs)
})));

const subsByMember = new Map();
for (const s of subscriptions) {
  if (!subsByMember.has(s.adherent_id)) subsByMember.set(s.adherent_id, []);
  subsByMember.get(s.adherent_id).push({
    legacyId: s.id, formulaLegacyId: s.formule_id, start: date(s.debut), end: date(s.fin),
    priceCents: s.prix_mensuel_centimes, status: s.statut
  });
}
await target.collection("adherents").insertMany(members.map(m => ({
  legacyId: m.id, badge: m.badge, firstName: m.prenom, lastName: m.nom, email: m.email,
  phone: m.telephone, birthDate: date(m.date_naissance), homeClubLegacyId: m.club_id,
  registeredAt: date(m.inscrit_le), subscriptions: subsByMember.get(m.id) || []
})));

await target.collection("coachs").insertMany(coaches.map(c => ({
  legacyId: c.id, firstName: c.prenom, lastName: c.nom, email: c.email, clubLegacyId: c.club_id,
  specialties: specialties(c.specialites), hiredAt: date(c.embauche_le), active: bool(c.actif)
})));

const bookingsBySession = new Map();
for (const b of bookings) {
  if (!bookingsBySession.has(b.seance_id)) bookingsBySession.set(b.seance_id, []);
  bookingsBySession.get(b.seance_id).push({
    legacyId: b.id, memberLegacyId: b.adherent_id, bookedAt: date(b.reservee_le), status: b.statut
  });
}
const activityById = new Map(activities.map(a => [a.id, a]));
const coachById = new Map(coaches.map(c => [c.id, c]));
await target.collection("seances").insertMany(sessions.map(s => {
  const a = activityById.get(s.activite_id);
  const coach = coachById.get(s.coach_id);
  return {
    legacyId: s.id, activity: { legacyId: a.id, name: a.nom, category: a.categorie, intensity: a.intensite, durationMinutes: a.duree_min },
    coach: { legacyId: coach.id, firstName: coach.prenom, lastName: coach.nom },
    clubLegacyId: s.club_id, room: s.salle, startsAt: date(s.debut), places: s.places, cancelled: bool(s.annulee),
    reservations: bookingsBySession.get(s.id) || []
  };
}));

await Promise.all([
  target.collection("clubs").createIndex({ code: 1 }, { unique: true }),
  target.collection("formules").createIndex({ code: 1 }, { unique: true }),
  target.collection("adherents").createIndex({ badge: 1 }, { unique: true }),
  target.collection("adherents").createIndex({ email: 1 }, { unique: true }),
  target.collection("seances").createIndex({ clubLegacyId: 1, startsAt: 1 }),
  target.collection("seances").createIndex({ "reservations.memberLegacyId": 1 })
]);
console.log(`Migration terminée: ${clubs.length} clubs, ${members.length} adhérents, ${sessions.length} séances.`);
await db.close();
await redis.flushAll();
await redis.quit();
await mongo.close();
