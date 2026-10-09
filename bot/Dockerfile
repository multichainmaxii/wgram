# Refill bot for the wGRAM/SOL pool (launchpad/scripts/refill-bot.ts), as run on Railway.
# Build from the repo root: docker build -f bot/Dockerfile .
# bridge-cli (Omni Bridge), for bridge-out.sh's Solana -> NEAR leg. Same commit as the
# scripts were written against.
FROM rust:1.96-bookworm AS bridge-cli
RUN apt-get update && apt-get install -y --no-install-recommends libudev-dev pkg-config libssl-dev clang \
 && rm -rf /var/lib/apt/lists/*
RUN cargo install --locked --git https://github.com/Near-One/bridge-sdk-rs --rev d1361ac1 bridge-cli

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 bzip2 xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Solana CLI (solana, solana-keygen) from Anza's official installer.
RUN sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
# near-cli-rs, the version the scripts were written against.
RUN curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/download/v0.30.1/near-cli-rs-installer.sh | sh
ENV PATH="/root/.local/share/solana/install/active_release/bin:/root/.cargo/bin:${PATH}"

RUN corepack enable
WORKDIR /app/launchpad
COPY launchpad/package.json launchpad/pnpm-lock.yaml launchpad/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY launchpad/scripts ./scripts
COPY launchpad/tsconfig.json ./
COPY --from=bridge-cli /usr/local/cargo/bin/bridge-cli /usr/local/bin/bridge-cli
COPY contracts/scripts/bridge-in.sh contracts/scripts/bridge-out.sh /app/contracts/scripts/
COPY bot/start.sh /app/bot/start.sh

ENV BRIDGE_IN_STATE=/data/.bridge-in-state BRIDGE_OUT_STATE=/data/.bridge-out-state
CMD ["bash", "/app/bot/start.sh"]
