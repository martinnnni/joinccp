"""智能材料质检模型：质检记录与质检结果。"""
from django.db import models


class MaterialCheckRecord(models.Model):
    """材料质检记录。"""

    student = models.ForeignKey(
        "accounts.StudentProfile",
        on_delete=models.CASCADE,
        related_name="check_records",
        verbose_name="学生",
    )
    material = models.ForeignKey(
        "flow.MaterialTemplate",
        on_delete=models.CASCADE,
        related_name="check_records",
        verbose_name="材料",
    )
    docx = models.FileField("上传的 .docx", upload_to="checks/%Y/%m/")
    checked_at = models.DateTimeField("质检时间", auto_now_add=True)

    class Meta:
        verbose_name = "质检记录"
        verbose_name_plural = "质检记录"
        ordering = ["-checked_at"]

    def __str__(self):
        return f"{self.material} 质检 - {self.checked_at:%Y-%m-%d %H:%M}"


class CheckResult(models.Model):
    """质检结果（规则检查或 AI 建议）。"""

    KIND_CHOICES = [
        ("rule", "规则检查"),
        ("ai", "AI 建议"),
    ]

    record = models.ForeignKey(
        MaterialCheckRecord,
        on_delete=models.CASCADE,
        related_name="results",
        verbose_name="质检记录",
    )
    kind = models.CharField("类型", max_length=10, choices=KIND_CHOICES, default="rule")
    code = models.CharField("规则编号", max_length=50, blank=True)
    message = models.TextField("说明")
    severity = models.CharField("严重程度", max_length=10, blank=True, help_text="如：高 / 中 / 低")
    suggestion = models.TextField("建议", blank=True)

    class Meta:
        verbose_name = "质检结果"
        verbose_name_plural = "质检结果"
        ordering = ["kind", "code"]

    def __str__(self):
        return f"[{self.get_kind_display()}] {self.message[:50]}"
