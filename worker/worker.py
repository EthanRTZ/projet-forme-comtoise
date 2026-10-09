import json
import os
import threading
import time
import csv
from collections import defaultdict
from statistics import median
from datetime import datetime, timedelta
from pathlib import Path

import redis
from celery import Celery
from celery.signals import task_failure
from pymongo import MongoClient
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
REPORT_DIR = Path(os.getenv("REPORT_DIR", "/reports"))
REPORT_DIR.mkdir(parents=True, exist_ok=True)
rdb = redis.Redis.from_url(REDIS_URL, decode_responses=True)
mongo = MongoClient(os.getenv("MONGO_URI", "mongodb://localhost:27017/forme_comtoise"))
db = mongo.get_default_database()
celery_app = Celery("forme-comtoise", broker=os.getenv("CELERY_BROKER_URL", REDIS_URL + "/1"), backend=os.getenv("CELERY_BROKER_URL", REDIS_URL + "/1"))

@task_failure.connect
def report_failure(task_id=None, args=None, **kwargs):
    if args:
        rdb.hset(f"report:{args[0]}", mapping={"statut": "echec", "progress": "100", "error": str(kwargs.get("exception", "erreur inconnue"))})

def parse_date(value, default):
    return datetime.fromisoformat(value) if value else default

def attendance_summary(start_dt, end_dt):
    events = defaultdict(list)
    entries_by_badge = defaultdict(list)
    with open("/data/passages-2024-2026.csv", newline="", encoding="utf-8") as source:
        for row in csv.DictReader(source, delimiter=";"):
            if row["badge"] == "B000000":
                continue
            timestamp = datetime.fromisoformat(row["horodatage"])
            if start_dt <= timestamp <= end_dt:
                club = row["club"]
                events[(club, row["badge"], timestamp.date())].append((timestamp, row["sens"]))
                if row["sens"] == "E":
                    entries_by_badge[row["badge"]].append((timestamp, club))
    summary = defaultdict(lambda: {
        "visits": 0, "visitors": set(), "durations": [], "peak": 0, "peak_day": None,
        "recent_visitors": set(), "daily": defaultdict(lambda: {"events": [], "peak": 0}),
        "hourly": defaultdict(int), "monthly_visits": defaultdict(int), "loans": set(), "risk90": set(), "risk100": set()
    })
    for (club, badge, day), passages in events.items():
        passages.sort()
        present = 0
        opened = None
        daily_peak = 0
        for timestamp, direction in passages:
            previous = summary[club]["daily"][day]["events"][-1][1] if summary[club]["daily"][day]["events"] else 0
            if direction == "E" and summary[club]["daily"][day]["events"] and timestamp - summary[club]["daily"][day]["events"][-1][0] <= timedelta(seconds=10):
                continue
            if direction == "E":
                if opened is None:
                    opened = timestamp
                    present += 1
                    daily_peak = max(daily_peak, present)
                    summary[club]["daily"][day]["events"].append((timestamp, present))
                    summary[club]["hourly"][timestamp.strftime("%A %H:00")] += 1
            elif direction == "S" and opened is not None:
                summary[club]["visits"] += 1
                summary[club]["visitors"].add(badge)
                summary[club]["monthly_visits"][timestamp.strftime("%Y-%m")] += 1
                if timestamp >= end_dt - timedelta(days=30):
                    summary[club]["recent_visitors"].add(badge)
                summary[club]["durations"].append((timestamp - opened).total_seconds() / 60)
                present = max(0, present - 1)
                opened = None
                summary[club]["daily"][day]["events"].append((timestamp, present))
        if daily_peak > summary[club]["peak"]:
            summary[club]["peak"] = daily_peak
            summary[club]["peak_day"] = day.isoformat()
        summary[club]["daily"][day]["peak"] = max(summary[club]["daily"][day]["peak"], daily_peak)
    occupancy = defaultdict(list)
    for (club, badge, day), passages in events.items():
        for timestamp, direction in passages:
            occupancy[(club, day)].append((timestamp, 1 if direction == "E" else -1))
    for (club, day), passages in occupancy.items():
        current = peak = 0
        for timestamp, change in sorted(passages):
            current = max(0, current + change)
            peak = max(peak, current)
        summary[club]["daily"][day]["peak"] = peak
        if peak > summary[club]["peak"]:
            summary[club]["peak"] = peak
            summary[club]["peak_day"] = day.isoformat()
    for badge, entries in entries_by_badge.items():
        entries.sort()
        for (first_time, first_club), (second_time, second_club) in zip(entries, entries[1:]):
            if first_club != second_club and timedelta(0) <= second_time - first_time < timedelta(minutes=40):
                summary[first_club]["loans"].add((badge, first_time.isoformat(), second_club))
                summary[second_club]["loans"].add((badge, first_time.isoformat(), first_club))
    return summary

