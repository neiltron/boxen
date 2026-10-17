# Cloudflare Sandbox image: a control server on :3000 that @cloudflare/sandbox
# drives. Keep the tag on the same release line as the npm package.
FROM docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe
RUN apt-get update \
  && apt-get install -y --no-install-recommends gh ripgrep python3 \
  && rm -rf /var/lib/apt/lists/*
# On macOS celld only reaches container ports the image declares, so Preview
# can show these: common dev-server ports (Vite, Astro, Next on 3001, Python,
# wrangler, Jupyter, generic). Linux needs no EXPOSE for that.
EXPOSE 3000 3001 4000 4173 4321 5000 5173 5174 8000 8080 8787 8888
