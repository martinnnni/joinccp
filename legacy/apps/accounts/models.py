"""账号与院系模型。"""
from django.contrib.auth.models import User
from django.db import models


class Department(models.Model):
    """院系（供辅导员按院系过滤权限）。"""

    name = models.CharField("院系名称", max_length=100, unique=True)

    class Meta:
        verbose_name = "院系"
        verbose_name_plural = "院系"
        ordering = ["name"]

    def __str__(self):
        return self.name


class StudentProfile(models.Model):
    """学生党员发展档案，注册时自动创建。"""

    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name="profile",
        verbose_name="登录账号",
    )
    name = models.CharField("姓名", max_length=50)
    student_no = models.CharField("学号", max_length=30, unique=True)
    department = models.ForeignKey(
        Department,
        on_delete=models.PROTECT,
        related_name="students",
        verbose_name="院系",
    )
    major = models.CharField("专业", max_length=100, blank=True)
    grade = models.CharField("年级", max_length=20, blank=True)
    phone = models.CharField("联系电话", max_length=20, blank=True)
    # 当前阶段/节点以 slug 引用流程图（Neo4j / flow 应用共用同一套 slug）
    current_stage_slug = models.CharField("当前阶段标识", max_length=50, blank=True)
    current_node_slug = models.CharField("当前节点标识", max_length=80, blank=True)
    applied_at = models.DateField("申请入党日期", null=True, blank=True)
    node_entered_at = models.DateField("进入当前节点日期", null=True, blank=True)
    is_graduate = models.BooleanField("是否毕业生", default=False)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    class Meta:
        verbose_name = "学生档案"
        verbose_name_plural = "学生档案"
        ordering = ["student_no"]

    def __str__(self):
        return f"{self.name}（{self.student_no}）"

    @property
    def material_completion_rate(self):
        """材料完成率（只读统计，辅导员工作台用）。"""
        records = self.material_records.all()
        total = records.count()
        if total == 0:
            return 0.0
        done = records.exclude(status="未交").count()
        return round(done * 100 / total, 1)


class Counselor(models.Model):
    """辅导员（非学生账号），关联院系用于后台权限过滤。"""

    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name="counselor",
        verbose_name="登录账号",
    )
    department = models.ForeignKey(
        Department,
        on_delete=models.CASCADE,
        related_name="counselors",
        verbose_name="所属院系",
    )

    class Meta:
        verbose_name = "辅导员"
        verbose_name_plural = "辅导员"

    def __str__(self):
        return f"{self.user.get_full_name() or self.user.username}（{self.department}）"
