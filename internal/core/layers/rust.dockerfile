RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
ENV PATH=/root/.cargo/bin:$PATH
