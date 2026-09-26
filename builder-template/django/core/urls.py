"""URLs for the core app. app_name namespaces them as core:<name>."""

from django.urls import path

from . import views

app_name = "core"

urlpatterns = [
    path("", views.index, name="index"),
    path("tasks/add/", views.add_task, name="add_task"),
    path("tasks/<int:pk>/toggle/", views.toggle_task, name="toggle_task"),
]
