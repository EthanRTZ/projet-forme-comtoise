import express from "express";
import mongoose from "mongoose";
import { createClient } from "redis";
import crypto from "node:crypto";

const app = express();
app.use(express.json());
const port = Number(process.env.PORT || 3000);
const mongo = process.env.MONGO_URI || "mongodb://localhost:27017/forme_comtoise";
const redis = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
redis.on("error", error => console.error("Redis:", error.message));
await redis.connect();
await mongoose.connect(mongo);
const { Schema } = mongoose;
const Club = mongoose.model("Club", new Schema({ legacyId: Number, code: String, name: String, city: String, address: String, capacity: Number, hours: Schema.Types.Mixed, openedAt: Date }, { collection: "clubs" }));
const Formula = mongoose.model("Formula", new Schema({ legacyId: Number, code: String, label: String, monthlyPriceCents: Number, commitmentMonths: Number, groupClasses: Boolean, allClubs: Boolean }, { collection: "formules" }));
const Member = mongoose.model("Member", new Schema({ legacyId: Number, badge: String, firstName: String, lastName: String, email: String, phone: String, birthDate: Date, homeClubLegacyId: Number, registeredAt: Date, subscriptions: [Schema.Types.Mixed] }, { collection: "adherents" }));
const Coach = mongoose.model("Coach", new Schema({ legacyId: Number, firstName: String, lastName: String, email: String, clubLegacyId: Number, specialties: [String], hiredAt: Date, active: Boolean }, { collection: "coachs" }));
const Session = mongoose.model("Session", new Schema({ legacyId: Number, activity: Schema.Types.Mixed, coach: Schema.Types.Mixed, clubLegacyId: Number, room: String, startsAt: Date, places: Number, cancelled: Boolean, reservations: [Schema.Types.Mixed] }, { collection: "seances" }));
const cacheEnabled = () => process.env.CACHE_ENABLED !== "false";
const cached = async (key, ttl, producer) => {
  if (!cacheEnabled()) return producer();
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);
  const value = await producer();
  await redis.setEx(key, ttl, JSON.stringify(value));
  return value;
};
const invalidate = async pattern => {
  for await (const key of redis.scanIterator({ MATCH: pattern })) await redis.del(key);
};
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = value => Number.isFinite(Number(value)) ? Number(value) : null;
const weekEnd = start => new Date(new Date(start).getTime() + 7 * 86400000);
const activeSubscription = (member, at = new Date()) => (member.subscriptions || []).filter(s => new Date(s.start) <= at && (!s.end || new Date(s.end) >= at) && ["actif", "suspendu"].includes(s.status)).sort((a, b) => new Date(b.start) - new Date(a.start))[0];

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/clubs", asyncRoute(async (req, res) => res.json(await cached("clubs", 300, () => Club.find().sort({ legacyId: 1 }).lean()))));
app.get("/formules", asyncRoute(async (req, res) => res.json(await cached("formulas", 300, () => Formula.find().sort({ legacyId: 1 }).lean()))));
app.get("/clubs/:clubId/planning", asyncRoute(async (req, res) => {
  const start = new Date(req.query.debut || req.query.start || new Date().toISOString().slice(0, 10));
  const end = weekEnd(start);
  const clubId = id(req.params.clubId);
  const key = `planning:${clubId}:${start.toISOString().slice(0, 10)}`;
  const data = await cached(key, 30, async () => Session.aggregate([
    { $match: { clubLegacyId: clubId, startsAt: { $gte: start, $lt: end }, cancelled: false } },
    { $lookup: { from: "clubs", localField: "clubLegacyId", foreignField: "legacyId", as: "club" } },
    { $project: {
      _id: 0, id: "$legacyId", activity: 1, coach: 1, room: 1, startsAt: 1, places: 1,
      placesRemaining: {
        $max: [
          0,
          { $subtract: [
            "$places",
            { $size: { $filter: { input: "$reservations", as: "r", cond: { $in: ["$$r.status", ["confirmee", "presente"]] } } } }
          ] }
        ]
      }
    } },
    { $sort: { startsAt: 1 } }
  ]));
  res.json({ clubId, start, end, sessions: data });
}));
app.post("/seances/:sessionId/reservations", asyncRoute(async (req, res) => {
  const sessionId = id(req.params.sessionId), memberId = id(req.body.adherentId);
  if (!sessionId || !memberId) return res.status(400).json({ error: "adherentId requis" });
  const [member, session] = await Promise.all([Member.findOne({ legacyId: memberId }).lean(), Session.findOne({ legacyId: sessionId }).lean()]);
  if (!member || !session) return res.status(404).json({ error: "Adhérent ou séance introuvable" });
  if (session.cancelled) return res.status(409).json({ error: "Séance annulée" });
  const subscription = activeSubscription(member);
  if (!subscription) return res.status(403).json({ error: "Aucune formule active" });
  const formula = await Formula.findOne({ legacyId: subscription.formulaLegacyId }).lean();
  const clubAllowed = formula?.allClubs || member.homeClubLegacyId === session.clubLegacyId;
  if (!formula?.groupClasses || !clubAllowed) return res.status(403).json({ error: "Formule incompatible avec ce cours ou ce club" });
  const booking = { legacyId: Number.parseInt(crypto.randomBytes(6).toString("hex"), 16), memberLegacyId: memberId, bookedAt: new Date(), status: "confirmee" };
  const result = await Session.updateOne(
    { legacyId: sessionId, cancelled: false, $expr: { $lt: [{ $size: "$reservations" }, "$places"] }, reservations: { $not: { $elemMatch: { memberLegacyId: memberId, status: { $in: ["confirmee", "presente"] } } } } },
    { $push: { reservations: booking } }
  );
  if (!result.modifiedCount) return res.status(409).json({ error: "Plus de place ou réservation déjà existante" });
  await invalidate(`planning:${session.clubLegacyId}:*`);
  await invalidate("stats:remplissage:*");
  await invalidate("stats:coachs");
  res.status(201).json(booking);
}));
app.delete("/seances/:sessionId/reservations/:memberId", asyncRoute(async (req, res) => {
  const result = await Session.updateOne({ legacyId: id(req.params.sessionId), "reservations.memberLegacyId": id(req.params.memberId), "reservations.status": "confirmee" }, { $set: { "reservations.$.status": "annulee" } });
  if (!result.modifiedCount) return res.status(404).json({ error: "Réservation introuvable" });
  await invalidate("planning:*");
  await invalidate("stats:remplissage:*");
  await invalidate("stats:coachs");
  res.status(204).end();
}));
app.get("/adherents/:memberId", asyncRoute(async (req, res) => {
  const member = await Member.findOne({ legacyId: id(req.params.memberId) }).lean();
  if (!member) return res.status(404).json({ error: "Adhérent introuvable" });
  const formulas = await Formula.find().lean();
  const byId = new Map(formulas.map(f => [f.legacyId, f]));
  const sessions = await Session.find({ "reservations.memberLegacyId": member.legacyId }).sort({ startsAt: -1 }).limit(10).lean();
  res.json({ ...member, subscriptions: member.subscriptions.map(s => ({ ...s, formula: byId.get(s.formulaLegacyId) || null })), lastSessions: sessions });
}));
app.post("/adherents", asyncRoute(async (req, res) => {
  const formula = await Formula.findOne({ legacyId: id(req.body.formuleId) }).lean();
  const club = await Club.findOne({ legacyId: id(req.body.clubId) }).lean();
  if (!formula || !club) return res.status(400).json({ error: "Formule ou club invalide" });
  const member = await Member.create({ legacyId: Date.now(), badge: req.body.badge, firstName: req.body.prenom, lastName: req.body.nom, email: req.body.email, phone: req.body.telephone, homeClubLegacyId: club.legacyId, registeredAt: new Date(), subscriptions: [{ formulaLegacyId: formula.legacyId, start: new Date(), end: null, priceCents: formula.monthlyPriceCents, status: "actif" }] });
  res.status(201).json(member);
}));
app.patch("/formules/:formulaId/prix", asyncRoute(async (req, res) => {
  const formula = await Formula.findOneAndUpdate({ legacyId: id(req.params.formulaId) }, { $set: { monthlyPriceCents: Number(req.body.prixMensuelCentimes) } }, { new: true });
  if (!formula) return res.status(404).json({ error: "Formule introuvable" });
  await invalidate("formulas");
  res.json(formula);
}));
app.patch("/coachs/:coachId", asyncRoute(async (req, res) => {
  const changes = {};
  for (const key of ["firstName", "lastName", "email", "active"]) if (req.body[key] !== undefined) changes[key] = req.body[key];
  if (req.body.specialties) changes.specialties = req.body.specialties.map(s => s.trim().toLowerCase()).filter(Boolean);
  const coach = await Coach.findOneAndUpdate({ legacyId: id(req.params.coachId) }, changes, { new: true });
  if (!coach) return res.status(404).json({ error: "Coach introuvable" });
  await invalidate("stats:coachs");
  res.json(coach);
}));
app.patch("/seances/:sessionId/annulation", asyncRoute(async (req, res) => {
  const session = await Session.findOneAndUpdate({ legacyId: id(req.params.sessionId) }, { $set: { cancelled: true } }, { new: true });
  if (!session) return res.status(404).json({ error: "Séance introuvable" });
  await invalidate("planning:*");
  await invalidate("stats:*");
  res.json(session);
}));

