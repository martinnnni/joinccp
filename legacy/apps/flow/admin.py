"""材料与节点管家后台。"""
from django.contrib import admin

from .models import FlowNode, MaterialRecord, MaterialTemplate, Notification, Stage


@admin.register(Stage)
class StageAdmin(admin.ModelAdmin):
    list_display = ("order", "slug", "name")
    ordering = ("order",)


@admin.register(FlowNode)
class FlowNodeAdmin(admin.ModelAdmin):
    list_display = ("order", "slug", "name", "stage", "duration_rule", "duration_days", "remind_days_before")
    list_filter = ("stage",)
    search_fields = ("name", "slug")


@admin.register(MaterialTemplate)
class MaterialTemplateAdmin(admin.ModelAdmin):
    list_display = ("name", "stage", "node", "category", "fill_method", "required")
    list_filter = ("stage", "category", "fill_method", "required")
    search_fields = ("name", "slug")


@admin.register(MaterialRecord)
class MaterialRecordAdmin(admin.ModelAdmin):
    list_display = ("student", "material", "status", "submitted_at")
    list_filter = ("status", "material__stage")
    search_fields = ("student__name", "student__student_no", "material__name")


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ("title", "student", "kind", "node", "is_read", "email_sent", "created_at")
    list_filter = ("kind", "is_read")
    search_fields = ("student__name", "title")
