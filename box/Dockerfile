# The box: one polyglot image every run starts from.
#
#   Node 22 (npm, pnpm and yarn via corepack), Bun
#   Python 3.11 with an always-active venv at /opt/venv, pip and uv (uv can install other Pythons)
#   mise for anything else on demand: Go, Rust, Ruby, Java, Deno, PHP, Elixir…
#   build-essential, git, curl, socat (the preview relay), ripgrep, jq, sqlite3
#
# pyrovue-run builds it on first use, or build it yourself with `npm run box:build`.
ARG BASE_IMAGE=node:22-bookworm
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

# Extra CA certificates, for networks behind a TLS-intercepting proxy: drop *.crt files into box/certs/.
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3-venv python3-pip python3-dev \
      socat ripgrep jq procps psmisc lsof less nano vim-tiny tree bash-completion \
      unzip zip xz-utils sqlite3 pkg-config ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    UV_NATIVE_TLS=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    MISE_DATA_DIR=/opt/mise \
    MISE_YES=1 \
    MISE_TRUSTED_CONFIG_PATHS=/workspace \
    VIRTUAL_ENV=/opt/venv

# JavaScript: current corepack (pnpm and yarn shims) and Bun.
RUN npm install -g corepack@latest \
 && corepack enable \
 && corepack prepare pnpm@latest --activate \
 && corepack prepare yarn@1 --activate \
 && pnpm --version && yarn --version \
 && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
 && bun --version

# Python: a venv that is always on PATH, so `pip install` just works, plus uv.
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -U pip setuptools wheel \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
 && uv --version

# Everything else, on demand: `mise use -g go@1.23` and so on. The runner's repairs use it when a repo needs a
# runtime the image doesn't have.
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh \
 && mise --version

ENV PATH=/opt/venv/bin:/opt/mise/shims:$PATH

# A friendly shell for `pyrovue-run --shell`, and a vimrc that makes vim.tiny usable.
COPY bashrc /etc/pyrovue/bashrc
RUN printf '%s\n' '. /etc/pyrovue/bashrc' >> /root/.bashrc
COPY vimrc /root/.vimrc
RUN update-alternatives --install /usr/bin/vim vim /usr/bin/vim.tiny 15

RUN git config --system --add safe.directory '*' \
 && git config --system advice.detachedHead false \
 && git config --system init.defaultBranch main \
 && mkdir -p /workspace /var/pyro

WORKDIR /workspace
CMD ["sleep", "infinity"]
