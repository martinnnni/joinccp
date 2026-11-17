"""账号与档案后台（辅导员工作台）。"""
from django.contrib import admin

from .models import Counselor, Department, StudentProfile


@admin.register(Department)
class DepartmentAdmin(admin.ModelAdmin):
    list_display = ("name",)
    search_fields = ("name",)


@admin.register(Counselor)
class CounselorAdmin(admin.ModelAdmin):
    list_display = ("user", "department")
    list_filter = ("department",)
    search_fields = ("user__username", "user__first_name")


@admin.register(StudentProfile)
class StudentProfileAdmin(admin.ModelAdmin):
    list_display = (
        "student_no", "name", "department", "major", "grade",
        "current_stage_slug", "current_node_slug", "material_completion_rate", "is_graduate",
    )
    list_filter = ("department", "is_graduate", "current_stage_slug")
    search_fields = ("name", "student_no", "major")
    readonly_fields = ("material_completion_rate", "created_at", "updated_at")
    actions = ["trigger_lesson_reminder"]

    def get_queryset(self, request):
        """辅导员组仅能查看本院系学生（重写过滤）。"""
        qs = super().get_queryset(request)
        if request.user.is_superuser:
            return qs
        if request.user.groups.filter(name="辅导员").exists():
            try:
                dept = request.user.counselor.department
                return qs.filter(department=dept)
            except Counselor.DoesNotExist:
                pass
        return qs

    @admin.action(description="触发党课提醒")
    def trigger_lesson_reminder(self, request, queryset):
        from apps.flow.models import Notification

        count = 0
        for student in queryset:
            Notification.objects.create(
                student=student,
                kind="lesson",
                title="党课提醒",
                content="请按时参加党课学习，并按支部安排完成相关任务。",
            )
            count += 1
        self.message_user(request, f"已为 {count} 名学生生成党课提醒。")
