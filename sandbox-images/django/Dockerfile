FROM docker.io/library/python:3.11-slim

WORKDIR /workspace

# The db headers let psycopg2/mysqlclient build when a repo pins the source dist.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    build-essential \
    libpq-dev \
    default-libmysqlclient-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Preinstalled so a repo with no requirements file still boots.
RUN pip install --no-cache-dir \
    "django>=4.2,<6" \
    psycopg2-binary \
    gunicorn \
    whitenoise \
    python-dotenv \
    djangorestframework

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

CMD ["bash"]
