"""智能材料质检后台。"""
from django.contrib import admin

from .models import CheckResult, MaterialCheckRecord


class CheckResultInline(admin.TabularInline):
    model = CheckResult
    extra = 0
    readonly_fields = ("kind", "code", "message", "severity", "suggestion")


@admin.register(MaterialCheckRecord)
class MaterialCheckRecordAdmin(admin.ModelAdmin):
    list_display = ("material", "student", "checked_at")
    list_filter = ("material__stage",)
    search_fields = ("student__name", "material__name")
    inlines = [CheckResultInline]
