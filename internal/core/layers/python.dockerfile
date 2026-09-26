RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python3-dev libpq-dev default-libmysqlclient-dev \
    && rm -rf /var/lib/apt/lists/*
RUN ln -sf /usr/bin/python3 /usr/local/bin/python && ln -sf /usr/bin/pip3 /usr/local/bin/pip
RUN pip config set global.break-system-packages true || true
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
