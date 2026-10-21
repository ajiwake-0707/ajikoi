# Ajikoi Digital Membership Card (LIFF Starter)

This project is a Next.js starter for a LIFF app.

## 1) Setup

Create your local env file:

```bash
cp .env.example .env.local
```

Then set your LIFF ID in `.env.local`:

```bash
NEXT_PUBLIC_LIFF_ID=YOUR_LIFF_ID_HERE
NEXT_PUBLIC_LINE_ADD_FRIEND_URL=https://lin.ee/xxxxxxxx
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ajikoi_local?schema=public"
DIRECT_URL="postgresql://postgres:postgres@localhost:5432/ajikoi_local?schema=public"
```

For production Supabase, point `DATABASE_URL`/`DIRECT_URL` to your Supabase Postgres URLs.

## 2) Run locally

```bash
npm install
npm run db:up
npm run prisma:migrate -- --name init_users
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

If needed, inspect local DB with:

```bash
npm run prisma:studio
```

## Local migration flow

When you change `prisma/schema.prisma`, run:

```bash
npm run prisma:migrate -- --name your_migration_name
```

`prisma migrate dev` automatically runs `prisma generate`, so an extra generate is usually not required.

If you only pulled latest migrations and want to refresh the client manually, run:

```bash
npm run prisma:generate
```

## 3) Deploy to Vercel

Deploy this project to Vercel and copy the production URL:

- Example: `https://ajikoi-digital-membership-card.vercel.app`

Set that URL (or a specific path like `/`) as the LIFF endpoint URL in LINE Developers.

## 4) LIFF settings checklist

- LIFF endpoint URL: `https://...` (HTTPS required)
- Scope: `openid` and `profile` are required for profile access
- Use the generated LIFF ID in `NEXT_PUBLIC_LIFF_ID`
- Set your OA add-friend URL in `NEXT_PUBLIC_LINE_ADD_FRIEND_URL` (e.g. `https://lin.ee/...`)

## 5) oRPC API

oRPC is configured at:

- `src/orpc/router.ts` (procedure definitions)
- `src/app/api/rpc/[...rest]/route.ts` (Next.js route handler)

Current sample procedures:

- `system.health`
- `system.greet`
- `user.upsertFromLiff` (upsert `userId` and `displayName` to `users` table)

## GitHub Actions (production migration)

Workflow file: `.github/workflows/prisma-migrate-deploy.yml`

Set these repository secrets before using it:

- `DATABASE_URL`
- `DIRECT_URL`

On push to `main` (when Prisma files changed), the workflow runs:

```bash
npx prisma migrate deploy
```

## LINE配信の下書き

スポット配信・トリガー配信の「下書き保存」で、入力途中の内容をDBに保存できます。
LINE配信一覧の「下書き」から「編集を再開」または「削除」を選択できます。
下書きは同じ公式アカウントの管理者間で共有されます。公式アカウント未設定の場合は作成者本人のみ参照できます。
既存トリガーの編集を下書き保存しても稼働中の設定は変わりません。
配信受付／トリガー設定保存が成功すると、使用した下書きを削除します。
画像を含む場合は保存時にアップロードするため、既存の画像アップロード用設定が必要です。

初回は `pnpm exec prisma migrate deploy` と `pnpm exec prisma generate` を実行し、開発サーバーを再起動してください。
ローカル専用の統合テスト（テスト用アカウントを作成して終了時に削除、LINE送信なし）:

```bash
node --env-file=.env scripts/test-delivery-drafts.mjs http://localhost:3001
```
