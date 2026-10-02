# Cloudflare Sandbox image: a control server on :3000 that @cloudflare/sandbox
# drives. Keep the tag on the same release line as the npm package.
FROM docker.io/cloudflare/sandbox:0.12.9
RUN apt-get update \
  && apt-get install -y --no-install-recommends gh ripgrep python3 \
  && rm -rf /var/lib/apt/lists/*
EXPOSE 3000
