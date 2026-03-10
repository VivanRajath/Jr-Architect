FROM node:20-slim

WORKDIR /workspace

RUN apt-get update && apt-get install -y \
    git \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# expose common React dev ports
EXPOSE 3000
EXPOSE 5173

CMD ["bash"]