# Deploying BillStack to the VPS

One command deploys any pushed branch. It is the **only** supported way to deploy; do not copy files by
hand, run `pm2 restart all`, `rsync --delete`, or restart MongoDB/nginx.

## Server layout (this VPS)

| Thing | Where |
|---|---|
| BillStack code (git checkout) | `/home/billstack/apps/toor-billstack` (owner `billstack`) |
| Frontend served by nginx from | `.../toor-billstack/frontend/dist` |
| API | systemd `billstack-preview-api` (+ `billstack-preview-worker`), runs `node src/server.js` |
| CRM (separate app, never touched) | `/home/crm/apps/the-office-on-rent` |

## One-time install (root)

```bash
curl -fsSL https://raw.githubusercontent.com/Nemnidhi/toor-billstack/claude/vigilant-bell-nkiiyc/scripts/deploy-vps.sh -o /usr/local/bin/deploy-billstack && chmod +x /usr/local/bin/deploy-billstack
```

## Every deploy (root)

```bash
deploy-billstack <branch>      # e.g. deploy-billstack main
```

What it does: checks out the branch in the BillStack folder as its owner, installs backend deps, builds the
frontend into `dist.new`, swaps it in only if the build worked, restarts only the BillStack API/worker,
checks health on the API's real port, and **rolls back automatically** if the health check fails. It ends by
printing (never applying) the duplicate-billing-company preview.

Undo by hand: `cd /home/billstack/apps/toor-billstack/frontend && mv dist dist.bad && mv dist.old dist`, then
`git checkout -B deploy-live <previous-sha>` and `systemctl restart billstack-preview-api`.

## Instructions for an AI assistant (Cowork / Claude)

1. Push your work to a GitHub branch.
2. Tell the user to run `deploy-billstack <that-branch>` as root on the server.
3. Never include your own deploy script, `pm2 restart all`, `systemctl restart` of anything except the two
   BillStack services, or edits to `/home/crm`.
4. Ask the user to paste the output; look for `Backend healthy on port ...` and `Deployed <sha>`.
