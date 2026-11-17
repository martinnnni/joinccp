"""账号表单。"""
from django import forms
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.models import User

from .models import Department, StudentProfile


class StudentRegistrationForm(UserCreationForm):
    """学生注册表单：Django 用户 + 学生档案字段。"""

    name = forms.CharField(label="姓名", max_length=50)
    student_no = forms.CharField(label="学号", max_length=30)
    department = forms.ModelChoiceField(label="院系", queryset=Department.objects.all())
    major = forms.CharField(label="专业", max_length=100, required=False)
    grade = forms.CharField(label="年级", max_length=20, required=False)
    phone = forms.CharField(label="联系电话", max_length=20, required=False)
    applied_at = forms.DateField(
        label="申请入党日期", required=False,
        widget=forms.DateInput(attrs={"type": "date"}),
    )

    class Meta:
        model = User
        fields = ("username", "password1", "password2")

    def clean_student_no(self):
        student_no = self.cleaned_data["student_no"]
        if StudentProfile.objects.filter(student_no=student_no).exists():
            raise forms.ValidationError("该学号已注册。")
        return student_no
