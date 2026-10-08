# Refill bot for the wGRAM/SOL pool (launchpad/scripts/refill-bot.ts), as run on Railway.
# Build from the repo root: docker build -f bot/Dockerfile .
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
COPY contracts/scripts/bridge-in.sh /app/contracts/scripts/bridge-in.sh
COPY bot/start.sh /app/bot/start.sh

ENV BRIDGE_IN_STATE=/data/.bridge-in-state
CMD ["bash", "/app/bot/start.sh"]
