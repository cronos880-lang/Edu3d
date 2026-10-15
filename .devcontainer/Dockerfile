FROM node:24-bookworm-slim AS node

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    XDG_CACHE_HOME=/home/vscode/.cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        curl \
        git \
        libgl1 \
        libglib2.0-0 \
        libglu1-mesa \
        libgomp1 \
        libsm6 \
        libxext6 \
        libxrender1 \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

# Use Node's official binary and npm without replacing Python's /usr/local files.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version \
    && npm --version \
    && python3 --version

RUN groupadd --gid 1000 vscode \
    && useradd --uid 1000 --gid vscode --create-home --shell /bin/bash vscode \
    && mkdir -p /home/vscode/.cache /workspaces \
    && chown -R vscode:vscode /home/vscode /workspaces

USER vscode
WORKDIR /workspaces
