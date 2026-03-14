# Nexus Chat — Backend

Node.js + Fastify + Socket.IO API server for chatnexus.com

---

## Step-by-step setup (do this in order)

### 1. Supabase (database)

1. Go to https://supabase.com and create a free account
2. Click "New Project" — name it `nexus-chat`
3. Save the database password somewhere safe
4. Once the project is ready, click **SQL Editor** in the left sidebar
5. Paste the entire contents of `src/db/schema.sql` and click **Run**
6. Go to **Project Settings → API**
   - Copy the **Project URL** → this is your `SUPABASE_URL`
   - Copy the **service_role** key (not anon) → this is your `SUPABASE_SERVICE_KEY`

### 2. Upstash Redis (caching + presence)

1. Go to https://upstash.com and create a free account
2. Click **Create Database** → name it `nexus-chat` → pick the region closest to your users
3. After creation, go to the database page and copy the **Redis URL** (starts with `rediss://`)
   → this is your `REDIS_URL`

### 3. Cloudflare R2 (file uploads)

1. In your Cloudflare dashboard, go to **R2 Object Storage**
2. Click **Create Bucket** → name it `nexus-chat-uploads`
3. Go to **R2 → Manage R2 API Tokens** → Create Token with read/write access
   - Copy **Access Key ID** → `R2_ACCESS_KEY_ID`
   - Copy **Secret Access Key** → `R2_SECRET_ACCESS_KEY`
4. Your Account ID is in the top-right of the Cloudflare dashboard → `R2_ACCOUNT_ID`
5. Set up a custom domain for the bucket (e.g. uploads.chatnexus.com) → `R2_PUBLIC_URL`

### 4. Stripe (payments)

1. Go to https://stripe.com and create an account
2. In the dashboard, go to **Products** → Create a product called "Nexus Chat Pro"
3. Add a price: $9.99/month recurring
4. Copy the **Price ID** (starts with `price_`) → `STRIPE_PRO_PRICE_ID`
5. Go to **Developers → API Keys**
   - Copy the **Secret key** → `STRIPE_SECRET_KEY`
6. Go to **Developers → Webhooks** → Add endpoint
   - URL: `https://your-railway-url.railway.app/api/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`

### 5. Local development

```bash
# Clone and install
npm install

# Copy env file and fill in your values
cp .env.example .env
# Edit .env with all the values from steps 1-4

# Run in dev mode (auto-restarts on file changes)
npm run dev

# Test it's working
curl http://localhost:3001/health
# Should return: {"status":"ok","version":"1.0.0",...}
```

### 6. Deploy to Railway

1. Go to https://railway.app and create a free account
2. Click **New Project → Deploy from GitHub repo**
3. Connect your GitHub account and select your `nexus-chat` repo
4. Select the `backend` folder as the root
5. Railway will detect the Dockerfile automatically
6. Go to your service → **Variables** tab
7. Add every variable from your `.env` file (copy/paste each one)
   - Change `NODE_ENV` to `production`
   - Change `FRONTEND_URL` to `https://chatnexus.com`
8. Railway gives you a URL like `nexus-chat-backend.railway.app`
9. Test it: `curl https://nexus-chat-backend.railway.app/health`

### 7. Point your domain (optional at first)

In Cloudflare DNS, add a CNAME record:
- Name: `api`
- Target: `nexus-chat-backend.railway.app`

Then your API lives at `api.chatnexus.com`

---

## Environment variables reference

| Variable | Where to get it |
|---|---|
| `JWT_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `JWT_REFRESH_SECRET` | Same as above, run again for a different value |
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → service_role |
| `REDIS_URL` | Upstash → your database → Redis URL |
| `R2_ACCOUNT_ID` | Cloudflare dashboard top-right |
| `R2_ACCESS_KEY_ID` | Cloudflare → R2 → API Tokens |
| `R2_SECRET_ACCESS_KEY` | Same as above |
| `R2_BUCKET_NAME` | `nexus-chat-uploads` |
| `R2_PUBLIC_URL` | Your R2 custom domain |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API Keys |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks |
| `STRIPE_PRO_PRICE_ID` | Stripe → Products → your Pro plan price |
| `FRONTEND_URL` | `https://chatnexus.com` (or localhost for dev) |

