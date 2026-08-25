FROM node:22-bookworm-slim AS runtime

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

# The runtime image only needs production dependencies.  `tsx` is an explicit
# server dependency because the self-host entrypoint executes TypeScript
# sources; test runners, type declarations, and other dev tooling stay out.
RUN pnpm install --frozen-lockfile --prod

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin samurai \
  && chown -R samurai:samurai /app

COPY docker/self-host/entrypoint.sh /usr/local/bin/samurai-entrypoint
RUN chmod 0755 /usr/local/bin/samurai-entrypoint

ENV NODE_ENV=production
EXPOSE 4317

ENTRYPOINT ["/usr/local/bin/samurai-entrypoint"]
CMD ["pnpm", "--filter", "@samurai-agent/server", "run", "workspace-server"]
