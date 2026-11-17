"""命令行版临近截止提醒（可配合 cron 替代 Celery beat）。

用法：python manage.py scan_reminders
cron 示例：0 9 * * * cd /srv/party && python manage.py scan_reminders
"""
from django.core.management.base import BaseCommand

from apps.flow.tasks import generate_reminders


class Command(BaseCommand):
    help = "扫描临近截止节点并生成站内通知（等价于 Celery 任务 scan_deadline_reminders）"

    def handle(self, *args, **options):
        count = generate_reminders()
        self.stdout.write(self.style.SUCCESS(f"已生成 {count} 条临近截止通知"))
