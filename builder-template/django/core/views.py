"""Views for the core app. Writes answer POST and redirect."""

from django.shortcuts import get_object_or_404, redirect, render

from .models import Task


def index(request):
    tasks = Task.objects.all()
    return render(
        request,
        "core/index.html",
        {
            "tasks": tasks,
            "remaining": tasks.filter(done=False).count(),
        },
    )


def add_task(request):
    if request.method != "POST":
        return redirect("core:index")
    title = request.POST.get("title", "").strip()
    if title:
        Task.objects.create(title=title)
    return redirect("core:index")


def toggle_task(request, pk):
    if request.method != "POST":
        return redirect("core:index")
    task = get_object_or_404(Task, pk=pk)
    task.done = not task.done
    # Write only the column that changed — cheaper, and it can't clobber a
    # concurrent edit to another field.
    task.save(update_fields=["done"])
    return redirect("core:index")
