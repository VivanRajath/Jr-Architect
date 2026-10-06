# Golden Django template

A minimal, idiomatic Django project. It runs as-is and exists to be copied: every
piece a feature needs appears exactly once, so there is an obvious pattern to
follow instead of a blank file.

## Run it

```
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver 0.0.0.0:8000
```

Jr Architect runs these for you and additionally generates
`jr_sandbox_settings.py` beside `manage.py`, which imports `config.settings` and
overrides `ALLOWED_HOSTS` and `DEBUG` so the containerised preview can reach the
app. That file is generated — edit `config/settings.py` instead.

## Layout

```
manage.py              entry point; names config.settings
config/                the project package (not an app)
  settings.py          one settings module, env-driven
  urls.py              mounts each app with include()
  wsgi.py / asgi.py    deployment entry points
core/                  an app — copy this shape for new ones
  models.py            Task: the worked example
  views.py             index / add_task / toggle_task
  urls.py              namespaced routes (app_name = "core")
  admin.py             registered so /admin/ is useful immediately
  migrations/          generated, committed, never hand-edited
  templates/core/      templates this app owns
templates/base.html    the shell every page extends
static/css/app.css     design tokens at the top, rules below
```

## Adding a feature

A URL is three edits that must agree:

1. a view in `core/views.py`
2. a route in `core/urls.py` with a `name=`
3. a template in `core/templates/core/` that extends `base.html`

Add a new app instead of growing `core` when the feature owns its own data:

```
python manage.py startapp billing
```

then add `"billing"` to `INSTALLED_APPS` and
`path("billing/", include("billing.urls"))` to `config/urls.py`.

## Conventions this template holds to

- Reverse URLs by name (`{% url 'core:index' %}`, `redirect("core:index")`) — never
  hard-code a path.
- Every POST form carries `{% csrf_token %}`.
- Anything that writes answers POST and then redirects, so refresh can't resubmit.
- Model changes come with a generated migration; migrations are never hand-written.
- Colors and spacing come from the CSS custom properties at the top of `app.css`.
