FROM mcr.microsoft.com/dotnet/sdk:8.0

WORKDIR /workspace

RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

CMD ["bash"]