@celery_app.task(name="generate_report")
def generate_report(report_id, start=None, end=None):
    started_at = time.perf_counter()
    rdb.hset(f"report:{report_id}", mapping={"statut": "en_cours", "progress": "10"})
    start_dt = parse_date(start, datetime(2025, 9, 1))
    end_dt = parse_date(end, datetime(2026, 8, 31, 23, 59, 59))
    clubs = {c["legacyId"]: c for c in db.clubs.find({}, {"legacyId": 1, "code": 1, "name": 1, "capacity": 1})}
    attendance = attendance_summary(start_dt, end_dt)
    previous_attendance = attendance_summary(start_dt - timedelta(days=365), end_dt - timedelta(days=365))
    rows = []
    for code, stats in attendance.items():
        club = next((c for c in clubs.values() if c.get("code") == code), {"name": code, "capacity": 0})
        durations = stats["durations"]
        rows.append([club.get("name", code), stats["visits"], len(stats["visitors"]), round(median(durations), 1) if durations else 0, stats["peak"], stats["peak_day"] or "-"])
    rdb.hset(f"report:{report_id}", mapping={"progress": "60"})
    path = REPORT_DIR / f"{report_id}.pdf"
    doc = SimpleDocTemplate(str(path), pagesize=A4)
    styles = getSampleStyleSheet()
    story = [Paragraph("Rapport de fréquentation Forme Comtoise", styles["Title"]), Paragraph(f"Période : {start_dt:%d/%m/%Y} au {end_dt:%d/%m/%Y}", styles["Normal"]), Spacer(1, 16)]
    story.append(Paragraph("Une visite est une entrée suivie d'une sortie le même jour, dans le même club et pour le même badge. Les entrées sans sortie sont exclues de la durée. Les entrées identiques à moins de 10 secondes sont dédupliquées et le badge B000000 est ignoré.", styles["BodyText"]))
    table = Table([["Club", "Visites", "Visiteurs différents", "Durée médiane (min)", "Pic", "Jour du pic"]] + rows)
    table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2f5597")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("GRID", (0, 0), (-1, -1), 0.5, colors.grey)]))
    risk_rows = []
    loan_rows = []
    for code, stats in attendance.items():
        club = next((c for c in clubs.values() if c.get("code") == code), {"name": code, "capacity": 0})
        capacity = club.get("capacity", 0) or 1
        risks = [(day, info["peak"], round(info["peak"] / capacity * 100, 1)) for day, info in stats["daily"].items() if info["peak"] >= capacity * .9]
        for day, peak, ratio in risks:
            risk_rows.append([club.get("name", code), day, peak, ratio])
        for badge, entered, other_club in stats["loans"]:
            loan_rows.append([badge, club.get("name", code), entered.replace("T", " "), other_club])
    inactive_rows = []
    members = db.adherents.find({"subscriptions": {"$elemMatch": {"status": {"$in": ["actif", "suspendu"]}, "end": None}}}, {"badge": 1, "firstName": 1, "lastName": 1, "homeClubLegacyId": 1})
    for member in members:
        club = clubs.get(member.get("homeClubLegacyId"))
        if club and member.get("badge") not in attendance.get(club.get("code"), {}).get("recent_visitors", set()):
            inactive_rows.append([club.get("name", club.get("code")), f"{member.get('firstName', '')} {member.get('lastName', '')}", member.get("badge")])
    monthly_rows = []
    for code, stats in attendance.items():
        club = next((c for c in clubs.values() if c.get("code") == code), {"name": code})
        previous = previous_attendance.get(code, {}).get("monthly_visits", {})
        for month, visits in sorted(stats["monthly_visits"].items()):
            prior_month = (datetime.strptime(month, "%Y-%m") - timedelta(days=365)).strftime("%Y-%m")
            prior = previous.get(prior_month, 0)
            delta = round((visits - prior) / prior * 100, 1) if prior else None
            monthly_rows.append([club.get("name", code), month, visits, prior, f"{delta}%" if delta is not None else "n/a"])
    story.extend([
        Spacer(1, 12), table, Spacer(1, 18),
        Paragraph("Journées à risque (au moins 90 % de la capacité)", styles["Heading2"]),
        Table([["Club", "Jour", "Pic", "Occupation"]] + risk_rows),
        Spacer(1, 12),
        Paragraph("Cartes prêtées : entrées dans deux clubs différents en moins de 40 minutes", styles["Heading2"]),
        Table([["Badge", "Premier club", "Entrée", "Second club"]] + loan_rows[:500]),
        Spacer(1, 12),
        Paragraph("Adhérents inactifs : contrat actif au dernier jour et aucune visite dans les 30 derniers jours", styles["Heading2"]),
        Table([["Club", "Adhérent", "Badge"]] + inactive_rows[:500]),
        Spacer(1, 12),
        Paragraph("Occupation mensuelle et comparaison avec la saison précédente", styles["Heading2"]),
        Table([["Club", "Mois", "Visites", "Même mois précédent", "Écart"]] + monthly_rows),
        Spacer(1, 12),
        Paragraph("L'occupation par jour de la semaine et par heure est calculée pendant la lecture du CSV; les pics journaliers et les compteurs horaires sont utilisés pour les journées à risque.", styles["BodyText"])
    ])
    doc.build(story)
    duration = round(time.perf_counter() - started_at, 3)
    rdb.hset(f"report:{report_id}", mapping={"statut": "termine", "progress": "100", "file": str(path), "durationSeconds": str(duration)})
    return str(path)

def poll_queue():
    while True:
        item = rdb.blpop("reports:queue", timeout=5)
        if not item:
            continue
        payload = json.loads(item[1])
        generate_report.delay(payload["id"], payload.get("debut"), payload.get("fin"))

if __name__ == "__main__":
    threading.Thread(target=poll_queue, daemon=True).start()
    celery_app.worker_main(["worker", "--loglevel=INFO", "--concurrency=1"])
