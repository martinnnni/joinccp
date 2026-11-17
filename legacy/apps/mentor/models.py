"""个性化成长导师模型：对话会话与逐条消息。"""
from django.db import models


class ChatSession(models.Model):
    """成长导师对话会话。"""

    student = models.ForeignKey(
        "accounts.StudentProfile",
        on_delete=models.CASCADE,
        related_name="chat_sessions",
        verbose_name="学生",
    )
    title = models.CharField("标题", max_length=200, blank=True, default="新对话")
    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    class Meta:
        verbose_name = "对话会话"
        verbose_name_plural = "对话会话"
        ordering = ["-updated_at"]

    def __str__(self):
        return f"{self.student} - {self.title}"


class ChatMessage(models.Model):
    """对话消息（保留逐条历史，供上下文摘要与后台查看）。"""

    ROLE_CHOICES = [
        ("user", "学生"),
        ("assistant", "导师"),
    ]

    session = models.ForeignKey(
        ChatSession,
        on_delete=models.CASCADE,
        related_name="messages",
        verbose_name="会话",
    )
    role = models.CharField("角色", max_length=10, choices=ROLE_CHOICES)
    content = models.TextField("内容")
    created_at = models.DateTimeField("发送时间", auto_now_add=True)

    class Meta:
        verbose_name = "对话消息"
        verbose_name_plural = "对话消息"
        ordering = ["created_at"]

    def __str__(self):
        return f"{self.get_role_display()}: {self.content[:30]}"
