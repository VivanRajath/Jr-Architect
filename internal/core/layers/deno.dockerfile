RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y
ENV DENO_INSTALL=/root/.deno
ENV PATH=/root/.deno/bin:$PATH
