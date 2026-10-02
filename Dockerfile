# Cloudflare Sandbox image: a control server on :3000 that @cloudflare/sandbox
# drives. Keep the tag on the same release line as the npm package.
FROM docker.io/cloudflare/sandbox:0.12.9
EXPOSE 3000
