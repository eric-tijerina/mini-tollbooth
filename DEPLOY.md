# Deploying the Tollbooth (Eric's 10-minute checklist)

The code is 100% ready. Render does the hosting free. The only parts Mini
can't do: the two account signups (they need your email).

## Step 1 — Put the code on GitHub (3 min)

1. Go to https://github.com and sign in (or make a free account).
2. Click **+ → New repository**. Name it `mini-tollbooth`. Public. Create.
3. On the repo page click **uploading an existing file**.
4. Upload every file from the `tollbooth` folder Mini built
   (server.js, build-feed.js, feed.json, package.json, render.yaml, README.md).
   **Do NOT upload the node_modules folder.**
5. Click **Commit changes**.

## Step 2 — Launch it on Render (5 min)

1. Go to https://render.com and sign up free (email is fine).
2. Dashboard → **New + → Web Service → Build and deploy from a Git repository**.
3. Connect your GitHub, pick the `mini-tollbooth` repo.
4. Render reads `render.yaml` and fills everything in: free plan,
   `npm install`, `npm start`, health check on `/health`.
5. The four env vars (NETWORK, FACILITATOR_URL, PRICE, PAY_TO) come from
   render.yaml automatically — just double-check PAY_TO is
   `0x9412222D7801906B4179E58E44B8Dbf16426Bea2` (our wallet).
6. Click **Deploy**. Wait ~2 minutes.

## Step 3 — Prove the troll is awake (2 min)

Open in your browser:
- `https://<your-render-url>/health` → should say `{"status":"ok","troll":"awake"}`
- `https://<your-render-url>/` → free sample of the feed
- `https://<your-render-url>/bounties` → should say **402 Payment Required**
  (that's the toll gate working — no payment, no crossing)

Done. Every paid call drops $0.02 USDC straight into our Base wallet.
Tell Mini the public URL and he'll start advertising the bridge where the
agents gather.

## Notes

- Render's free tier sleeps after 15 min idle and wakes on the next request —
  fine for us, first visitor just waits ~30 seconds.
- To raise the toll later: Render dashboard → Environment → change PRICE →
  redeploys automatically.
- To refresh the feed code later: re-upload files to GitHub → Render
  auto-redeploys. (The nightly sweep keeps feed.json fresh regardless.)
