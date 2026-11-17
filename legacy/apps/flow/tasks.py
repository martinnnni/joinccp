"""定时提醒任务：扫描临近截止节点，生成站内通知。

Celery 调度：由 Celery beat 定时调用（见 deploy/）。
也可用 Django management command + cron 替代（无需 Celery beat）：
  0 9 * * * cd /srv/party && python manage.py scan_reminders
"""
import logging
from datetime import timedelta

from celery import shared_task
from django.utils import timezone

from apps.accounts.models import StudentProfile

from .models import FlowNode, Notification

logger = logging.getLogger(__name__)


def generate_reminders():
    """核心逻辑：为临近截止节点生成通知，返回生成数量。"""
    today = timezone.localdate()
    created = 0
    nodes = FlowNode.objects.filter(remind_days_before__gt=0, duration_days__gt=0)
    for node in nodes:
        students = StudentProfile.objects.filter(
            current_node_slug=node.slug, node_entered_at__isnull=False
        )
        for student in students:
            deadline = student.node_entered_at + timedelta(days=node.duration_days)
            remind_at = deadline - timedelta(days=node.remind_days_before)
            if today < remind_at:
                continue
            # 去重：同一学生同一节点只提醒一次
            if Notification.objects.filter(
                student=student, node=node, kind="deadline"
            ).exists():
                continue
            Notification.objects.create(
                student=student,
                kind="deadline",
                node=node,
                title=f"节点提醒：{node.name}",
                content=(
                    f"您当前处于「{node.name}」节点，时间要求："
                    f"{node.duration_rule or '请按计划推进'}。请及时准备相关材料，"
                    "详见档案页材料清单。"
                ),
            )
            created += 1
    return created


@shared_task
def scan_deadline_reminders():
    """Celery 定时任务入口。"""
    try:
        count = generate_reminders()
        logger.info("生成临近截止通知 %d 条", count)
        return count
    except Exception:
        logger.exception("扫描临近截止节点失败")
        return 0
