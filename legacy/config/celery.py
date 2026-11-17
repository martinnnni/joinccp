"""Celery 应用配置。启动：celery -A config worker -l info"""
import os

from celery import Celery
from celery.schedules import crontab

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("config")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()

# 定时任务：每天 9:00 扫描临近截止节点生成站内通知
app.conf.beat_schedule = {
    "scan-deadline-reminders-daily": {
        "task": "apps.flow.tasks.scan_deadline_reminders",
        "schedule": crontab(hour=9, minute=0),
    },
}
