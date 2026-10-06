"""Models for the core app. A change here needs a generated migration."""

from django.db import models


class Task(models.Model):
    title = models.CharField(max_length=200)
    done = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        # Newest first, and a stable tiebreak so pagination can't repeat a row.
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return self.title
