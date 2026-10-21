import { loadDeliveryDraft } from "@/lib/delivery-draft-server";
import { requireAdminUser } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";
import TriggerDeliveryEditorClient from "./trigger-delivery-editor-client";

type GiftTemplateUrlRow = {
  imageUrl: string;
};
type GiftRow = {
  id: string;
  title: string;
  imageUrl: string;
  usageGuide: string;
};

function toPreviewImageUrl(imageUrl: string) {
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    return imageUrl;
  }
  return `/api/admin/blob?pathname=${encodeURIComponent(imageUrl)}`;
}

function resolveLineImageUrl(imageUrl: string, absoluteTemplateUrls: string[]) {
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    return imageUrl;
  }
  const normalized = imageUrl.replace(/^\/+/, "");
  const candidates = [normalized];
  if (normalized.endsWith(".svg")) {
    candidates.push(normalized.replace(/\.svg$/i, ".png"));
  }
  const matched = absoluteTemplateUrls.find((url) =>
    candidates.some((candidate) => url.endsWith(`/${candidate}`) || url.endsWith(candidate)),
  );
  return matched ?? null;
}

export default async function AdminTriggerDeliveryNewPage({ searchParams }: { searchParams: Promise<{ draft?: string | string[] }> }) {
  const adminUser = await requireAdminUser();
  const draft = await loadDeliveryDraft((await searchParams).draft, adminUser, "TRIGGER");
  const [gifts, templates, ranks] = await Promise.all([
    prisma.gift.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        imageUrl: true,
        usageGuide: true,
      },
      take: 200,
    }),
    prisma.giftImageTemplate.findMany({
      where: { isActive: true },
      select: {
        imageUrl: true,
      },
      take: 100,
    }),
    prisma.rank.findMany({
      orderBy: { minPoints: "asc" },
      select: {
        id: true,
        name: true,
      },
      take: 50,
    }),
  ]);
  const absoluteTemplateUrls = (templates as GiftTemplateUrlRow[])
    .map((row: GiftTemplateUrlRow) => row.imageUrl)
    .filter((url: string) => url.startsWith("http://") || url.startsWith("https://"));
  const normalizedGifts = (gifts as GiftRow[]).map((gift: GiftRow) => ({
    ...gift,
    previewImageUrl: toPreviewImageUrl(gift.imageUrl),
    lineImageUrl: resolveLineImageUrl(gift.imageUrl, absoluteTemplateUrls),
  }));

  return <TriggerDeliveryEditorClient key={draft?.id ?? "new"} draft={draft} gifts={normalizedGifts} rankOptions={ranks} />;
}
