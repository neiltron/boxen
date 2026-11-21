# Running on macOS

`install.sh` targets Linux servers. On a Mac, run boxen from a checkout with the development scripts (`start.sh`, `deploy.sh`, `stop.sh`). These steps are for Apple Silicon; [development.md](development.md) covers the same pieces in more detail.

```sh
# 1. Tools: Node 24 (pinned 24.5.0), pnpm, Docker via OrbStack, gh.
#    Any pnpm 10+ works: in the repo it switches itself to the pinned 12.9.1.
#    Don't use corepack; it fails on pnpm 12 ("Cannot find module .../bin/pnpm.cjs").
brew install nvm pnpm orbstack gh
nvm install 24.5.0 && nvm use 24.5.0
orbctl start

# 2. The pinned celld and local S3 storage (RustFS) in ~/.local/bin
mkdir -p ~/.local/bin
curl -fsSL https://github.com/denoland/celld/releases/download/v0.6.2/celld-aarch64-apple-darwin.gz \
  | gunzip > ~/.local/bin/celld-0.6.2
chmod +x ~/.local/bin/celld-0.6.2
curl -fsSLo /tmp/rustfs.zip https://github.com/rustfs/rustfs/releases/download/1.0.6/rustfs-macos-aarch64-v1.0.6.zip
unzip -o /tmp/rustfs.zip -d ~/.local/bin && chmod +x ~/.local/bin/rustfs
export PATH="$HOME/.local/bin:$PATH"     # add this line to ~/.zshrc too

# 3. The code, and a GitHub token for sandboxes and the inbox
git clone https://github.com/neiltron/boxen.git
cd boxen
pnpm install
gh auth login
echo "GH_TOKEN=$(gh auth token)" > .env

# 4. Run
./start.sh          # RustFS on :9000, celld on :8093
pnpm run deploy     # first deploy of the worker and Sandbox image (not `pnpm deploy`)
./start.sh          # again, so the deployed worker receives GH_TOKEN from .env
pnpm ui             # http://localhost:5176
```

Then open **Providers** at the bottom of the sidebar and add a model API key or sign in.

To work GitHub issues from the [inbox](../apps/inbox/README.md) alongside the main UI:

```sh
pnpm inbox          # http://localhost:5177/?repos=owner/name&label=ready-for-agent
```

## Day to day

- `./start.sh` after a reboot. celld runs under a restart loop with `caffeinate -i`, so idle sleep is held off, but closing the lid still sleeps the Mac.
- `./deploy.sh` after editing `apps/worker/src/`. Running nodes pick up the new version within about 15 seconds.
- `./stop.sh` stops celld; `./stop.sh rustfs` stops storage too.
- Logs are in `.celld.log` and `../.rustfs.log`.

## Notes

- **Docker:** OrbStack, Colima and Docker Desktop all work, as long as `docker info` succeeds.
- **Storage:** to use Cloudflare R2 or AWS S3 instead of RustFS, set `BOXEN_S3_BUCKET`, `BOXEN_S3_ENDPOINT` and credentials in `.env` and skip the RustFS download. See [Using Cloudflare R2 or AWS S3](development.md#using-cloudflare-r2-or-aws-s3-in-local-development).
- **Intel Macs:** celld 0.6.2 has no `x86_64-apple-darwin` build.