app.get("/statistiques/remplissage", asyncRoute(async (req, res) => {
  const match = { cancelled: false, startsAt: { $gte: new Date(req.query.debut), $lte: new Date(req.query.fin) } };
  const key = `stats:remplissage:${req.query.debut}:${req.query.fin}`;
  const result = await cached(key, 180, () => Session.aggregate([
    { $match: match },
    { $project: {
      activityName: "$activity.name",
      places: 1,
      booked: { $size: { $filter: { input: "$reservations", as: "r", cond: { $in: ["$$r.status", ["confirmee", "presente", "absente"]] } } } },
      absent: { $size: { $filter: { input: "$reservations", as: "r", cond: { $eq: ["$$r.status", "absente"] } } } }
    } },
    { $group: { _id: "$activityName", places: { $sum: "$places" }, booked: { $sum: "$booked" }, absent: { $sum: "$absent" } } },
    { $project: {
      _id: 0,
      activite: "$_id",
      tauxRemplissage: { $cond: [{ $eq: ["$places", 0] }, 0, { $multiply: [{ $divide: ["$booked", "$places"] }, 100] }] },
      tauxAbsence: { $cond: [{ $eq: ["$booked", 0] }, 0, { $multiply: [{ $divide: ["$absent", "$booked"] }, 100] }] }
    } }
  ]));
  res.json(result);
}));
app.get("/statistiques/coachs", asyncRoute(async (req, res) => {
  const result = await cached("stats:coachs", 180, () => Session.aggregate([
    { $match: { cancelled: false } },
    { $lookup: { from: "coachs", localField: "coach.legacyId", foreignField: "legacyId", as: "coachRecord" } },
    { $group: {
      _id: "$coach.legacyId",
      coach: { $first: "$coach" },
      coachRecord: { $first: "$coachRecord" },
      cours: { $sum: 1 },
      reservations: { $sum: { $size: "$reservations" } }
    } },
    { $sort: { reservations: -1 } },
    { $project: { _id: 0, coach: 1, coachRecord: 1, cours: 1, reservations: 1 } }
  ]));
  res.json(result);
}));
app.get("/statistiques/chiffre-affaires", asyncRoute(async (req, res) => {
  const clubId = id(req.query.clubId), month = new Date(`${req.query.mois || new Date().toISOString().slice(0, 7)}-01`);
  const key = `stats:ca:${clubId}:${month.toISOString().slice(0, 7)}`;
  const total = await cached(key, 300, async () => {
    const members = await Member.find({ homeClubLegacyId: clubId }).lean();
    return members.flatMap(m => m.subscriptions || []).filter(s => new Date(s.start) <= month && (!s.end || new Date(s.end) >= month) && ["actif", "suspendu"].includes(s.status)).reduce((sum, s) => sum + s.priceCents, 0);
  });
  res.json({ clubId, month, amountCents: total });
}));
app.post("/rapports", asyncRoute(async (req, res) => {
  const reportId = crypto.randomUUID();
  await redis.hSet(`report:${reportId}`, { statut: "en_attente", progress: "0", createdAt: new Date().toISOString() });
  await redis.rPush("reports:queue", JSON.stringify({ id: reportId, debut: req.body.debut, fin: req.body.fin }));
  res.status(202).json({ id: reportId, statut: "en_attente" });
}));
app.get("/rapports/:reportId", asyncRoute(async (req, res) => {
  const report = await redis.hGetAll(`report:${req.params.reportId}`);
  if (!report.statut) return res.status(404).json({ error: "Rapport introuvable" });
  res.json({ id: req.params.reportId, ...report });
}));
app.get("/rapports/:reportId/pdf", asyncRoute(async (req, res) => {
  const report = await redis.hGetAll(`report:${req.params.reportId}`);
  if (report.statut !== "termine") return res.status(409).json({ error: "Rapport non terminé", statut: report.statut });
  res.download(`${process.env.REPORT_DIR || "/reports"}/${req.params.reportId}.pdf`);
}));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Erreur interne" }); });
app.listen(port, () => console.log(`API Forme Comtoise sur :${port}`));
