RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://go.dev/dl/go1.22.5.linux-${arch}.tar.gz" -o /tmp/go.tgz \
    && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz
ENV PATH=/usr/local/go/bin:/root/go/bin:$PATH
