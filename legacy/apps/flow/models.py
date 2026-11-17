"""材料与节点管家模型：阶段、流程节点、材料模板、材料记录、站内通知。"""
from django.db import models


class Stage(models.Model):
    """发展党员五大阶段。"""

    order = models.PositiveIntegerField("顺序", default=0)
    slug = models.SlugField("标识", max_length=50, unique=True)
    name = models.CharField("阶段名称", max_length=100)

    class Meta:
        verbose_name = "阶段"
        verbose_name_plural = "阶段"
        ordering = ["order"]

    def __str__(self):
        return self.name


class FlowNode(models.Model):
    """流程节点（步骤）。"""

    stage = models.ForeignKey(
        Stage,
        on_delete=models.CASCADE,
        related_name="nodes",
        verbose_name="所属阶段",
    )
    order = models.PositiveIntegerField("顺序", default=0)
    slug = models.SlugField("标识", max_length=80, unique=True)
    name = models.CharField("节点名称", max_length=100)
    description = models.TextField("说明", blank=True)
    duration_rule = models.CharField(
        "时间要求", max_length=100, blank=True, help_text="如：≥1 年 / 1 个月内 / 期满前 1–2 周"
    )
    duration_days = models.PositiveIntegerField(
        "典型天数", default=0, help_text="用于计算截止日期，0 表示无固定截止"
    )
    remind_days_before = models.PositiveIntegerField(
        "提前提醒天数", default=0, help_text="0 表示不提醒，供定时任务扫描"
    )

    class Meta:
        verbose_name = "流程节点"
        verbose_name_plural = "流程节点"
        ordering = ["order"]

    def __str__(self):
        return self.name


class MaterialTemplate(models.Model):
    """材料模板。"""

    CATEGORY_CHOICES = [
        ("A", "A 类：存入档案"),
        ("B", "B 类：流程表"),
        ("C", "C 类：会议记录留存备查"),
    ]
    FILL_METHOD_CHOICES = [
        ("red", "红色：个人填写"),
        ("blue", "蓝色：组织审批"),
        ("black", "黑色：支部填写"),
    ]

    slug = models.SlugField("标识", max_length=100, unique=True)
    name = models.CharField("材料名称", max_length=150)
    stage = models.ForeignKey(
        Stage,
        on_delete=models.CASCADE,
        related_name="materials",
        verbose_name="所属阶段",
    )
    node = models.ForeignKey(
        FlowNode,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="materials",
        verbose_name="所属节点",
    )
    category = models.CharField("归档类别", max_length=1, choices=CATEGORY_CHOICES, default="A")
    fill_method = models.CharField("填写方式", max_length=10, choices=FILL_METHOD_CHOICES, default="red")
    writing_points = models.TextField("撰写要点", blank=True)
    template_file = models.FileField("模板文件", upload_to="templates/%Y/%m/", blank=True)
    required = models.BooleanField("是否必备", default=True)

    class Meta:
        verbose_name = "材料模板"
        verbose_name_plural = "材料模板"
        ordering = ["stage__order", "node__order", "slug"]

    def __str__(self):
        return self.name


class MaterialRecord(models.Model):
    """学生材料记录（已有 / 缺失）。"""

    STATUS_CHOICES = [
        ("未交", "未交"),
        ("已交", "已交"),
        ("已通过", "已通过"),
    ]

    student = models.ForeignKey(
        "accounts.StudentProfile",
        on_delete=models.CASCADE,
        related_name="material_records",
        verbose_name="学生",
    )
    material = models.ForeignKey(
        MaterialTemplate,
        on_delete=models.CASCADE,
        related_name="records",
        verbose_name="材料",
    )
    status = models.CharField("状态", max_length=10, choices=STATUS_CHOICES, default="未交")
    file = models.FileField("材料文件", upload_to="materials/%Y/%m/", blank=True)
    submitted_at = models.DateTimeField("提交时间", null=True, blank=True)

    class Meta:
        verbose_name = "材料记录"
        verbose_name_plural = "材料记录"
        unique_together = [("student", "material")]

    def __str__(self):
        return f"{self.student} - {self.material}"


class Notification(models.Model):
    """站内通知。"""

    KIND_CHOICES = [
        ("deadline", "临近截止"),
        ("material", "材料提醒"),
        ("lesson", "党课提醒"),
    ]

    student = models.ForeignKey(
        "accounts.StudentProfile",
        on_delete=models.CASCADE,
        related_name="notifications",
        verbose_name="学生",
    )
    kind = models.CharField("类型", max_length=20, choices=KIND_CHOICES, default="material")
    title = models.CharField("标题", max_length=200)
    content = models.TextField("内容")
    node = models.ForeignKey(
        FlowNode,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        verbose_name="关联节点",
    )
    is_read = models.BooleanField("已读", default=False)
    email_sent = models.BooleanField("已发邮件", default=False, help_text="预留邮件接口字段")
    created_at = models.DateTimeField("创建时间", auto_now_add=True)

    class Meta:
        verbose_name = "站内通知"
        verbose_name_plural = "站内通知"
        ordering = ["-created_at"]

    def __str__(self):
        return self.title