---

## API endpoints

### Auth
- `POST /api/auth/register` — create account
- `POST /api/auth/login` — sign in, returns JWT
- `POST /api/auth/refresh` — get new access token
- `POST /api/auth/logout` — invalidate refresh token
- `GET  /api/auth/me` — get current user (requires JWT)

### Servers
- `GET    /api/servers` — list my servers
- `POST   /api/servers` — create server
- `GET    /api/servers/:id` — get server + channels + members
- `PATCH  /api/servers/:id` — update server
- `DELETE /api/servers/:id` — delete server
- `POST   /api/servers/join/:inviteCode` — join via invite
- `DELETE /api/servers/:id/leave` — leave server
- `GET    /api/servers/:id/members` — list members
- `DELETE /api/servers/:id/members/:userId` — kick member

### Channels
- `GET    /api/channels/server/:serverId` — list channels
- `POST   /api/channels` — create channel
- `PATCH  /api/channels/:id` — update channel
- `DELETE /api/channels/:id` — delete channel

### Messages
- `GET  /api/messages/channel/:channelId` — load messages (paginated, ?before=timestamp&limit=50)
- `GET  /api/messages/channel/:channelId/pinned` — pinned messages
- `GET  /api/messages/channel/:channelId/search?q=term` — search
- `PATCH /api/messages/:id/pin` — pin/unpin message

### Users
- `GET   /api/users/:id` — view profile
- `PATCH /api/users/me` — update my profile
- `POST  /api/users/me/change-password`
- `GET   /api/users/me/friends` — friend list
- `POST  /api/users/me/friends/:userId` — send friend request
- `PATCH /api/users/me/friends/:id/accept` — accept request
- `GET   /api/users/me/dms` — list DM conversations
- `POST  /api/users/me/dms/:userId` — open DM with user

### Uploads
- `POST /api/uploads` — upload any file (returns URL)
- `POST /api/uploads/avatar` — upload avatar

### Billing
- `GET  /api/billing/status` — get plan + features
- `POST /api/billing/checkout` — create Stripe checkout session
- `POST /api/billing/portal` — open Stripe customer portal
- `POST /api/billing/webhook` — Stripe webhook (Stripe calls this)

---

## WebSocket events (Socket.IO)

Connect with: `io('https://api.chatnexus.com', { auth: { token: 'your-jwt' } })`

### Client emits
- `channel:join` / `channel:leave` — join/leave a channel room
- `message:send` `{ channelId, content, replyToId, attachments }`
- `message:edit` `{ messageId, content }`
- `message:delete` `{ messageId }`
- `typing:start` / `typing:stop` `{ channelId }`
- `reaction:add` / `reaction:remove` `{ messageId, emoji }`
- `dm:join` `{ dmChannelId }`
- `dm:send` `{ dmChannelId, content }`
- `presence:update` `{ status }` — online/idle/dnd/invisible
- `voice:join` / `voice:leave` `{ channelId }`
- `voice:signal` `{ to, signal }` — WebRTC signaling

### Server emits
- `message:new` — new message in channel
- `message:edited` — message was edited
- `message:deleted` — message was deleted
- `typing:start` / `typing:stop` — someone typing
- `reaction:add` / `reaction:remove`
- `dm:message` — new DM
- `dm:notification` — DM when not in room
- `presence:update` — user status changed
- `server:created/updated/deleted`
- `server:member_joined/left`
- `channel:created/updated/deleted`
- `voice:user_joined/left`
- `voice:signal` — WebRTC
- `plan:upgraded/downgraded`
- `error` `{ message }`
