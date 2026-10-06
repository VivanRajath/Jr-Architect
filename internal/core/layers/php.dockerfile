RUN apt-get update && apt-get install -y --no-install-recommends \
    php-cli php-mbstring php-xml php-curl php-zip unzip \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
