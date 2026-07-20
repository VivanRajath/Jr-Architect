FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Pre-install the builder-template node_modules into a cache location
# so each sandbox run can copy them in instead of downloading fresh
WORKDIR /opt/builder-deps

# Copy the builder template's package manifests
COPY package.json ./
COPY postcss.config.mjs ./
COPY tailwind.config.ts ./

# Install all deps (this is cached in the image layer)
RUN npm install --no-audit --no-fund

WORKDIR /workspace

EXPOSE 3000

CMD ["bash"]
