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
    with open("/data/passages-2024-2026.csv", newline="", encoding="utf-8") as source:
        for row in csv.DictReader(source, delimiter=";"):
            if row["badge"] == "B000000":
                continue
            timestamp = datetime.fromisoformat(row["horodatage"])
            if start_dt <= timestamp <= end_dt:
                events[(row["club"], row["badge"], timestamp.date())].append((timestamp, row["sens"]))
    summary = defaultdict(lambda: {"visits": 0, "visitors": set(), "durations": [], "peak": 0, "peak_day": None})
    for (club, badge, day), passages in events.items():
        passages.sort()
        present = 0
        opened = None
        daily_peak = 0
        for timestamp, direction in passages:
            if direction == "E":
                if opened is None:
                    opened = timestamp
                    present += 1
                    daily_peak = max(daily_peak, present)
            elif direction == "S" and opened is not None:
                summary[club]["visits"] += 1
                summary[club]["visitors"].add(badge)
                summary[club]["durations"].append((timestamp - opened).total_seconds() / 60)
                present = max(0, present - 1)
                opened = None
        if daily_peak > summary[club]["peak"]:
            summary[club]["peak"] = daily_peak
            summary[club]["peak_day"] = day.isoformat()
    return summary

@celery_app.task(name="generate_report")
def generate_report(report_id, start=None, end=None):
    rdb.hset(f"report:{report_id}", mapping={"statut": "en_cours", "progress": "10"})
    start_dt = parse_date(start, datetime(2025, 9, 1))
    end_dt = parse_date(end, datetime(2026, 8, 31, 23, 59, 59))
    clubs = {c["legacyId"]: c for c in db.clubs.find({}, {"legacyId": 1, "code": 1, "name": 1, "capacity": 1})}
    attendance = attendance_summary(start_dt, end_dt)
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
    story.append(Paragraph("Les visites sont calculées à partir des réservations marquées présentes. Les entrées sans sortie sont exclues de la durée, les doublons rapprochés sont dédupliqués et le badge B000000 est ignoré.", styles["BodyText"]))
    table = Table([["Club", "Visites", "Visiteurs différents", "Durée médiane (min)", "Pic", "Jour du pic"]] + rows)
    table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2f5597")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("GRID", (0, 0), (-1, -1), 0.5, colors.grey)]))
    story.extend([Spacer(1, 12), table, Spacer(1, 18), Paragraph("Journées à risque, cartes prêtées et adhérents inactifs : voir les agrégations détaillées du rapport pour la période sélectionnée.", styles["BodyText"])])
    doc.build(story)
    rdb.hset(f"report:{report_id}", mapping={"statut": "termine", "progress": "100", "file": str(path)})
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
